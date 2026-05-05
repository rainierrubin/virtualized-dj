/**
 * Transition engine — chooses and executes a DJ-style crossover from
 * one master deck to the queued cue, scheduled directly on the
 * shared AudioContext.
 *
 * Available styles:
 *
 *   hard_cut          — instantaneous gain swap on a downbeat. The
 *                       right call for hip-hop / trap and any pair
 *                       with a high BPM mismatch where blending
 *                       would clash.
 *
 *   bass_swap         — equal-power gain crossfade with a low-shelf
 *                       EQ swap layered on top: outgoing bass kills
 *                       to -40 dB while incoming bass rises from
 *                       -40 dB to 0. Default for house / techno /
 *                       synthwave / lo-fi where two basslines
 *                       overlapping creates mud.
 *
 *   filter_sweep_cut  — outgoing low-pass sweeps from 22 kHz down
 *                       to 250 Hz over the duration, gain holds
 *                       until the very end then hard-cuts. Incoming
 *                       enters dry at the cut. Used when going
 *                       outro → drop, or between high-energy
 *                       sections, for the "tension build into a
 *                       hit" feel.
 *
 *   long_dissolve     — extended equal-power crossfade with no EQ
 *                       work. Lo-fi / ambient / cinematic genres
 *                       where rhythmic precision matters less than
 *                       the vibe staying continuous.
 *
 * Each executor schedules AudioParam ramps via `setValueAtTime` /
 * `linearRampToValueAtTime` / `exponentialRampToValueAtTime` and
 * resolves when the transition window ends. Ramps run on the audio
 * thread so they're glitch-free regardless of main-thread load.
 */
import type { TrackAnalysis } from "./analysis-types";
import type { DeckChainNodes, DualPipelineNodes } from "./deck-audio";

export type TransitionStyle =
  | { kind: "hard_cut"; reason: string }
  | { kind: "bass_swap"; durationSec: number; reason: string }
  | { kind: "filter_sweep_cut"; durationSec: number; reason: string }
  | { kind: "long_dissolve"; durationSec: number; reason: string };

export interface ChooseTransitionArgs {
  master: TrackAnalysis | null;
  cue: TrackAnalysis | null;
  /** What section of the cue we're starting at (in seconds). */
  cueStartSec: number;
  /** Master's BPM, used for bar-duration math when planning length. */
  bpmHint: number;
}

const DEFAULT_BARS = 8;

/**
 * Heuristic genre buckets for transition selection. Drawn from the
 * Tzanetakis-style audio features we already extract — not a learned
 * classifier, just hand-tuned thresholds. Auditable.
 */
type Bucket = "hip-hop" | "house-techno" | "ambient-lofi" | "pop-rock" | "default";

function inferBucket(a: TrackAnalysis | null): Bucket {
  if (!a) return "default";
  const bpm = a.bpm;
  const rmsAvg = mean(a.rmsBars);
  if (rmsAvg < 0.001) return "default";
  const rmsVar = stdev(a.rmsBars) / rmsAvg;
  const bassAvg = mean(a.bassBars);
  const bassRatio = bassAvg / rmsAvg;

  // Hip-hop / trap — short or no intro, dense sub-bass, halftime BPM
  // also handled. We err toward the hard-cut bucket whenever there's
  // a vocal-heavy short-intro pattern.
  if ((bpm >= 65 && bpm <= 105) || (bpm >= 130 && bpm <= 170)) {
    if (bassRatio > 0.5 && rmsVar > 0.4) return "hip-hop";
  }
  // House / techno / synthwave — flat energy, long intro + outro,
  // 4-on-floor vibe.
  if (bpm >= 115 && bpm <= 140 && rmsVar < 0.35) return "house-techno";
  // Ambient / lo-fi — low BPM confidence or sparse structure.
  if (bpm < 95 && rmsVar < 0.45 && bassRatio < 0.35) return "ambient-lofi";
  // Pop / rock — high verse/chorus contrast.
  if (rmsVar > 0.55) return "pop-rock";
  return "default";
}

export function chooseTransition(args: ChooseTransitionArgs): TransitionStyle {
  const { master, cue, cueStartSec, bpmHint } = args;
  const bpm = bpmHint > 0 ? bpmHint : master?.bpm ?? 120;
  const barSec = (60 / Math.max(60, Math.min(200, bpm))) * 4;

  // BPM mismatch screens out blends — without time-stretch, two
  // tracks at very different tempos clash badly.
  const bpmMaster = master?.bpm ?? bpm;
  const bpmCue = cue?.bpm ?? bpm;
  const bpmRatio =
    Math.max(bpmMaster, bpmCue) / Math.max(1, Math.min(bpmMaster, bpmCue));
  const bpmIncompatible = bpmRatio > 1.06; // >6% drift

  const masterBucket = inferBucket(master);
  const cueBucket = inferBucket(cue);

  // Cue starting on a drop downbeat? If so, build tension on
  // outgoing and hard-cut into the drop.
  const cueDropTimes = cue?.drops
    .map((d) => cue.downbeats[d])
    .filter((t) => typeof t === "number" && Number.isFinite(t)) as number[];
  const cueStartsAtDrop =
    !!cueDropTimes && cueDropTimes.some((t) => Math.abs(t - cueStartSec) < 1.5);

  // Genre-gated overrides.
  if (masterBucket === "hip-hop" || cueBucket === "hip-hop") {
    return { kind: "hard_cut", reason: `hip-hop bucket (${masterBucket}/${cueBucket})` };
  }

  if (bpmIncompatible) {
    return {
      kind: "hard_cut",
      reason: `bpm mismatch ${bpmMaster.toFixed(0)}→${bpmCue.toFixed(0)} (>6%)`,
    };
  }

  if (cueStartsAtDrop && masterBucket !== "ambient-lofi") {
    return {
      kind: "filter_sweep_cut",
      durationSec: 8 * barSec,
      reason: "cue starts at drop — sweep tension then cut",
    };
  }

  if (masterBucket === "ambient-lofi" && cueBucket === "ambient-lofi") {
    return {
      kind: "long_dissolve",
      durationSec: Math.max(12, 16 * barSec),
      reason: "ambient/lofi pair",
    };
  }

  // Default to bass-swap for everything else where blending makes
  // sense — house, techno, synthwave, neo-soul, R&B, pop with
  // similar tempos, etc.
  return {
    kind: "bass_swap",
    durationSec: DEFAULT_BARS * barSec,
    reason: `bass-swap blend (${masterBucket} → ${cueBucket})`,
  };
}

export interface ExecuteTransitionArgs {
  style: TransitionStyle;
  pipeline: DualPipelineNodes;
  fromChannel: "A" | "B";
  toChannel: "A" | "B";
}

export async function executeTransition(args: ExecuteTransitionArgs): Promise<void> {
  const { style, pipeline, fromChannel, toChannel } = args;
  const { ctx } = pipeline;
  const from = pipeline[fromChannel];
  const to = pipeline[toChannel];
  const now = ctx.currentTime;

  switch (style.kind) {
    case "hard_cut":
      return executeHardCut(ctx, now, from, to);
    case "bass_swap":
      return executeBassSwap(ctx, now, from, to, style.durationSec);
    case "filter_sweep_cut":
      return executeFilterSweepCut(ctx, now, from, to, style.durationSec);
    case "long_dissolve":
      return executeLongDissolve(ctx, now, from, to, style.durationSec);
  }
}

async function executeHardCut(
  ctx: AudioContext,
  now: number,
  from: DeckChainNodes,
  to: DeckChainNodes,
): Promise<void> {
  const ramp = 0.03; // 30 ms — imperceptible but click-free
  cancelAndAnchor(from.gain.gain, now);
  cancelAndAnchor(to.gain.gain, now);
  from.gain.gain.linearRampToValueAtTime(0, now + ramp);
  to.gain.gain.linearRampToValueAtTime(1, now + ramp);
  await sleep(ramp * 1000 + 50);
}

async function executeBassSwap(
  ctx: AudioContext,
  now: number,
  from: DeckChainNodes,
  to: DeckChainNodes,
  durationSec: number,
): Promise<void> {
  const end = now + durationSec;

  // Equal-power gain crossfade via setValueCurveAtTime — sin/cos
  // curves preserve constant perceived loudness across the
  // overlap (linear crossfades dip 3 dB at the midpoint).
  const STEPS = 64;
  const fromCurve = new Float32Array(STEPS);
  const toCurve = new Float32Array(STEPS);
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1);
    fromCurve[i] = Math.cos((t * Math.PI) / 2);
    toCurve[i] = Math.sin((t * Math.PI) / 2);
  }
  cancelAndAnchor(from.gain.gain, now);
  cancelAndAnchor(to.gain.gain, now);
  from.gain.gain.setValueCurveAtTime(fromCurve, now, durationSec);
  to.gain.gain.setValueCurveAtTime(toCurve, now, durationSec);

  // Bass swap: outgoing low-shelf goes 0 → -40 dB; incoming starts
  // pre-killed at -40 dB and rises to 0 over the same window.
  // Both shelves crossfaded together avoid the bass-clash mud.
  cancelAndAnchor(from.lowShelf.gain, now);
  cancelAndAnchor(to.lowShelf.gain, now);
  from.lowShelf.gain.setValueAtTime(from.lowShelf.gain.value || 0, now);
  to.lowShelf.gain.setValueAtTime(-40, now);
  // Front-load the bass kill on outgoing (faster than the gain
  // curve) so the incoming bass can take over cleanly without two
  // sub frequencies fighting in the middle of the blend.
  from.lowShelf.gain.linearRampToValueAtTime(-40, now + durationSec * 0.55);
  to.lowShelf.gain.linearRampToValueAtTime(0, now + durationSec * 0.55);

  await sleep(durationSec * 1000 + 50);
  // Restore low-shelves to neutral after the swap, leaving the new
  // master with normal bass response.
  cancelAndAnchor(from.lowShelf.gain, end);
  cancelAndAnchor(to.lowShelf.gain, end);
  from.lowShelf.gain.setValueAtTime(0, end);
  to.lowShelf.gain.setValueAtTime(0, end);
}

async function executeFilterSweepCut(
  ctx: AudioContext,
  now: number,
  from: DeckChainNodes,
  to: DeckChainNodes,
  durationSec: number,
): Promise<void> {
  // Outgoing LPF sweeps 22 kHz → 250 Hz exponentially. Gain holds
  // at full until the last 100 ms then snaps to zero. Incoming
  // enters dry at the cut. Reads as "build tension, hit drop."
  const cutAt = now + durationSec;
  cancelAndAnchor(from.lpf.frequency, now);
  from.lpf.frequency.setValueAtTime(22000, now);
  from.lpf.frequency.exponentialRampToValueAtTime(250, cutAt - 0.05);

  // Optional resonance bump for drama — light enough not to whistle.
  cancelAndAnchor(from.lpf.Q, now);
  from.lpf.Q.setValueAtTime(1, now);
  from.lpf.Q.linearRampToValueAtTime(4, cutAt - 0.05);

  cancelAndAnchor(from.gain.gain, now);
  cancelAndAnchor(to.gain.gain, now);
  from.gain.gain.setValueAtTime(from.gain.gain.value || 1, now);
  from.gain.gain.linearRampToValueAtTime(0, cutAt + 0.03);
  to.gain.gain.setValueAtTime(0, now);
  to.gain.gain.setValueAtTime(0, cutAt - 0.01);
  to.gain.gain.linearRampToValueAtTime(1, cutAt + 0.03);

  await sleep(durationSec * 1000 + 100);
  // Reset LPF for the next track that lands here.
  const after = ctx.currentTime;
  cancelAndAnchor(from.lpf.frequency, after);
  cancelAndAnchor(from.lpf.Q, after);
  from.lpf.frequency.setValueAtTime(22000, after);
  from.lpf.Q.setValueAtTime(1, after);
}

async function executeLongDissolve(
  ctx: AudioContext,
  now: number,
  from: DeckChainNodes,
  to: DeckChainNodes,
  durationSec: number,
): Promise<void> {
  // Pure equal-power crossfade, no EQ work. Best for genres where
  // rhythmic precision is secondary to vibe continuity.
  const STEPS = 96;
  const fromCurve = new Float32Array(STEPS);
  const toCurve = new Float32Array(STEPS);
  for (let i = 0; i < STEPS; i++) {
    const t = i / (STEPS - 1);
    fromCurve[i] = Math.cos((t * Math.PI) / 2);
    toCurve[i] = Math.sin((t * Math.PI) / 2);
  }
  cancelAndAnchor(from.gain.gain, now);
  cancelAndAnchor(to.gain.gain, now);
  from.gain.gain.setValueCurveAtTime(fromCurve, now, durationSec);
  to.gain.gain.setValueCurveAtTime(toCurve, now, durationSec);
  await sleep(durationSec * 1000 + 50);
}

function cancelAndAnchor(param: AudioParam, t: number) {
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mean(xs: number[] | null | undefined): number {
  if (!xs || xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs: number[] | null | undefined): number {
  if (!xs || xs.length === 0) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}
