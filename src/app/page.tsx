"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  isTerminal,
  TERMINAL_FAILURES,
  type SunoTaskStatus,
  type SunoVariant,
  type TaskRecord,
} from "@/lib/types";
import { formatSessionStart, formatTrackTitle } from "@/lib/session";
import {
  useAudioOutputDevices,
  type AudioOutputDevice,
} from "@/lib/audio-devices";
import { useDeckAudio, useMasterDualPipeline } from "@/lib/deck-audio";
import type { TrackAnalysis } from "@/lib/analysis-types";
import { analyzeAudioUrl } from "@/lib/audio-analysis";
import { planTransition } from "@/lib/transition-planner";
import {
  attachProgressiveStream,
  isMseAudioSupported,
} from "@/lib/progressive-stream";
import {
  chooseTransition,
  executeTransition,
} from "@/lib/transition-engine";

// ---------- pill option catalogues ----------
const GENRES = [
  "house",
  "techno",
  "trance",
  "drum & bass",
  "dubstep",
  "trap",
  "hip-hop",
  "r&b",
  "soul",
  "funk",
  "disco",
  "jazz",
  "ambient",
  "cinematic",
  "synthwave",
  "vaporwave",
  "lo-fi",
  "idm",
  "breakbeat",
  "garage",
  "dub",
  "reggaeton",
  "afrobeat",
  "industrial",
  "electronic",
  "downtempo",
  "future bass",
  "tech house",
  "deep house",
  "minimal",
] as const;

const STYLES = [
  "dark",
  "bright",
  "warm",
  "cold",
  "aggressive",
  "mellow",
  "melancholic",
  "uplifting",
  "hypnotic",
  "energetic",
  "chill",
  "frantic",
  "minimal",
  "maximal",
  "lush",
  "sparse",
  "dense",
  "dreamy",
  "gritty",
  "polished",
  "raw",
  "atmospheric",
  "driving",
  "floating",
  "cosmic",
  "tribal",
  "epic",
  "moody",
  "playful",
  "sinister",
] as const;

const ELEMENTS = [
  "sub bass",
  "808s",
  "pluck synths",
  "pad synths",
  "lead synths",
  "arpeggios",
  "vocal chops",
  "granular textures",
  "acoustic drums",
  "hi-hats",
  "reverb",
  "delay",
  "distortion",
  "filter sweeps",
  "saturated bass",
  "fm synthesis",
  "analog warmth",
  "strings",
  "piano",
  "bells",
  "guitar",
  "choir",
  "field recordings",
  "bitcrushed",
  "glitch elements",
  "wide stereo",
  "side-chain pumping",
  "reverse fx",
  "drone",
  "risers",
  "impacts",
  "tape saturation",
] as const;

const BPM_OPTIONS = [
  60, 70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 128, 130, 135, 140,
  145, 150, 160, 170, 174, 180,
] as const;

const DEFAULT_GENRES: string[] = ["cinematic", "electronic"];
const DEFAULT_STYLES: string[] = ["warm", "atmospheric"];
const DEFAULT_ELEMENTS: string[] = [
  "analog warmth",
  "granular textures",
  "sub bass",
  "wide stereo",
];
const DEFAULT_BPM = 100;

function buildStyleString(
  bpm: number,
  genres: string[],
  styles: string[],
  elements: string[],
  customPrompt: string
): string {
  const text = customPrompt.trim();
  const hasPills =
    genres.length > 0 || styles.length > 0 || elements.length > 0;

  // No pills selected → use ONLY the typed prompt (no BPM either, since
  // the user is overriding entirely).
  if (!hasPills && text) {
    return text;
  }

  const parts: string[] = [];
  if (genres.length) parts.push(...genres);
  if (styles.length) parts.push(...styles);
  parts.push(`${bpm} bpm`);
  if (elements.length) parts.push(...elements);
  if (text) parts.push(text);
  return parts.join(", ");
}

const INTRO_OPTIONS = [
  "sparse, atmospheric pads",
  "quiet ambient texture, no drums",
  "filtered low-end rumble, anticipation",
  "lone melodic motif, reverb-soaked",
  "percussion only, no melody",
  "cinematic strings, slow build",
  "distant vocal chops, processed",
  "arpeggiated synth, gentle entry",
  "field recording texture",
  "stripped beat, single hat pattern",
] as const;

const DROP_OPTIONS = [
  "full arrangement, driving rhythm",
  "sub-heavy bass, sparse top end",
  "dense layered synths, four-on-the-floor",
  "half-time groove, big lead synth",
  "distorted bass, pounding kicks",
  "polyrhythmic drums, complex texture",
  "wide stereo synths, anthemic energy",
  "minimal — kick, bass, single lead",
  "trap 808s and rapid hi-hats",
  "breakbeat, chopped drums, gritty",
] as const;

const OUTRO_OPTIONS = [
  "strip back to ambient texture",
  "fade drums, leave pad and reverb tail",
  "melodic motif returns, then silence",
  "abrupt cut to quiet",
  "filter sweep down to silence",
  "drum solo fade out",
  "extended reverb tail, slow decay",
  "callback to intro elements",
  "distorted glitch fragments",
  "tape stop / pitch-down ending",
] as const;

interface Structure {
  intro: string;
  drop: string;
  outro: string;
}

const DEFAULT_STRUCTURE: Structure = {
  intro: INTRO_OPTIONS[0],
  drop: DROP_OPTIONS[0],
  outro: OUTRO_OPTIONS[0],
};

function structureToPrompt(s: Structure): string {
  return [
    `[Intro] ${s.intro}`,
    `[Drop] ${s.drop}`,
    `[Outro] ${s.outro}`,
  ].join("\n");
}

interface DeckState {
  taskId: string;
  trackNumber: number;
  title: string;
  styleSummary: string;
  status: SunoTaskStatus;
  variants: SunoVariant[];
  activeVariantIndex: number;
  analysis?: TrackAnalysis;
}

function activeVariant(deck: DeckState | null): SunoVariant | null {
  if (!deck || deck.variants.length === 0) return null;
  const idx = Math.min(deck.activeVariantIndex, deck.variants.length - 1);
  return deck.variants[idx] ?? null;
}

/**
 * URL to use for live playback. During generation we MUST use kie.ai's
 * progressive streaming endpoint (`streamAudioUrl`) because the Suno CDN
 * URL doesn't have the file yet. Once the track has fully rendered, we
 * could swap to the persistent CDN URL — but src changes mid-playback
 * cause an audio reload gap, so we keep `streamAudioUrl` for continuity.
 */
function bestStreamUrl(v: SunoVariant | null): string | null {
  if (!v) return null;
  return v.streamAudioUrl ?? v.audioUrl ?? null;
}

/**
 * URL to use for the analysis worker — needs persistent, full-length,
 * Range-supported. Only present once the track reaches SUCCESS.
 */
function analysisUrl(v: SunoVariant | null): string | null {
  if (!v) return null;
  return v.audioUrl ?? v.sourceAudioUrl ?? v.sourceStreamAudioUrl ?? null;
}

type Role = "master" | "cue";

function proxyUrl(streamUrl: string | null | undefined): string | null {
  if (!streamUrl) return null;
  return `/api/audio/stream?url=${encodeURIComponent(streamUrl)}`;
}

export default function Page() {
  const [sessionStart] = useState(() => formatSessionStart(new Date()));
  const [nextTrack, setNextTrack] = useState(1);
  const [bpm, setBpm] = useState<number>(DEFAULT_BPM);
  const [genres, setGenres] = useState<string[]>(DEFAULT_GENRES);
  const [styleTags, setStyleTags] = useState<string[]>(DEFAULT_STYLES);
  const [elements, setElements] = useState<string[]>(DEFAULT_ELEMENTS);
  const [instrumental, setInstrumental] = useState<boolean>(false);
  const [customPrompt, setCustomPrompt] = useState<string>("");
  const [structure, setStructure] = useState<Structure>(DEFAULT_STRUCTURE);
  const [useTextStructure, setUseTextStructure] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [master, setMaster] = useState<DeckState | null>(null);
  const [cue, setCue] = useState<DeckState | null>(null);
  const [history, setHistory] = useState<DeckState[]>([]);

  // Two master audio elements (A and B). Active channel is audible via gain
  // node in the master AudioContext; shadow channel buffers the next track
  // silently. NEXT SONG just swaps which channel is audible — no reload.
  const audioARef = useRef<HTMLAudioElement | null>(null);
  const audioBRef = useRef<HTMLAudioElement | null>(null);
  const cueAudioRef = useRef<HTMLAudioElement | null>(null);
  const [masterChannel, setMasterChannel] = useState<"A" | "B">("A");

  const [masterDeviceId, setMasterDeviceId] = useState<string | null>(null);
  const [masterDeviceIdSecondary, setMasterDeviceIdSecondary] =
    useState<string | null>(null);
  const [cueDeviceId, setCueDeviceId] = useState<string | null>(null);
  const { state: deviceState, requestPermission } = useAudioOutputDevices();

  const masterPipeline = useMasterDualPipeline(
    audioARef,
    audioBRef,
    masterChannel,
    masterDeviceId,
    masterDeviceIdSecondary
  );
  const cuePipeline = useDeckAudio(cueAudioRef, cueDeviceId);

  // Per-element audio state. Master state is computed from the active channel.
  const [aPlaying, setAPlaying] = useState(false);
  const [aTime, setATime] = useState(0);
  const [aDuration, setADuration] = useState(0);
  const [bPlaying, setBPlaying] = useState(false);
  const [bTime, setBTime] = useState(0);
  const [bDuration, setBDuration] = useState(0);
  const [cuePlaying, setCuePlaying] = useState(false);
  const [cueTime, setCueTime] = useState(0);
  const [cueDuration, setCueDuration] = useState(0);


  const masterPlaying = masterChannel === "A" ? aPlaying : bPlaying;
  const masterTime = masterChannel === "A" ? aTime : bTime;
  const masterDuration = masterChannel === "A" ? aDuration : bDuration;

  function activeMasterAudio(): HTMLAudioElement | null {
    return masterChannel === "A" ? audioARef.current : audioBRef.current;
  }
  function shadowMasterAudio(): HTMLAudioElement | null {
    return masterChannel === "A" ? audioBRef.current : audioARef.current;
  }

  // Polling
  useEffect(() => runPolling(master, setMaster), [master?.taskId]);
  useEffect(() => runPolling(cue, setCue), [cue?.taskId]);

  // Background analysis: when a deck reaches SUCCESS and we have a stable
  // sourceAudioUrl, kick off the analysis worker. Cache by taskId+variant
  // so we don't re-analyse the same track.
  const analyzedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const tryAnalyze = (
      deck: DeckState | null,
      setDeck: (fn: (curr: DeckState | null) => DeckState | null) => void
    ) => {
      if (!deck || deck.analysis) return;
      if (deck.status !== "SUCCESS") return;
      const v = deck.variants[deck.activeVariantIndex] ?? deck.variants[0];
      if (!v) return;
      const url = analysisUrl(v);
      if (!url) return;
      const key = `${deck.taskId}:${deck.activeVariantIndex}`;
      if (analyzedKeysRef.current.has(key)) return;
      analyzedKeysRef.current.add(key);
      const proxied = `/api/audio/stream?url=${encodeURIComponent(url)}`;
      analyzeAudioUrl(proxied)
        .then((analysis) => {
          setDeck((curr) => {
            if (!curr || curr.taskId !== deck.taskId) return curr;
            return { ...curr, analysis };
          });
          console.log(
            `analysis done for ${deck.title}: bpm=${analysis.bpm.toFixed(
              1
            )} beats=${analysis.beats.length} downbeats=${
              analysis.downbeats.length
            } sections=${analysis.sections.length}`
          );
        })
        .catch((err) => {
          console.warn(`analysis failed for ${deck.title}:`, err);
          // Leave analysis undefined; planner will fall back to amplitude beats.
          analyzedKeysRef.current.delete(key); // permit retry if user toggles variant
        });
    };
    tryAnalyze(master, setMaster);
    tryAnalyze(cue, setCue);
  }, [
    master?.taskId,
    master?.activeVariantIndex,
    master?.status,
    cue?.taskId,
    cue?.activeVariantIndex,
    cue?.status,
  ]);

  const masterStream = bestStreamUrl(activeVariant(master));
  const cueStream = bestStreamUrl(activeVariant(cue));

  // Compute which URL each audio element should be loading. Active channel
  // gets the master URL, shadow channel gets the cue URL (so it pre-buffers
  // the next track while master is still playing the current one).
  const aUrl = masterChannel === "A" ? masterStream : cueStream;
  const bUrl = masterChannel === "A" ? cueStream : masterStream;
  const aProxied = proxyUrl(aUrl);
  const bProxied = proxyUrl(bUrl);
  const cueProxied = proxyUrl(cueStream);

  // Reset deck-level audio state when active stream URL changes
  useEffect(() => {
    setCuePlaying(false);
    setCueTime(0);
    setCueDuration(0);
  }, [cueStream]);

  // ── Progressive (MSE) playback ─────────────────────────────────
  //
  // We manage the audio element's source via Media Source Extensions
  // instead of binding `<audio src>` directly. The MSE module fetches
  // kie.ai's chunked stream, appends bytes to a SourceBuffer, polls
  // for SUCCESS when the chunked response closes early, and refetches
  // the remaining bytes to extend the buffer. Result: the audio
  // element never sees a premature `ended` and plays the full track
  // through, no reload glitch.
  //
  // For browsers that don't support MSE for `audio/mpeg` we fall back
  // to direct src binding.
  const masterRef = useRef(master);
  const cueRef = useRef(cue);
  const masterChannelRef = useRef(masterChannel);
  masterRef.current = master;
  cueRef.current = cue;
  masterChannelRef.current = masterChannel;

  const deckOnElement = useCallback(
    (el: HTMLAudioElement | null): "master" | "cue" | null => {
      if (!el) return null;
      const mc = masterChannelRef.current;
      if (el === audioARef.current) return mc === "A" ? "master" : "cue";
      if (el === audioBRef.current) return mc === "A" ? "cue" : "master";
      if (el === cueAudioRef.current) return "cue";
      return null;
    },
    [],
  );

  const isDeckComplete = useCallback(
    async (deckKind: "master" | "cue"): Promise<boolean> => {
      const deck = deckKind === "master" ? masterRef.current : cueRef.current;
      return !!deck && deck.status === "SUCCESS";
    },
    [],
  );

  function useProgressiveAttach(
    elRef: RefObject<HTMLAudioElement | null>,
    proxied: string | null,
    autoPlay: boolean,
  ) {
    const mse = isMseAudioSupported();
    useEffect(() => {
      const el = elRef.current;
      if (!el) return;
      if (!proxied) {
        try {
          el.removeAttribute("src");
          el.load();
        } catch {
          // ignore
        }
        return;
      }
      let handle: ReturnType<typeof attachProgressiveStream> | null = null;
      if (mse) {
        handle = attachProgressiveStream({
          url: proxied,
          audio: el,
          isComplete: async () => {
            const kind = deckOnElement(el);
            if (!kind) return false;
            return isDeckComplete(kind);
          },
        });
      } else {
        el.src = proxied;
      }
      if (autoPlay) {
        // Master deck audio: kick playback (silent on shadow channel
        // via gain=0; audible on active channel).
        masterPipeline.resume();
        el.play().catch(() => {});
      }
      return () => {
        handle?.destroy();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [proxied, autoPlay]);
  }

  useProgressiveAttach(audioARef, aProxied, true);
  useProgressiveAttach(audioBRef, bProxied, true);
  // Cue preview: bind src so the waveform / title populate when the
  // track loads, but DON'T auto-play. The auto-DJ effect runs the
  // handleNextSong crossfade once cue reaches SUCCESS, which seeks +
  // plays the shadow-channel master element. Letting the cue preview
  // also play would route audio out of the default sink, doubling the
  // audio with master.
  useProgressiveAttach(cueAudioRef, cueProxied, false);

  // Auto-DJ: as soon as the queued cue track is *streamable* (kie.ai
  // has published a streamAudioUrl, which happens at TEXT_SUCCESS
  // ~22s after submit), fire the immediate transition. We don't wait
  // for SUCCESS because that takes ~3 minutes and the user wants the
  // swap to happen the moment audio is available.
  const autoTransitionedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!cue || !master) return;
    const variant =
      cue.variants[cue.activeVariantIndex] ?? cue.variants[0] ?? null;
    if (!variant?.streamAudioUrl && !variant?.audioUrl) return;
    if (autoTransitionedRef.current.has(cue.taskId)) return;
    autoTransitionedRef.current.add(cue.taskId);
    Promise.resolve().then(() => {
      handleNextSong(true);
    });
  }, [cue, master]);

  function toggleIn(arr: string[], v: string): string[] {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  async function handleGenerate() {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const trackNumber = nextTrack;
    const title = formatTrackTitle(sessionStart, trackNumber);
    const text = customPrompt.trim();
    // In non-custom mode kie.ai uses `prompt` as a song description and
    // auto-generates style, lyrics, and title — gives unique lyrics on
    // every call instead of the same line repeating across tracks.
    const prompt = text ? `${text}, ${bpm} bpm` : `${bpm} bpm`;
    const style = prompt;
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          style,
          prompt,
          title,
          model: "V5_5",
          instrumental,
          customMode: false,
          styleWeight: 0.7,
          weirdnessConstraint: 0.3,
          audioWeight: 0.5,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "generate failed");

      const newDeck: DeckState = {
        taskId: data.taskId,
        trackNumber,
        title,
        styleSummary: style,
        status: "PENDING",
        variants: [],
        activeVariantIndex: 0,
      };
      if (!master) setMaster(newDeck);
      else setCue(newDeck);
      setNextTrack((n) => n + 1);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "submit failed");
    } finally {
      setSubmitting(false);
    }
  }

  function handleNext() {
    if (!cue) return;
    if (master) setHistory((h) => [...h, master]);
    setMaster(cue);
    setCue(null);
  }

  function handlePrev() {
    if (history.length === 0) return;
    const last = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setMaster(last);
  }

  function handlePause() {
    const a = activeMasterAudio();
    if (!a) return;
    masterPipeline.resume();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  function handleMasterSeek(t: number) {
    const a = activeMasterAudio();
    if (!a) return;
    if (Number.isFinite(a.duration) && t >= 0 && t <= a.duration) {
      a.currentTime = t;
    }
  }

  function handleCueSeek(t: number) {
    const a = cueAudioRef.current;
    if (!a) return;
    if (Number.isFinite(a.duration) && t >= 0 && t <= a.duration) {
      a.currentTime = t;
    }
  }

  function handleCueTogglePlay() {
    const a = cueAudioRef.current;
    if (!a) return;
    cuePipeline.resume();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  }

  function toggleCueVariant() {
    setCue((prev) => {
      if (!prev || prev.variants.length < 2) return prev;
      return {
        ...prev,
        activeVariantIndex:
          (prev.activeVariantIndex + 1) % prev.variants.length,
      };
    });
  }

  // ---------- seamless intelligent transition ----------
  // If both decks have a TrackAnalysis, use the planner: wait for the next
  // 16-bar (then 8, then 4) phrase boundary in master, then channel-swap
  // and seek the new master to cue's first "main" / "drop" downbeat.
  // Otherwise fall back to amplitude-only 4-beat counting.
  const [crossfading, setCrossfading] = useState(false);
  const MAX_BEAT_WAIT_MS = 10000;
  const TARGET_BEATS = 4;

  async function handleNextSong(immediate = false) {
    if (!cue || crossfading) return;
    const ma = activeMasterAudio();
    const sa = shadowMasterAudio();
    const ca = cueAudioRef.current;
    if (!sa) {
      handleNext();
      return;
    }
    setCrossfading(true);

    masterPipeline.resume();
    if (sa.paused && sa.src) {
      try {
        await sa.play();
      } catch {
        // ignore
      }
    }

    // Choose strategy: planner if both analyses available, else fallback.
    // When `immediate` is set (auto-DJ fires the moment the cue track
    // becomes streamable), skip the phrase wait and any planner-induced
    // delay — the user wants the swap to happen now, not at the next
    // bar boundary.
    let cueStartSec = ca && Number.isFinite(ca.currentTime) ? ca.currentTime : 0;
    if (!immediate) {
      if (master?.analysis && cue?.analysis && ma && !ma.paused) {
        const plan = planTransition({
          master: master.analysis,
          cue: cue.analysis,
          masterCurrentSec: ma.currentTime,
          budgetSec: MAX_BEAT_WAIT_MS / 1000,
        });
        if (plan) {
          console.log(
            `transition plan: wait=${plan.waitSec.toFixed(2)}s ` +
              `cut@${plan.masterCutSec.toFixed(2)}s (${plan.phasePref}-bar) ` +
              `cueStart=${plan.cueStartSec.toFixed(2)}s — ${plan.reason}`
          );
          cueStartSec = plan.cueStartSec;
          await new Promise<void>((r) => setTimeout(r, plan.waitSec * 1000));
        } else {
          console.log("no plan candidates — falling back to 4-beat detector");
          await waitForBeats(
            masterPipeline.analyserRef,
            TARGET_BEATS,
            MAX_BEAT_WAIT_MS
          );
        }
      } else if (ma && !ma.paused) {
        // No analysis yet — fall back.
        await waitForBeats(
          masterPipeline.analyserRef,
          TARGET_BEATS,
          MAX_BEAT_WAIT_MS
        );
      }
    }

    // Seek shadow to cue's chosen start point. Range-supported source URLs
    // make this reliable.
    if (sa && Number.isFinite(cueStartSec)) {
      try {
        sa.currentTime = cueStartSec;
      } catch {
        // ignore
      }
    }

    // Pick + run the genre/section-aware transition. The engine
    // schedules ramps on the per-deck gain / lowShelf / lpf nodes
    // directly so the swap is glitch-free regardless of the
    // main-thread frame rate.
    const nextChannel: "A" | "B" = masterChannel === "A" ? "B" : "A";
    const nodes = masterPipeline.nodes();
    const style = chooseTransition({
      master: master?.analysis ?? null,
      cue: cue?.analysis ?? null,
      cueStartSec,
      bpmHint: master?.analysis?.bpm ?? cue?.analysis?.bpm ?? 120,
    });
    console.log(`[transition] style=${style.kind} reason=${style.reason}`);
    if (nodes) {
      await executeTransition({
        style,
        pipeline: nodes,
        fromChannel: masterChannel,
        toChannel: nextChannel,
      });
    } else {
      // Pipeline not initialised — fall back to the legacy ramp.
      masterPipeline.setActiveChannel(nextChannel);
    }
    setMasterChannel(nextChannel);

    if (ca) {
      ca.pause();
      ca.currentTime = 0;
      ca.volume = 1;
    }
    if (ma) {
      ma.pause();
      ma.currentTime = 0;
    }

    setCrossfading(false);

    if (master) setHistory((h) => [...h, master]);
    setMaster(cue);
    setCue(null);
  }

  const showEnableBanner =
    deviceState.supported &&
    !deviceState.hasLabels &&
    deviceState.devices.length > 0;

  return (
    <main
      className="grid h-screen overflow-hidden gap-3 p-3"
      style={{
        gridTemplateRows:
          "auto 1fr clamp(80px,11vh,120px) clamp(260px,30vh,400px)",
      }}
    >
      {/* ---------- header ---------- */}
      <header className="flex items-center justify-between gap-4 px-2">
        <div className="flex items-baseline gap-3 shrink-0">
          <h1 className="lcd text-sm tracking-[0.2em] text-fg-dim">
            DJ SESSION
          </h1>
          <span className="lcd text-xs lcd-glow-ok">{sessionStart}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-fg-dim min-w-0">
          {!deviceState.supported && (
            <span className="text-red-400 normal-case">
              audio devices not supported in this browser
            </span>
          )}
          {showEnableBanner && (
            <button
              type="button"
              onClick={requestPermission}
              className="btn-enable-devices"
              title="Browser security requires audio permission to show device names. The mic itself is not used."
            >
              ▸ Enable device names
            </button>
          )}
          {deviceState.error && (
            <span className="text-red-400 normal-case">
              {deviceState.error}
            </span>
          )}
          {submitError && (
            <span className="text-red-400 normal-case">err: {submitError}</span>
          )}
        </div>
      </header>

      {/* ---------- decks row (cue panel is visual only — auto-DJ
           handles transition; user no longer interacts with it) ---------- */}
      <div className="grid grid-cols-[1fr_minmax(200px,15%)_1fr] gap-3 min-h-0">
        <Deck
          role="master"
          deck={master}
          playing={masterPlaying}
          currentTime={masterTime}
          duration={masterDuration}
          onTogglePlay={handlePause}
          onSeek={handleMasterSeek}
          pipelineError={masterPipeline.error}
          onToggleVariant={undefined}
        />

        <MixerColumn
          devices={deviceState.devices}
          masterDeviceId={masterDeviceId}
          masterDeviceIdSecondary={masterDeviceIdSecondary}
          onMasterDeviceChange={setMasterDeviceId}
          onMasterDeviceSecondaryChange={setMasterDeviceIdSecondary}
          masterPlaying={masterPlaying}
          hasPrev={history.length > 0}
          hasNext={!!cue}
          onPrev={handlePrev}
          onPause={handlePause}
          onNext={handleNext}
          crossfading={crossfading}
        />

        <Deck
          role="cue"
          deck={cue}
          playing={cuePlaying}
          currentTime={cueTime}
          duration={cueDuration}
          onTogglePlay={handleCueTogglePlay}
          onSeek={handleCueSeek}
          pipelineError={cuePipeline.error}
          onToggleVariant={toggleCueVariant}
        />
      </div>

      {/* ---------- session timeline (full-width waveform, BELOW decks) ---------- */}
      <SessionTimeline
        masterAnalyserRef={masterPipeline.analyserRef}
        cueAnalyserRef={cuePipeline.analyserRef}
        masterPlaying={masterPlaying}
        cuePlaying={cuePlaying}
        masterTitle={master?.title ?? null}
        cueTitle={cue?.title ?? null}
      />

      {/* ---------- generate strip ---------- */}
      <section className="generate-strip !flex-col !items-center !justify-center gap-3">
        <textarea
          className="prompt-textarea"
          style={{ maxWidth: 440, resize: "none" }}
          rows={2}
          value={customPrompt}
          onChange={(e) => setCustomPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter alone submits; Shift+Enter still inserts a newline.
            if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              if (!submitting && customPrompt.trim().length > 0) {
                handleGenerate();
              }
            }
          }}
          placeholder="describe the track — e.g. lo-fi chill beat, mellow piano"
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setInstrumental((v) => !v)}
            aria-pressed={instrumental}
            title={
              instrumental
                ? "instrumental on — Suno will skip vocals"
                : "instrumental off — Suno may include vocals"
            }
            className={
              "shrink-0 px-3 py-1.5 text-[11px] leading-none rounded-md border whitespace-nowrap cursor-pointer select-none transition-colors " +
              (instrumental
                ? "border-orange-400 bg-orange-400/10 text-orange-400 shadow-[0_0_8px_rgba(255,106,61,0.25)]"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100")
            }
          >
            instrumental
          </button>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-zinc-500">
              BPM
            </span>
            <select
              className="dj-select bpm-select"
              value={bpm}
              onChange={(e) => setBpm(parseInt(e.target.value, 10))}
            >
              {BPM_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={submitting || customPrompt.trim().length === 0}
          className="btn-generate"
        >
          {submitting ? "…" : "▶ GENERATE"}
        </button>
      </section>

      {/* ---------- always-mounted hidden audio elements ----------
          Two master elements (A + B) sharing the master AudioContext via
          gain nodes; audible channel is selected by masterChannel state.
          Cue element on its own pipeline → cue sink for headphone preview. */}
      <audio
        ref={audioARef}
        preload="auto"
        crossOrigin="anonymous"
        className="audio-hidden"
        onPlay={() => {
          setAPlaying(true);
          masterPipeline.resume();
        }}
        onPause={() => setAPlaying(false)}
        onEnded={() => setAPlaying(false)}
        onTimeUpdate={(e) => setATime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setADuration(e.currentTarget.duration)}
        onDurationChange={(e) => setADuration(e.currentTarget.duration)}
      />
      <audio
        ref={audioBRef}
        preload="auto"
        crossOrigin="anonymous"
        className="audio-hidden"
        onPlay={() => {
          setBPlaying(true);
          masterPipeline.resume();
        }}
        onPause={() => setBPlaying(false)}
        onEnded={() => setBPlaying(false)}
        onTimeUpdate={(e) => setBTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setBDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setBDuration(e.currentTarget.duration)}
      />
      <audio
        ref={cueAudioRef}
        preload="auto"
        crossOrigin="anonymous"
        className="audio-hidden"
        onPlay={() => {
          setCuePlaying(true);
          cuePipeline.resume();
        }}
        onPause={() => setCuePlaying(false)}
        onEnded={() => setCuePlaying(false)}
        onTimeUpdate={(e) => setCueTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setCueDuration(e.currentTarget.duration)}
        onDurationChange={(e) => setCueDuration(e.currentTarget.duration)}
      />
    </main>
  );
}

// =====================================================================
// Polling
// =====================================================================
function runPolling(
  deck: DeckState | null,
  setDeck: (fn: (curr: DeckState | null) => DeckState | null) => void
): (() => void) | undefined {
  if (!deck || isTerminal(deck.status)) return;
  const taskId = deck.taskId;
  let cancelled = false;

  (async () => {
    while (!cancelled) {
      try {
        const res = await fetch(
          `/api/status?taskId=${encodeURIComponent(taskId)}`,
          { cache: "no-store" }
        );
        if (cancelled) return;
        if (res.ok) {
          const record = (await res.json()) as TaskRecord;
          let stop = false;
          setDeck((curr) => {
            if (!curr || curr.taskId !== taskId) {
              stop = true;
              return curr;
            }
            return {
              ...curr,
              status: record.status,
              variants: record.variants.length
                ? record.variants
                : curr.variants,
            };
          });
          if (stop) return;
          if (isTerminal(record.status)) return;
        }
      } catch {
        // transient — keep polling
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();

  return () => {
    cancelled = true;
  };
}

// =====================================================================
// Session timeline (full-width split waveform)
// =====================================================================
function SessionTimeline({
  masterAnalyserRef,
  cueAnalyserRef,
  masterPlaying,
  cuePlaying,
  masterTitle,
  cueTitle,
}: {
  masterAnalyserRef: RefObject<AnalyserNode | null>;
  cueAnalyserRef: RefObject<AnalyserNode | null>;
  masterPlaying: boolean;
  cuePlaying: boolean;
  masterTitle: string | null;
  cueTitle: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playingRef = useRef({ master: false, cue: false });
  useEffect(() => {
    playingRef.current.master = masterPlaying;
  }, [masterPlaying]);
  useEffect(() => {
    playingRef.current.cue = cuePlaying;
  }, [cuePlaying]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;

    const HISTORY = 600;
    const masterHist = new Float32Array(HISTORY);
    const cueHist = new Float32Array(HISTORY);
    let masterIdx = 0;
    let cueIdx = 0;

    const masterColor = getCss("--accent-master") || "#ff6a3d";
    const cueColor = getCss("--accent-cue") || "#3dd9ff";
    const baselineColor =
      "color-mix(in srgb, " +
      (getCss("--border-strong") || "#3d3d4d") +
      ", transparent 30%)";

    let lastW = 0;
    let lastH = 0;
    let raf = 0;

    function setupCanvas() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas!.clientWidth;
      const cssH = canvas!.clientHeight;
      if (cssW !== lastW || cssH !== lastH) {
        canvas!.width = Math.max(1, Math.floor(cssW * dpr));
        canvas!.height = Math.max(1, Math.floor(cssH * dpr));
        ctx2d!.setTransform(dpr, 0, 0, dpr, 0, 0);
        lastW = cssW;
        lastH = cssH;
      }
      return { w: cssW, h: cssH };
    }

    function samplePeak(analyser: AnalyserNode | null): number {
      if (!analyser) return 0;
      const data = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      return peak;
    }

    function drawHalf(
      x: number,
      width: number,
      h: number,
      midY: number,
      hist: Float32Array,
      writeIdx: number,
      color: string,
      isPlaying: boolean
    ) {
      const N = hist.length;
      const barW = width / N;

      // Baseline
      ctx2d!.fillStyle = baselineColor;
      ctx2d!.fillRect(x, midY - 0.5, width, 1);

      // Bars
      ctx2d!.fillStyle = color;
      for (let i = 0; i < N; i++) {
        const idx = (writeIdx + i) % N;
        const v = hist[idx];
        if (v <= 0.005) continue;
        const barH = Math.max(1, v * h * 0.92);
        const px = x + i * barW;
        const py = midY - barH / 2;
        ctx2d!.fillRect(px, py, Math.max(0.6, barW - 0.3), barH);
      }

      // Playhead at right edge of this half
      ctx2d!.strokeStyle = color;
      ctx2d!.lineWidth = 2;
      ctx2d!.globalAlpha = isPlaying ? 1 : 0.35;
      ctx2d!.beginPath();
      ctx2d!.moveTo(x + width - 1.5, 4);
      ctx2d!.lineTo(x + width - 1.5, h - 4);
      ctx2d!.stroke();
      ctx2d!.globalAlpha = 1;
    }

    function draw() {
      raf = requestAnimationFrame(draw);
      const { w, h } = setupCanvas();
      const midY = h / 2;
      const halfW = w / 2;

      // Only advance each deck's history while THAT deck is playing,
      // so paused decks freeze instead of scrolling silence past.
      if (playingRef.current.master) {
        masterHist[masterIdx] = samplePeak(masterAnalyserRef.current);
        masterIdx = (masterIdx + 1) % HISTORY;
      }
      if (playingRef.current.cue) {
        cueHist[cueIdx] = samplePeak(cueAnalyserRef.current);
        cueIdx = (cueIdx + 1) % HISTORY;
      }

      ctx2d!.clearRect(0, 0, w, h);

      drawHalf(0, halfW, h, midY, masterHist, masterIdx, masterColor, playingRef.current.master);
      drawHalf(halfW, halfW, h, midY, cueHist, cueIdx, cueColor, playingRef.current.cue);

      // divider
      ctx2d!.strokeStyle = "rgba(60, 60, 75, 0.9)";
      ctx2d!.lineWidth = 1;
      ctx2d!.beginPath();
      ctx2d!.moveTo(halfW, 0);
      ctx2d!.lineTo(halfW, h);
      ctx2d!.stroke();
    }

    draw();
    return () => cancelAnimationFrame(raf);
  }, [masterAnalyserRef, cueAnalyserRef]);

  return (
    <div className="session-timeline-wrap">
      <canvas ref={canvasRef} className="session-timeline-canvas" />
      <div className="session-timeline-label-row">
        <span className="session-timeline-label-master">
          ◉ MASTER {masterTitle ? `· ${masterTitle}` : ""}
        </span>
        <span className="session-timeline-label-cue">
          {cueTitle ? `${cueTitle} · ` : ""}CUE ◉
        </span>
      </div>
    </div>
  );
}

function getCss(varName: string): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement)
    .getPropertyValue(varName)
    .trim();
}

// =====================================================================
// Beat counter — resolves on the Nth major peak in `analyser`,
// or after `maxMs` whichever comes first.
// =====================================================================
function waitForBeats(
  analyserRef: RefObject<AnalyserNode | null>,
  count: number,
  maxMs: number
): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const recent: number[] = [];
    const RECENT_LEN = 30;
    const COOLDOWN_MS = 220; // typical kick spacing at 110-140 bpm
    let beats = 0;
    let lastBeatAt = -Infinity;
    let raf = 0;

    function tick() {
      const elapsed = performance.now() - start;
      if (elapsed >= maxMs) {
        cancelAnimationFrame(raf);
        resolve();
        return;
      }
      const a = analyserRef.current;
      if (a) {
        const buf = new Uint8Array(a.fftSize);
        a.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        recent.push(peak);
        if (recent.length > RECENT_LEN) recent.shift();
        if (
          recent.length >= 15 &&
          elapsed > 250 &&
          elapsed - lastBeatAt > COOLDOWN_MS
        ) {
          const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
          if (peak > 0.4 && peak > avg * 1.5) {
            beats += 1;
            lastBeatAt = elapsed;
            if (beats >= count) {
              cancelAnimationFrame(raf);
              resolve();
              return;
            }
          }
        }
      }
      raf = requestAnimationFrame(tick);
    }

    tick();
  });
}

// =====================================================================
// Mixer column
// =====================================================================
function MixerColumn(props: {
  devices: AudioOutputDevice[];
  masterDeviceId: string | null;
  masterDeviceIdSecondary: string | null;
  onMasterDeviceChange: (id: string | null) => void;
  onMasterDeviceSecondaryChange: (id: string | null) => void;
  masterPlaying: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onPause: () => void;
  onNext: () => void;
  crossfading: boolean;
}) {
  const {
    devices,
    masterDeviceId,
    masterDeviceIdSecondary,
    onMasterDeviceChange,
    onMasterDeviceSecondaryChange,
    masterPlaying,
    hasPrev,
    hasNext,
    onPrev,
    onPause,
    onNext,
  } = props;

  return (
    <div className="flex flex-col gap-3 min-h-0">
      <OutputBox
        role="master"
        devices={devices}
        deviceId={masterDeviceId}
        onChange={onMasterDeviceChange}
        secondaryDeviceId={masterDeviceIdSecondary}
        onSecondaryChange={onMasterDeviceSecondaryChange}
      />
      <div className="transport-row">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev}
          aria-label="previous"
          className="transport-row-btn"
          title="Previous track from history"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            {/* |◀ — bar on left, triangle pointing left */}
            <path d="M6 4h2v16H6z M18 4v16l-8.5-8L18 4z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onPause}
          aria-label={masterPlaying ? "pause master" : "play master"}
          className="transport-row-btn transport-row-btn-pause"
          title={masterPlaying ? "Pause master" : "Play master"}
        >
          {masterPlaying ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 4v16l13-8z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={onNext}
          disabled={!hasNext}
          aria-label="next (transition cue → master)"
          className="transport-row-btn transport-row-btn-next"
          title="Transition cue → master"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            {/* ▶| — triangle pointing right, bar on right */}
            <path d="M6 4v16l8.5-8L6 4z M16 4h2v16h-2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// =====================================================================
// Pill section — scrollable wrapping list of toggle pills
// =====================================================================
function PillGroup({
  label,
  options,
  selected,
  onToggle,
  extras,
}: {
  label: string;
  options: readonly string[];
  selected: string[];
  onToggle: (v: string) => void;
  extras?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 shrink-0">
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-zinc-400 shrink-0">
          {label}
        </span>
        <div className="flex-1 h-px bg-zinc-800" />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const isOn = selected.includes(opt);
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onToggle(opt)}
              className={
                "shrink-0 px-2.5 py-1 text-[11px] leading-none rounded-md border whitespace-nowrap cursor-pointer select-none transition-colors " +
                (isOn
                  ? "border-orange-400 bg-orange-400/10 text-orange-400 shadow-[0_0_8px_rgba(255,106,61,0.25)]"
                  : "border-zinc-700 bg-zinc-800/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-100")
              }
            >
              {opt}
            </button>
          );
        })}
        {extras}
      </div>
    </div>
  );
}

// =====================================================================
// Structure picker — three fixed dropdowns (Intro / Drop / Outro)
// =====================================================================
function StructurePicker({
  structure,
  onChange,
  useText,
}: {
  structure: Structure;
  onChange: (next: Structure) => void;
  useText: boolean;
}) {
  return (
    <div className="structure-picker">
      <StructureRow
        label="INTRO"
        value={structure.intro}
        options={INTRO_OPTIONS}
        onChange={(v) => onChange({ ...structure, intro: v })}
        useText={useText}
      />
      <StructureRow
        label="DROP"
        value={structure.drop}
        options={DROP_OPTIONS}
        onChange={(v) => onChange({ ...structure, drop: v })}
        useText={useText}
      />
      <StructureRow
        label="OUTRO"
        value={structure.outro}
        options={OUTRO_OPTIONS}
        onChange={(v) => onChange({ ...structure, outro: v })}
        useText={useText}
      />
    </div>
  );
}

function StructureRow({
  label,
  value,
  options,
  onChange,
  useText,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
  useText: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 w-full">
      <span className="font-mono text-[10px] tracking-[0.18em] uppercase text-fg-dim">
        {label}
      </span>
      {useText ? (
        <input
          type="text"
          className="structure-input w-full"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={options[0]}
        />
      ) : (
        <select
          className="dj-select structure-select w-full"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function OutputBox({
  role,
  devices,
  deviceId,
  onChange,
  secondaryDeviceId,
  onSecondaryChange,
}: {
  role: Role;
  devices: AudioOutputDevice[];
  deviceId: string | null;
  onChange: (id: string | null) => void;
  secondaryDeviceId?: string | null;
  onSecondaryChange?: (id: string | null) => void;
}) {
  const showSecondary =
    role === "master" && typeof onSecondaryChange === "function";
  // Don't let the user pick the same device for primary and secondary.
  const secondaryOptions = devices.filter((d) => d.deviceId !== deviceId);
  return (
    <div className={`mixer-box mixer-box-${role}`}>
      <span className={`deck-label deck-label-${role}`}>
        {role === "master" ? "AUDIO OUTPUT" : "CUE OUT"}
      </span>
      <select
        className={`dj-select dj-select-${role} w-full`}
        value={deviceId ?? ""}
        onChange={(e) => {
          const next = e.target.value || null;
          onChange(next);
          // If primary now equals current secondary, clear secondary.
          if (
            showSecondary &&
            next &&
            secondaryDeviceId &&
            next === secondaryDeviceId &&
            onSecondaryChange
          ) {
            onSecondaryChange(null);
          }
        }}
      >
        <option value="">DEFAULT (SYSTEM)</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `Output ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
      {showSecondary ? (
        <select
          className={`dj-select dj-select-${role} w-full`}
          value={secondaryDeviceId ?? ""}
          onChange={(e) => onSecondaryChange?.(e.target.value || null)}
          title="Optional second output — master mix plays out of both"
        >
          <option value="">+ ADD SECOND OUTPUT (OPTIONAL)</option>
          {secondaryOptions.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Output ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

// =====================================================================
// Deck (no waveform inside; play btn moved to LEFT of jog wheel)
// =====================================================================
function Deck(props: {
  role: Role;
  deck: DeckState | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  pipelineError: string | null;
  onToggleVariant?: () => void;
}) {
  const {
    role,
    deck,
    playing,
    currentTime,
    duration,
    onTogglePlay,
    onSeek,
    pipelineError,
    onToggleVariant,
  } = props;
  const isMaster = role === "master";
  const accentClass = isMaster ? "master" : "cue";

  const variant = activeVariant(deck);
  const stream = bestStreamUrl(variant);
  const isReady = !!stream;
  const isFinal = !!variant?.audioUrl;
  const failed = deck && TERMINAL_FAILURES.has(deck.status);
  const status = deck?.status ?? null;
  const variantCount = deck?.variants.length ?? 0;
  const variantIndex = deck?.activeVariantIndex ?? 0;

  const validDuration = Number.isFinite(duration) && duration > 0;
  const progress = validDuration ? currentTime / duration : 0;

  const togglePlay = onTogglePlay;
  const seek = onSeek;

  return (
    <section className={`deck-panel deck-panel-${accentClass} p-4`}>
      {/* top row: label pinned far-left, status pill far-right; the cue
          preview button is absolutely centered against the panel itself so
          it ignores label / pill widths and sits at the true horizontal
          midpoint. */}
      <div className="relative flex items-start justify-between gap-2">
        <span
          className={`deck-label deck-label-${accentClass} h-7 flex items-center`}
        >
          ◉ {isMaster ? "MASTER" : "CUE"}
        </span>
        {!isMaster && (
          <button
            type="button"
            onClick={togglePlay}
            disabled={!isReady}
            aria-label={playing ? "pause preview" : "preview track"}
            className="cue-preview-btn absolute left-1/2 top-3.5 -translate-x-1/2 -translate-y-1/2"
          >
            {playing ? "⏸ PAUSE PREVIEW" : "▶ PREVIEW TRACK"}
          </button>
        )}
        <div className="flex flex-col gap-1.5 items-end">
          <StatusPill
            status={status}
            isReady={isReady}
            isFinal={isFinal}
            failed={!!failed}
          />
          {!isMaster && (
            <button
              type="button"
              onClick={onToggleVariant}
              disabled={variantCount < 2}
              aria-label="toggle variant"
              className="pill pill-button"
              title={
                variantCount < 2
                  ? "second variant not ready yet"
                  : `switch to variant ${((variantIndex + 1) % variantCount) + 1}`
              }
            >
              <svg
                width="9"
                height="9"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M17 3l4 4-4 4M21 7H7" />
                <path d="M7 21l-4-4 4-4M17 17H3" />
              </svg>
              VERSION {variantIndex + 1}
            </button>
          )}
        </div>
      </div>

      {pipelineError && (
        <p className="text-[10px] text-red-400 leading-tight mt-1">
          {pipelineError}
        </p>
      )}

      {/* center: jog wheel only, horizontally centered */}
      <div className="deck-center-row">
        <div className="jog-wheel">
          <JogWheel role={role} playing={playing} progress={progress} />
        </div>
      </div>

      {/* track title + time */}
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span
          className={`lcd text-sm truncate ${
            deck ? `lcd-glow-${accentClass}` : "text-fg-dimmer"
          }`}
        >
          {deck?.title ?? "— — —"}
        </span>
        <span
          className={`lcd text-sm shrink-0 ${
            playing ? `lcd-glow-${accentClass}` : "text-fg-dim"
          }`}
        >
          {fmtTime(currentTime)}
          <span className="text-fg-dimmer"> / </span>
          {validDuration ? fmtTime(duration) : "--:--"}
        </span>
      </div>

      {/* style summary */}
      <p className="text-[11px] text-fg-dim line-clamp-1 mb-2 leading-tight">
        {deck?.styleSummary ?? "no track loaded"}
      </p>

      {/* scrubber */}
      <ScrubBar
        role={role}
        progress={progress}
        duration={duration}
        validDuration={validDuration}
        onSeek={seek}
      />
    </section>
  );
}

// =====================================================================
// JogWheel
// =====================================================================
function JogWheel({
  role,
  playing,
  progress,
}: {
  role: Role;
  playing: boolean;
  progress: number;
}) {
  const accent = role === "master" ? "var(--accent-master)" : "var(--accent-cue)";
  const r = 46;
  const circ = 2 * Math.PI * r;
  const dashOffset = circ * (1 - progress);

  return (
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id={`jog-grad-${role}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#1d1d27" />
          <stop offset="60%" stopColor="#0f0f15" />
          <stop offset="100%" stopColor="#07070a" />
        </radialGradient>
      </defs>

      <circle
        cx="50"
        cy="50"
        r="48"
        fill="none"
        stroke="var(--border)"
        strokeWidth="0.5"
      />

      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke={accent}
        strokeWidth="1.5"
        strokeDasharray={circ}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 50 50)"
        opacity={progress > 0 ? 0.85 : 0.15}
        style={{ transition: "stroke-dashoffset 0.1s linear" }}
      />

      <circle
        cx="50"
        cy="50"
        r="42"
        fill={`url(#jog-grad-${role})`}
        stroke="var(--border-strong)"
        strokeWidth="0.8"
      />

      <g
        className={`jog-spin ${playing ? "is-playing" : ""}`}
        style={{ transformOrigin: "50px 50px" }}
      >
        {Array.from({ length: 24 }, (_, i) => {
          const angle = (i / 24) * 360;
          const isMajor = i % 6 === 0;
          return (
            <line
              key={i}
              x1="50"
              y1="10"
              x2="50"
              y2={isMajor ? "16" : "13"}
              stroke={isMajor ? accent : "var(--fg-dimmer)"}
              strokeWidth={isMajor ? "1.2" : "0.6"}
              opacity={isMajor ? 0.8 : 0.4}
              transform={`rotate(${angle} 50 50)`}
            />
          );
        })}
        <circle cx="50" cy="14" r="2" fill={accent} opacity={playing ? 1 : 0.4}>
          {playing && (
            <animate
              attributeName="opacity"
              values="1;0.5;1"
              dur="1.5s"
              repeatCount="indefinite"
            />
          )}
        </circle>
      </g>

      <circle
        cx="50"
        cy="50"
        r="8"
        fill="var(--bg-elev-3)"
        stroke="var(--border-strong)"
        strokeWidth="0.5"
      />
      <circle cx="50" cy="50" r="2" fill={accent} opacity={playing ? 1 : 0.3} />
    </svg>
  );
}

// =====================================================================
// ScrubBar / StatusPill / fmtTime
// =====================================================================
function ScrubBar({
  role,
  progress,
  duration,
  validDuration,
  onSeek,
}: {
  role: Role;
  progress: number;
  duration: number;
  validDuration: boolean;
  onSeek: (t: number) => void;
}) {
  const fillClass =
    role === "master" ? "scrub-fill-master" : "scrub-fill-cue";

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!validDuration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    onSeek(pct * duration);
  }

  return (
    <div
      className="scrub-track"
      onClick={handleClick}
      style={{ cursor: validDuration ? "pointer" : "default" }}
    >
      <div
        className={`scrub-fill ${fillClass}`}
        style={{ width: `${Math.max(0, Math.min(1, progress)) * 100}%` }}
      />
    </div>
  );
}

function StatusPill({
  status,
  isReady,
  isFinal,
  failed,
}: {
  status: SunoTaskStatus | null;
  isReady: boolean;
  isFinal: boolean;
  failed: boolean;
}) {
  let dotClass = "pill-dot";
  let label = "EMPTY";
  if (failed) {
    dotClass = "pill-dot pill-dot-error";
    label = status ?? "FAILED";
  } else if (isFinal) {
    dotClass = "pill-dot pill-dot-ready";
    label = "READY";
  } else if (isReady) {
    dotClass = "pill-dot pill-dot-streaming";
    label = "STREAMING";
  } else if (status) {
    dotClass = "pill-dot pill-dot-streaming";
    label = status;
  }
  return (
    <span className="pill shrink-0">
      <span className={dotClass} />
      {label}
    </span>
  );
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "--:--";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
