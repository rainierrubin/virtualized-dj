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

export interface DualPipeline {
  analyserRef: RefObject<AnalyserNode | null>;
  ready: boolean;
  error: string | null;
  resume: () => void;
  setActiveChannel: (channel: "A" | "B", instant?: boolean) => void;
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
export function useMasterDualPipeline(
  audioARef: RefObject<HTMLAudioElement | null>,
  audioBRef: RefObject<HTMLAudioElement | null>,
  initialChannel: "A" | "B",
  deviceId: string | null
): DualPipeline {
  const ctxRef = useRef<ContextWithSink | null>(null);
  const gainARef = useRef<GainNode | null>(null);
  const gainBRef = useRef<GainNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
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
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;

      gainA.gain.value = channelRef.current === "A" ? 1 : 0;
      gainB.gain.value = channelRef.current === "B" ? 1 : 0;

      sourceA.connect(gainA);
      sourceB.connect(gainB);
      gainA.connect(analyser);
      gainB.connect(analyser);
      analyser.connect(ctx.destination);

      ctxRef.current = ctx;
      gainARef.current = gainA;
      gainBRef.current = gainB;
      analyserRef.current = analyser;
      setReady(true);
    } catch (e) {
      setError(
        `master pipeline init failed: ${
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
      gainARef.current = null;
      gainBRef.current = null;
      analyserRef.current = null;
    };
  }, [audioARef, audioBRef]);

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

  return useMemo(
    () => ({ analyserRef, ready, error, resume, setActiveChannel }),
    [ready, error, resume, setActiveChannel]
  );
}
