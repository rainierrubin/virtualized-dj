/**
 * Main-thread API for the analysis worker. Decodes the MP3 (browser handles
 * MP3 → AudioBuffer via OfflineAudioContext.decodeAudioData), downmixes to
 * mono, and ships the PCM buffer to the worker.
 */
import type {
  AnalysisRequest,
  AnalysisResponse,
  TrackAnalysis,
} from "./analysis-types";

let worker: Worker | null = null;
let workerInitFailed = false;

function getWorker(): Worker | null {
  if (workerInitFailed) return null;
  if (worker) return worker;
  try {
    worker = new Worker(
      new URL("../workers/analysis-worker.ts", import.meta.url),
      { type: "module" }
    );
  } catch (e) {
    console.warn("analysis worker failed to start:", e);
    workerInitFailed = true;
    return null;
  }
  return worker;
}

export interface AnalyzeOptions {
  /** Override sample rate after decode. Default: keep source rate. */
  targetSampleRate?: number;
}

let nextTaskId = 1;

/**
 * Fetch an MP3 URL, decode it, downmix to mono, and analyse it in the
 * worker. Returns the analysis result, or rejects on error.
 */
export async function analyzeAudioUrl(
  url: string,
  opts: AnalyzeOptions = {}
): Promise<TrackAnalysis> {
  const w = getWorker();
  if (!w) throw new Error("analysis worker unavailable");

  // Fetch as ArrayBuffer.
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch ${resp.status} for ${url}`);
  }
  const buf = await resp.arrayBuffer();

  // Decode to AudioBuffer.
  const Ctor: typeof OfflineAudioContext =
    (window as unknown as { OfflineAudioContext: typeof OfflineAudioContext })
      .OfflineAudioContext;
  // Provisional offline context — we'll re-use its decodeAudioData. Once we
  // know the sample rate we could re-render at a target rate but for our
  // purposes the source rate is fine.
  const probeCtx = new Ctor(1, 44100, 44100);
  const audioBuf = await probeCtx.decodeAudioData(buf);

  const targetSr = opts.targetSampleRate ?? audioBuf.sampleRate;

  // Downmix to mono. If we need to resample to a different rate, do that
  // here too via OfflineAudioContext.
  let mono: Float32Array;
  let sr = audioBuf.sampleRate;
  if (targetSr !== audioBuf.sampleRate) {
    const renderCtx = new Ctor(1, audioBuf.duration * targetSr, targetSr);
    const src = renderCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(renderCtx.destination);
    src.start();
    const rendered = await renderCtx.startRendering();
    mono = rendered.getChannelData(0).slice();
    sr = targetSr;
  } else {
    if (audioBuf.numberOfChannels === 1) {
      mono = audioBuf.getChannelData(0).slice();
    } else {
      const length = audioBuf.length;
      mono = new Float32Array(length);
      for (let ch = 0; ch < audioBuf.numberOfChannels; ch++) {
        const data = audioBuf.getChannelData(ch);
        for (let i = 0; i < length; i++) mono[i] += data[i];
      }
      const inv = 1 / audioBuf.numberOfChannels;
      for (let i = 0; i < length; i++) mono[i] *= inv;
    }
  }

  return runAnalysis(w, mono, sr);
}

function runAnalysis(
  w: Worker,
  pcm: Float32Array,
  sampleRate: number
): Promise<TrackAnalysis> {
  return new Promise((resolve, reject) => {
    const taskId = `t${nextTaskId++}`;
    const handler = (e: MessageEvent<AnalysisResponse>) => {
      if (e.data.taskId !== taskId) return;
      w.removeEventListener("message", handler);
      if (e.data.error) reject(new Error(e.data.error));
      else if (e.data.result) resolve(e.data.result);
      else reject(new Error("worker returned no result"));
    };
    w.addEventListener("message", handler);
    const req: AnalysisRequest = { taskId, pcm, sampleRate };
    // Transfer the underlying buffer so we don't pay copy cost.
    w.postMessage(req, [pcm.buffer]);
  });
}
