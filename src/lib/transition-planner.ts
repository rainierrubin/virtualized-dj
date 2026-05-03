/**
 * Transition planner — picks the best (cut_in_master, cut_in_cue) pair
 * given two TrackAnalysis objects and a budget window from "now".
 *
 * Heuristic: prefer cuts on a 16-bar phrase boundary in master (Mixxx
 * "Full Intro + Outro" mode). Fall back to 8-bar then 4-bar boundaries if
 * none lie within the budget. Cue starts at its intro-end downbeat (i.e.,
 * the first downbeat of its first "main" section).
 *
 * Compatibility scoring (used to tie-break candidate cuts) blends:
 *   - tempo distance (preferring same / 2x / 0.5x BPM)
 *   - energy delta at the cut (lower jolt is better)
 *   - phrase phase (16-bar boundaries score higher than 8-bar than 4-bar)
 */
import type { TrackAnalysis } from "./analysis-types";

export interface TransitionPlan {
  /** Wall-clock seconds to wait before triggering the cut. */
  waitSec: number;
  /** Time in master where the cut happens. */
  masterCutSec: number;
  /** Time in cue where the new master should start playing. */
  cueStartSec: number;
  /** Overall confidence/reasoning. */
  reason: string;
  /** Which bar phase the master cut lands on (16, 8, or 4). */
  phasePref: 16 | 8 | 4;
}

export interface PlanInput {
  master: TrackAnalysis;
  cue: TrackAnalysis;
  /** Current playback position in master, seconds. */
  masterCurrentSec: number;
  /** Maximum wait, seconds. */
  budgetSec: number;
}

export function planTransition(input: PlanInput): TransitionPlan | null {
  const { master, cue, masterCurrentSec, budgetSec } = input;

  // 1. Find candidate master cut points: every Nth downbeat after current
  //    position, within [now, now+budget].
  const candidates = collectCandidates(master, masterCurrentSec, budgetSec);
  if (candidates.length === 0) return null;

  // 2. Determine cue start.
  // Prefer the first downbeat of cue's first "main" or "drop" section.
  const cueStartIdx = pickCueStartDownbeat(cue);
  const cueStartSec = cue.downbeats[cueStartIdx] ?? 0;

  // 3. Score each candidate and return best.
  let best: { cand: Candidate; score: number } | null = null;
  for (const cand of candidates) {
    const score = scoreTransition(cand, master, cue, cueStartIdx);
    if (!best || score > best.score) best = { cand, score };
  }
  if (!best) return null;

  return {
    waitSec: Math.max(0, best.cand.timeSec - masterCurrentSec),
    masterCutSec: best.cand.timeSec,
    cueStartSec,
    reason: best.cand.reason,
    phasePref: best.cand.phase,
  };
}

interface Candidate {
  downbeatIndex: number;
  timeSec: number;
  phase: 16 | 8 | 4;
  reason: string;
}

function collectCandidates(
  master: TrackAnalysis,
  current: number,
  budget: number
): Candidate[] {
  const out: Candidate[] = [];
  const cutMin = current;
  const cutMax = current + budget;

  // Prefer outro start if it falls within window.
  const outroSec = master.downbeats[master.outroStartDownbeat];
  if (outroSec !== undefined && outroSec >= cutMin && outroSec <= cutMax) {
    out.push({
      downbeatIndex: master.outroStartDownbeat,
      timeSec: outroSec,
      phase: 16,
      reason: "outro start",
    });
  }

  // Walk downbeats, tag each with its largest phase divisor.
  for (let i = 0; i < master.downbeats.length; i++) {
    const t = master.downbeats[i];
    if (t < cutMin || t > cutMax) continue;
    let phase: 16 | 8 | 4 | 0 = 0;
    if (i % 16 === 0) phase = 16;
    else if (i % 8 === 0) phase = 8;
    else if (i % 4 === 0) phase = 4;
    if (phase === 0) continue;
    out.push({
      downbeatIndex: i,
      timeSec: t,
      phase,
      reason: `${phase}-bar boundary`,
    });
  }
  return out;
}

function pickCueStartDownbeat(cue: TrackAnalysis): number {
  // Prefer the first "main" or "drop" section's start downbeat.
  for (const s of cue.sections) {
    if (s.kind === "drop" || s.kind === "main") return s.startDownbeat;
  }
  // Fall back to introEndDownbeat (RMS-based heuristic).
  return cue.introEndDownbeat ?? 0;
}

function scoreTransition(
  cand: Candidate,
  master: TrackAnalysis,
  cue: TrackAnalysis,
  cueStartIdx: number
): number {
  // Phase score: 16 > 8 > 4
  const phaseScore = cand.phase === 16 ? 1.0 : cand.phase === 8 ? 0.6 : 0.3;

  // Outro bonus: cuts at/after master's detected outro start get a boost.
  const outroBonus = cand.downbeatIndex >= master.outroStartDownbeat ? 0.3 : 0;

  // Tempo distance (prefer same; allow 2x / 0.5x via log2).
  const ratio = Math.log2(master.bpm / Math.max(1, cue.bpm));
  const tempoPenalty = Math.min(0.5, Math.abs(ratio - Math.round(ratio)) * 2);

  // Energy delta at the cut: difference between bar RMS at master cut and
  // cue start (smaller is smoother).
  const mIdx = Math.min(cand.downbeatIndex, master.rmsBars.length - 1);
  const cIdx = Math.min(cueStartIdx, cue.rmsBars.length - 1);
  const mRms = master.rmsBars[mIdx] ?? 0;
  const cRms = cue.rmsBars[cIdx] ?? 0;
  const maxRms = Math.max(mRms, cRms, 1e-6);
  const energyDelta = Math.abs(mRms - cRms) / maxRms;
  const energyPenalty = Math.min(0.4, energyDelta * 0.5);

  return phaseScore + outroBonus - tempoPenalty - energyPenalty;
}
