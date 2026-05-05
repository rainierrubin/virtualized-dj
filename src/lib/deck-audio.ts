/**
 * Per-deck audio pipeline: AudioContext + MediaElementSource + AnalyserNode.
 * Routing via AudioContext.setSinkId (Chrome 110+).
 * Audio plays only after a user gesture resumes the context.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

export interface DeckAudioPipeline {
  analyserRef: RefObject<AnalyserNode | null>;
  ready: boolean;
  error: string | null;
  resume: () => void;
}

/**
 * Per-deck signal chain exposed for the transition engine to schedule
 * AudioParam ramps directly. Each channel passes through:
 *   source → lowShelf (150 Hz, gain 0 dB by default)
 *          → lpf (lowpass, frequency 22 kHz, Q 1)
 *          → gain
 *          → analyser
 *          → ctx.destination
 * The lowShelf and lpf are inert when set to defaults; the transition
 * engine drives them for bass-swap blends and filter-sweep cuts.
 */
export interface DeckChainNodes {
  gain: GainNode;
  lowShelf: BiquadFilterNode;
  lpf: BiquadFilterNode;
}

export interface DualPipelineNodes {
  ctx: AudioContext;
  A: DeckChainNodes;
  B: DeckChainNodes;
}

export interface DualPipeline {
  analyserRef: RefObject<AnalyserNode | null>;
  ready: boolean;
  error: string | null;
  resume: () => void;
  setActiveChannel: (channel: "A" | "B", instant?: boolean) => void;
  /**
   * Returns the AudioContext + the per-channel filter chain so the
   * transition engine can schedule custom AudioParam automations
   * (e.g., low-shelf bass swap, lowpass sweep). Null until the
   * pipeline is initialised.
   */
  nodes: () => DualPipelineNodes | null;
}

interface ContextWithSink extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

export function useDeckAudio(
  audioRef: RefObject<HTMLAudioElement | null>,
  deviceId: string | null
): DeckAudioPipeline {
  const ctxRef = useRef<ContextWithSink | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialise on mount; the audio element must already be present.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || ctxRef.current) return;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor({ latencyHint: "interactive" }) as ContextWithSink;
      const source = ctx.createMediaElementSource(a);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      ctxRef.current = ctx;
      sourceRef.current = source;
      analyserRef.current = analyser;
      setReady(true);
    } catch (e) {
      setError(
        `audio pipeline init failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
    return () => {
      const ctx = ctxRef.current;
      if (ctx) {
        try {
          ctx.close();
        } catch {
          // ignore
        }
      }
      ctxRef.current = null;
      sourceRef.current = null;
      analyserRef.current = null;
    };
  }, [audioRef]);

  // Apply sink whenever device changes.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (typeof ctx.setSinkId !== "function") {
      setError("AudioContext.setSinkId unsupported — Chrome / Edge required");
      return;
    }
    ctx
      .setSinkId(deviceId ?? "")
      .then(() => setError(null))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.includes("going away") ||
          msg.includes("closed") ||
          msg.includes("InvalidStateError")
        ) {
          return;
        }
        setError(`setSinkId: ${msg}`);
      });
  }, [deviceId]);

  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {
        // ignore
      });
    }
  }, []);

  // Stabilise the returned object reference so consumers can safely depend
  // on it in useEffect deps without firing every render.
  return useMemo(
    () => ({ analyserRef, ready, error, resume }),
    [ready, error, resume]
  );
}

/**
 * Dual-channel master pipeline: two HTMLAudioElement sources feeding the
 * same AudioContext through individual GainNodes. The active channel has
 * gain=1 (audible), shadow channel has gain=0 (silent but playing/buffering
 * the next track). Use setActiveChannel("B") to swap audibility instantly
 * with no audio element reload.
 */
type AudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (id: string) => Promise<void>;
};

export function useMasterDualPipeline(
  audioARef: RefObject<HTMLAudioElement | null>,
  audioBRef: RefObject<HTMLAudioElement | null>,
  initialChannel: "A" | "B",
  deviceId: string | null,
  /**
   * Optional second physical output. When set, the master mix is also
   * played out of this device by tapping the analyser into a
   * MediaStreamDestination and feeding a hidden HTMLAudioElement that
   * has setSinkId pinned to this device. Null = single output (default).
   */
  secondaryDeviceId: string | null = null
): DualPipeline {
  const ctxRef = useRef<ContextWithSink | null>(null);
  const gainARef = useRef<GainNode | null>(null);
  const gainBRef = useRef<GainNode | null>(null);
  const lowShelfARef = useRef<BiquadFilterNode | null>(null);
  const lowShelfBRef = useRef<BiquadFilterNode | null>(null);
  const lpfARef = useRef<BiquadFilterNode | null>(null);
  const lpfBRef = useRef<BiquadFilterNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const secondaryDestRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const secondaryAudioRef = useRef<AudioElementWithSink | null>(null);
  const channelRef = useRef<"A" | "B">(initialChannel);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const a = audioARef.current;
    const b = audioBRef.current;
    if (!a || !b || ctxRef.current) return;
    try {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctor({ latencyHint: "interactive" }) as ContextWithSink;
      const sourceA = ctx.createMediaElementSource(a);
      const sourceB = ctx.createMediaElementSource(b);
      const gainA = ctx.createGain();
      const gainB = ctx.createGain();
      // Per-deck low-shelf for bass-swap blends. Gain stays at 0 dB
      // unless the transition engine ramps it (typically -40 dB → 0 or
      // 0 → -40 dB across the crossfade window).
      const lowShelfA = ctx.createBiquadFilter();
      const lowShelfB = ctx.createBiquadFilter();
      for (const ls of [lowShelfA, lowShelfB]) {
        ls.type = "lowshelf";
        ls.frequency.value = 150;
        ls.gain.value = 0;
      }
      // Per-deck low-pass filter for sweep transitions. Stays wide-open
      // (22 kHz) by default; the transition engine sweeps frequency
      // exponentially down to ~250 Hz for a "filter out" effect.
      const lpfA = ctx.createBiquadFilter();
      const lpfB = ctx.createBiquadFilter();
      for (const f of [lpfA, lpfB]) {
        f.type = "lowpass";
        f.frequency.value = 22000;
        f.Q.value = 1;
      }
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;

      gainA.gain.value = channelRef.current === "A" ? 1 : 0;
      gainB.gain.value = channelRef.current === "B" ? 1 : 0;

      // sourceA → lowShelfA → lpfA → gainA → analyser
      sourceA.connect(lowShelfA);
      lowShelfA.connect(lpfA);
      lpfA.connect(gainA);
      gainA.connect(analyser);
      sourceB.connect(lowShelfB);
      lowShelfB.connect(lpfB);
      lpfB.connect(gainB);
      gainB.connect(analyser);
      analyser.connect(ctx.destination);

      // Tap for the optional secondary output. We always create the tap
      // so toggling the secondary device on/off later doesn't require
      // reinitialising the graph; the hidden <audio> sink stays paused
      // until a device id is set.
      const secondaryDest = ctx.createMediaStreamDestination();
      analyser.connect(secondaryDest);
      const secondaryAudio = new Audio() as AudioElementWithSink;
      secondaryAudio.srcObject = secondaryDest.stream;
      secondaryAudio.autoplay = false;

      ctxRef.current = ctx;
      gainARef.current = gainA;
      gainBRef.current = gainB;
      lowShelfARef.current = lowShelfA;
      lowShelfBRef.current = lowShelfB;
      lpfARef.current = lpfA;
      lpfBRef.current = lpfB;
      analyserRef.current = analyser;
      secondaryDestRef.current = secondaryDest;
      secondaryAudioRef.current = secondaryAudio;
      setReady(true);
    } catch (e) {
      setError(
        `master pipeline init failed: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
    return () => {
      const audio = secondaryAudioRef.current;
      if (audio) {
        try {
          audio.pause();
          audio.srcObject = null;
        } catch {
          // ignore
        }
      }
      const ctx = ctxRef.current;
      if (ctx) {
        try {
          ctx.close();
        } catch {
          // ignore
        }
      }
      ctxRef.current = null;
      gainARef.current = null;
      gainBRef.current = null;
      lowShelfARef.current = null;
      lowShelfBRef.current = null;
      lpfARef.current = null;
      lpfBRef.current = null;
      analyserRef.current = null;
      secondaryDestRef.current = null;
      secondaryAudioRef.current = null;
    };
  }, [audioARef, audioBRef]);

  // Apply primary sink whenever device changes.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    if (typeof ctx.setSinkId !== "function") {
      setError("AudioContext.setSinkId unsupported — Chrome / Edge required");
      return;
    }
    ctx
      .setSinkId(deviceId ?? "")
      .then(() => setError(null))
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // Benign: pending setSinkId was canceled because the context was
        // closed (React StrictMode double-mount in dev, or a fast
        // device change). Not user-actionable.
        if (
          msg.includes("going away") ||
          msg.includes("closed") ||
          msg.includes("InvalidStateError")
        ) {
          return;
        }
        setError(`setSinkId: ${msg}`);
      });
  }, [deviceId]);

  // Apply secondary sink. Pauses the hidden element when no device is
  // selected so we don't waste CPU running a sink we'd never hear.
  useEffect(() => {
    const audio = secondaryAudioRef.current;
    if (!audio) return;
    if (!secondaryDeviceId) {
      try {
        audio.pause();
      } catch {
        // ignore
      }
      return;
    }
    if (typeof audio.setSinkId !== "function") {
      setError("HTMLAudioElement.setSinkId unsupported on secondary output");
      return;
    }
    audio
      .setSinkId(secondaryDeviceId)
      .then(() => audio.play())
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.includes("going away") ||
          msg.includes("closed") ||
          msg.includes("InvalidStateError")
        ) {
          return;
        }
        setError(`secondary setSinkId: ${msg}`);
      });
  }, [secondaryDeviceId]);

  const setActiveChannel = useCallback(
    (channel: "A" | "B", instant = false) => {
      channelRef.current = channel;
      const ctx = ctxRef.current;
      const gA = gainARef.current;
      const gB = gainBRef.current;
      if (!ctx || !gA || !gB) return;
      const now = ctx.currentTime;
      const rampMs = instant ? 0 : 0.03;
      gA.gain.cancelScheduledValues(now);
      gB.gain.cancelScheduledValues(now);
      gA.gain.setValueAtTime(gA.gain.value, now);
      gB.gain.setValueAtTime(gB.gain.value, now);
      if (channel === "A") {
        gA.gain.linearRampToValueAtTime(1, now + rampMs);
        gB.gain.linearRampToValueAtTime(0, now + rampMs);
      } else {
        gA.gain.linearRampToValueAtTime(0, now + rampMs);
        gB.gain.linearRampToValueAtTime(1, now + rampMs);
      }
    },
    []
  );

  const resume = useCallback(() => {
    const ctx = ctxRef.current;
    if (ctx && ctx.state === "suspended") {
      ctx.resume().catch(() => {
        // ignore
      });
    }
  }, []);

  const nodes = useCallback((): DualPipelineNodes | null => {
    const ctx = ctxRef.current;
    const gA = gainARef.current;
    const gB = gainBRef.current;
    const lsA = lowShelfARef.current;
    const lsB = lowShelfBRef.current;
    const lpA = lpfARef.current;
    const lpB = lpfBRef.current;
    if (!ctx || !gA || !gB || !lsA || !lsB || !lpA || !lpB) return null;
    return {
      ctx,
      A: { gain: gA, lowShelf: lsA, lpf: lpA },
      B: { gain: gB, lowShelf: lsB, lpf: lpB },
    };
  }, []);

  return useMemo(
    () => ({ analyserRef, ready, error, resume, setActiveChannel, nodes }),
    [ready, error, resume, setActiveChannel, nodes]
  );
}
