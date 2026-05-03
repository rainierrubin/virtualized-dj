/**
 * Audio analysis worker — implements beat tracking, structural segmentation,
 * and energy-curve analysis on a decoded mono PCM Float32Array.
 *
 * Algorithms:
 *  - Onset envelope: spectral flux on log-magnitude STFT, low/mid bands.
 *  - Tempo estimation: autocorrelation of onset envelope, peak in 60–200 BPM.
 *  - Beat tracking: Ellis 2007 dynamic-programming tracker (onset score plus
 *    tempo regularity penalty).
 *  - Downbeat phase: max sub-bass RMS over each candidate downbeat phase
 *    (assumes 4/4 — true for ~all Suno output).
 *  - Bar-pooled MFCC + cosine SSM + Foote novelty (16-bar Gaussian-tapered
 *    checkerboard kernel) for structural segmentation.
 *  - Section labelling by per-bar broadband RMS deltas (drop = sustained
 *    rise after a build, intro = first sustained rise, outro = last
 *    sustained drop ≥8 bars before track end).
 *
 * Pure TypeScript, no WASM. ~5–15× realtime per track in a modern V8.
 */

// fft.js is CommonJS; in worker bundlers Turbopack handles the interop.
// (Type declaration further down because the lib has no built-in types.)
// eslint-disable-next-line @typescript-eslint/no-require-imports
import FFT from "fft.js";

import type {
  AnalysisRequest,
  AnalysisResponse,
  TrackAnalysis,
  TrackSection,
} from "@/lib/analysis-types";

// ---------------------------------------------------------------------------
// Worker message handler
// ---------------------------------------------------------------------------
self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const start = performance.now();
  const { taskId, pcm, sampleRate } = e.data;
  try {
    const result = analyze(pcm, sampleRate);
    const resp: AnalysisResponse = {
      taskId,
      result,
      durationMs: performance.now() - start,
    };
    self.postMessage(resp);
  } catch (err) {
    const resp: AnalysisResponse = {
      taskId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: performance.now() - start,
    };
    self.postMessage(resp);
  }
};

// ---------------------------------------------------------------------------
// Top-level analysis pipeline
// ---------------------------------------------------------------------------
function analyze(pcm: Float32Array, sr: number): TrackAnalysis {
  const durationSec = pcm.length / sr;

  // Phase A.1: onset envelope (STFT + spectral flux on log-magnitudes).
  const FRAME_SIZE = 2048;
  const HOP = 512; // ~11.6 ms at 44.1 kHz
  const onsetEnv = computeSpectralFluxOnsets(pcm, sr, FRAME_SIZE, HOP);

  // Phase A.2: global tempo from autocorrelation of onset envelope.
  const onsetSr = sr / HOP;
  const { bpm, confidence: bpmConfidence } = estimateTempo(onsetEnv, onsetSr);

  // Phase A.3: dynamic-programming beat tracking.
  const beatFrames = trackBeats(onsetEnv, onsetSr, bpm);
  const beats = beatFrames.map((f) => f / onsetSr);

  // Phase A.4: downbeat phase by sub-bass RMS on every-4th-beat candidates.
  const subBassRmsPerBeat = perBeatBandRms(pcm, sr, beats, 20, 150);
  const broadbandRmsPerBeat = perBeatBandRms(pcm, sr, beats, 20, 16000);
  const downbeatPhase = pickDownbeatPhase(subBassRmsPerBeat);
  const downbeats: number[] = [];
  for (let i = downbeatPhase; i < beats.length; i += 4) {
    downbeats.push(beats[i]);
  }

  // Per-bar RMS and bass curves.
  const rmsBars: number[] = [];
  const bassBars: number[] = [];
  for (let b = 0; b < downbeats.length - 1; b++) {
    const startBeat = downbeatPhase + b * 4;
    const endBeat = Math.min(startBeat + 4, beats.length);
    let rms = 0;
    let bass = 0;
    let n = 0;
    for (let k = startBeat; k < endBeat; k++) {
      rms += broadbandRmsPerBeat[k] ?? 0;
      bass += subBassRmsPerBeat[k] ?? 0;
      n++;
    }
    rmsBars.push(n > 0 ? rms / n : 0);
    bassBars.push(n > 0 ? bass / n : 0);
  }

  // Phase B.1: bar-pooled MFCC.
  const mfccPerFrame = computeMfccFrames(pcm, sr, FRAME_SIZE, HOP, 13);
  const mfccPerBar = poolMfccByBar(mfccPerFrame, downbeats, sr / HOP);

  // Phase B.2: cosine SSM + Foote novelty.
  const ssm = cosineSelfSimilarity(mfccPerBar);
  const novelty = footeNovelty(ssm, 16);
  const segmentBoundaries = pickNoveltyPeaks(novelty, 8);

  // Phase B.3: section labelling from per-bar RMS deltas.
  const sections = labelSections(
    segmentBoundaries,
    downbeats,
    rmsBars,
    durationSec
  );

  // Phase B.4: identify intro end / outro start / drops.
  const introEndDownbeat = findIntroEnd(rmsBars);
  const outroStartDownbeat = findOutroStart(rmsBars);
  const drops = findDrops(rmsBars);

  return {
    sampleRate: sr,
    durationSec,
    bpm,
    bpmConfidence,
    beats,
    downbeats,
    rmsBars,
    bassBars,
    segmentBoundaries,
    sections,
    introEndDownbeat,
    outroStartDownbeat,
    drops,
  };
}

// ===========================================================================
// FFT helpers
// ===========================================================================

class FFTHelper {
  private fft: InstanceType<typeof FFT>;
  private out: Float32Array;
  private size: number;
  constructor(size: number) {
    this.size = size;
    this.fft = new FFT(size);
    this.out = new Float32Array(size * 2);
  }
  /** Returns magnitude spectrum length size/2+1 (real-valued input). */
  magnitudes(input: Float32Array, output: Float32Array): void {
    const data = this.fft.toComplexArray(input as unknown as number[], null);
    this.fft.transform(this.out, data);
    const half = this.size / 2;
    for (let i = 0; i <= half; i++) {
      const re = this.out[2 * i];
      const im = this.out[2 * i + 1];
      output[i] = Math.sqrt(re * re + im * im);
    }
  }
}

function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

// ===========================================================================
// Onset detection — log-magnitude spectral flux summed over low+mid bands
// ===========================================================================

function computeSpectralFluxOnsets(
  pcm: Float32Array,
  sr: number,
  frameSize: number,
  hop: number
): Float32Array {
  const fft = new FFTHelper(frameSize);
  const window = hannWindow(frameSize);
  const half = frameSize / 2;
  const numFrames = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1);
  const onset = new Float32Array(numFrames);

  // Restrict spectral flux to bands where percussive onsets live.
  const lowBin = Math.max(1, Math.floor((40 / sr) * frameSize));
  const highBin = Math.min(half, Math.floor((4000 / sr) * frameSize));

  const frame = new Float32Array(frameSize);
  const mag = new Float32Array(half + 1);
  const prevLog = new Float32Array(half + 1);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hop;
    for (let i = 0; i < frameSize; i++) {
      frame[i] = pcm[offset + i] * window[i];
    }
    fft.magnitudes(frame, mag);
    let flux = 0;
    if (f === 0) {
      for (let k = lowBin; k <= highBin; k++) {
        prevLog[k] = Math.log1p(mag[k]);
      }
    } else {
      for (let k = lowBin; k <= highBin; k++) {
        const logMag = Math.log1p(mag[k]);
        const diff = logMag - prevLog[k];
        if (diff > 0) flux += diff;
        prevLog[k] = logMag;
      }
    }
    onset[f] = flux;
  }

  // Subtract a moving median to suppress slow-moving energy and emphasise
  // transients. (Standard onset-envelope post-processing.)
  return removeMovingMedian(onset, Math.floor(0.1 * (sr / hop)));
}

function removeMovingMedian(x: Float32Array, halfWin: number): Float32Array {
  const out = new Float32Array(x.length);
  const win: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(x.length - 1, i + halfWin);
    win.length = 0;
    for (let j = lo; j <= hi; j++) win.push(x[j]);
    win.sort((a, b) => a - b);
    const med = win[Math.floor(win.length / 2)];
    out[i] = Math.max(0, x[i] - med);
  }
  return out;
}

// ===========================================================================
// Tempo estimation — autocorrelation peak in 60–200 BPM
// ===========================================================================

function estimateTempo(
  onset: Float32Array,
  onsetSr: number
): { bpm: number; confidence: number } {
  const minLag = Math.floor((60 / 200) * onsetSr); // 200 BPM
  const maxLag = Math.ceil((60 / 60) * onsetSr); // 60 BPM
  const acf = new Float32Array(maxLag + 1);

  // Mean-centre onset.
  let mean = 0;
  for (let i = 0; i < onset.length; i++) mean += onset[i];
  mean /= onset.length;
  const centred = new Float32Array(onset.length);
  for (let i = 0; i < onset.length; i++) centred[i] = onset[i] - mean;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const upper = onset.length - lag;
    for (let i = 0; i < upper; i++) {
      sum += centred[i] * centred[i + lag];
    }
    acf[lag] = sum;
  }

  // Find best lag in window (with bias toward common dance tempos).
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpmCandidate = (60 * onsetSr) / lag;
    // Mild prior toward 100–135 BPM.
    const prior = Math.exp(-Math.pow((bpmCandidate - 120) / 60, 2));
    const score = acf[lag] * (0.5 + 0.5 * prior);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const bpm = (60 * onsetSr) / bestLag;

  // Confidence: ratio of best peak to the mean of nearby ACF values.
  let nearby = 0;
  let count = 0;
  for (let lag = Math.max(minLag, bestLag - 10); lag <= Math.min(maxLag, bestLag + 10); lag++) {
    if (Math.abs(lag - bestLag) > 2) {
      nearby += acf[lag];
      count++;
    }
  }
  const meanNearby = count > 0 ? nearby / count : 1;
  const confidence = Math.min(
    1,
    Math.max(0, (acf[bestLag] - meanNearby) / Math.max(1e-9, Math.abs(acf[bestLag])))
  );
  return { bpm, confidence };
}

// ===========================================================================
// Beat tracking — Ellis 2007 dynamic programming
// ===========================================================================

function trackBeats(
  onset: Float32Array,
  onsetSr: number,
  bpm: number
): number[] {
  const period = (60 * onsetSr) / bpm; // expected frames per beat
  const tightness = 100; // Ellis default

  // Normalise onset to ~unit variance for stable alpha.
  let mean = 0;
  for (let i = 0; i < onset.length; i++) mean += onset[i];
  mean /= onset.length;
  let v = 0;
  for (let i = 0; i < onset.length; i++) v += (onset[i] - mean) ** 2;
  const std = Math.sqrt(v / onset.length) || 1;
  const o = new Float32Array(onset.length);
  for (let i = 0; i < onset.length; i++) o[i] = Math.max(0, (onset[i] - mean) / std);

  const score = new Float32Array(o.length);
  const back = new Int32Array(o.length);
  const lookbackMin = Math.max(1, Math.floor(period * 0.5));
  const lookbackMax = Math.min(o.length, Math.floor(period * 2.0));

  for (let i = 0; i < o.length; i++) {
    let best = -Infinity;
    let bestPrev = -1;
    const lo = Math.max(0, i - lookbackMax);
    const hi = i - lookbackMin;
    for (let j = lo; j <= hi; j++) {
      const dt = i - j;
      const txCost = -tightness * Math.pow(Math.log(dt / period), 2);
      const s = score[j] + txCost;
      if (s > best) {
        best = s;
        bestPrev = j;
      }
    }
    if (bestPrev < 0) {
      score[i] = o[i];
      back[i] = -1;
    } else {
      score[i] = o[i] + best;
      back[i] = bestPrev;
    }
  }

  // Pick best end frame and trace back.
  let endFrame = 0;
  let endScore = -Infinity;
  // Avoid the very last few frames (window edge effects).
  for (let i = o.length - 1; i >= Math.max(0, o.length - lookbackMax); i--) {
    if (score[i] > endScore) {
      endScore = score[i];
      endFrame = i;
    }
  }

  const beats: number[] = [];
  let f = endFrame;
  while (f > 0) {
    beats.push(f);
    if (back[f] < 0) break;
    f = back[f];
  }
  beats.reverse();
  return beats;
}

// ===========================================================================
// Per-beat band RMS — for downbeat phase + energy curves
// ===========================================================================

function perBeatBandRms(
  pcm: Float32Array,
  sr: number,
  beats: number[],
  loHz: number,
  hiHz: number
): number[] {
  // For sub-bass (≤150 Hz) we use a one-pass time-domain filter to keep this
  // worker lightweight; for broader bands we just use full-band RMS over the
  // beat window (since the alternative is a full STFT at every beat, which
  // is overkill — broadband RMS is what most auto-DJ systems use anyway).
  const out: number[] = new Array(beats.length).fill(0);
  if (beats.length === 0) return out;

  let signal: Float32Array;
  if (loHz <= 30 && hiHz <= 200) {
    signal = lowpass(pcm, sr, hiHz);
  } else {
    signal = pcm;
  }

  for (let i = 0; i < beats.length - 1; i++) {
    const a = Math.floor(beats[i] * sr);
    const b = Math.floor(beats[i + 1] * sr);
    let sum = 0;
    let n = 0;
    for (let k = a; k < b && k < signal.length; k++) {
      sum += signal[k] * signal[k];
      n++;
    }
    out[i] = n > 0 ? Math.sqrt(sum / n) : 0;
  }
  out[beats.length - 1] = out[beats.length - 2] ?? 0;
  return out;
}

/** Simple 1-pole IIR low-pass at -3 dB cutoff `cutoffHz`. */
function lowpass(pcm: Float32Array, sr: number, cutoffHz: number): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sr;
  const alpha = dt / (rc + dt);
  const out = new Float32Array(pcm.length);
  let prev = 0;
  for (let i = 0; i < pcm.length; i++) {
    prev = prev + alpha * (pcm[i] - prev);
    out[i] = prev;
  }
  return out;
}

// ===========================================================================
// Downbeat phase — assumes 4/4, picks phase that maximises sub-bass on bar 1
// ===========================================================================

function pickDownbeatPhase(perBeatBass: number[]): 0 | 1 | 2 | 3 {
  const sums = [0, 0, 0, 0];
  for (let i = 0; i < perBeatBass.length; i++) {
    sums[i % 4] += perBeatBass[i];
  }
  let bestPhase: 0 | 1 | 2 | 3 = 0;
  let best = -Infinity;
  for (let p = 0; p < 4; p++) {
    if (sums[p] > best) {
      best = sums[p];
      bestPhase = p as 0 | 1 | 2 | 3;
    }
  }
  return bestPhase;
}

// ===========================================================================
// MFCC — mel filterbank → log → DCT-II, 13 coefficients
// ===========================================================================

function computeMfccFrames(
  pcm: Float32Array,
  sr: number,
  frameSize: number,
  hop: number,
  numCoeffs: number
): Float32Array[] {
  const fft = new FFTHelper(frameSize);
  const window = hannWindow(frameSize);
  const half = frameSize / 2;
  const numMel = 40;
  const melFilters = buildMelFilterbank(frameSize, sr, numMel, 0, sr / 2);
  const numFrames = Math.max(0, Math.floor((pcm.length - frameSize) / hop) + 1);
  const out: Float32Array[] = [];
  const frame = new Float32Array(frameSize);
  const mag = new Float32Array(half + 1);
  const melE = new Float32Array(numMel);
  const dct = buildDctMatrix(numMel, numCoeffs);

  for (let f = 0; f < numFrames; f++) {
    const offset = f * hop;
    for (let i = 0; i < frameSize; i++) frame[i] = pcm[offset + i] * window[i];
    fft.magnitudes(frame, mag);
    // Apply mel filterbank to power spectrum.
    for (let m = 0; m < numMel; m++) {
      let s = 0;
      const filter = melFilters[m];
      for (let k = 0; k < filter.length; k++) {
        s += mag[k] * mag[k] * filter[k];
      }
      melE[m] = Math.log(s + 1e-9);
    }
    const coeffs = new Float32Array(numCoeffs);
    for (let c = 0; c < numCoeffs; c++) {
      let s = 0;
      const row = dct[c];
      for (let m = 0; m < numMel; m++) s += melE[m] * row[m];
      coeffs[c] = s;
    }
    out.push(coeffs);
  }
  return out;
}

function buildMelFilterbank(
  fftSize: number,
  sr: number,
  numFilters: number,
  fMin: number,
  fMax: number
): Float32Array[] {
  const half = fftSize / 2;
  const melMin = hzToMel(fMin);
  const melMax = hzToMel(fMax);
  const points: number[] = [];
  for (let i = 0; i <= numFilters + 1; i++) {
    const mel = melMin + ((melMax - melMin) * i) / (numFilters + 1);
    const hz = melToHz(mel);
    points.push(Math.floor((hz / sr) * fftSize));
  }
  const filters: Float32Array[] = [];
  for (let m = 1; m <= numFilters; m++) {
    const f = new Float32Array(half + 1);
    const left = points[m - 1];
    const center = points[m];
    const right = points[m + 1];
    for (let k = left; k < center; k++) {
      f[k] = center === left ? 1 : (k - left) / (center - left);
    }
    for (let k = center; k < right; k++) {
      f[k] = right === center ? 1 : (right - k) / (right - center);
    }
    filters.push(f);
  }
  return filters;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function buildDctMatrix(numMel: number, numCoeffs: number): Float32Array[] {
  const m: Float32Array[] = [];
  for (let c = 0; c < numCoeffs; c++) {
    const row = new Float32Array(numMel);
    for (let n = 0; n < numMel; n++) {
      row[n] = Math.cos((Math.PI * c * (2 * n + 1)) / (2 * numMel));
    }
    m.push(row);
  }
  return m;
}

// ===========================================================================
// Bar-pooled MFCC + cosine SSM + Foote novelty
// ===========================================================================

function poolMfccByBar(
  mfccPerFrame: Float32Array[],
  downbeats: number[],
  framesPerSec: number
): Float32Array[] {
  const out: Float32Array[] = [];
  if (downbeats.length < 2 || mfccPerFrame.length === 0) return out;
  const dim = mfccPerFrame[0].length;
  for (let i = 0; i < downbeats.length - 1; i++) {
    const a = Math.floor(downbeats[i] * framesPerSec);
    const b = Math.floor(downbeats[i + 1] * framesPerSec);
    const acc = new Float32Array(dim);
    let n = 0;
    for (let f = a; f < b && f < mfccPerFrame.length; f++) {
      const v = mfccPerFrame[f];
      for (let d = 0; d < dim; d++) acc[d] += v[d];
      n++;
    }
    if (n > 0) for (let d = 0; d < dim; d++) acc[d] /= n;
    out.push(acc);
  }
  return out;
}

function cosineSelfSimilarity(vectors: Float32Array[]): Float32Array[] {
  const N = vectors.length;
  const norms = vectors.map((v) => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s) || 1;
  });
  const ssm: Float32Array[] = [];
  for (let i = 0; i < N; i++) {
    const row = new Float32Array(N);
    for (let j = 0; j < N; j++) {
      let dot = 0;
      const a = vectors[i];
      const b = vectors[j];
      for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
      row[j] = dot / (norms[i] * norms[j]);
    }
    ssm.push(row);
  }
  return ssm;
}

/**
 * Foote checkerboard novelty along the SSM diagonal, with a 2D
 * Gaussian-tapered checkerboard kernel of side `kernelSize` (in bars).
 */
function footeNovelty(
  ssm: Float32Array[],
  kernelSize: number
): Float32Array {
  const N = ssm.length;
  const half = Math.floor(kernelSize / 2);
  const novelty = new Float32Array(N);
  // Checkerboard ±1 kernel with Gaussian taper.
  const kernel: number[][] = [];
  for (let i = -half; i < half; i++) {
    const row: number[] = [];
    for (let j = -half; j < half; j++) {
      const sign = (i < 0 ? 1 : -1) * (j < 0 ? 1 : -1) * -1; // top-left/bottom-right +, others -
      const taper = Math.exp(-(i * i + j * j) / (2 * (half / 2) ** 2));
      row.push(sign * taper);
    }
    kernel.push(row);
  }

  for (let n = half; n < N - half; n++) {
    let s = 0;
    for (let i = -half; i < half; i++) {
      const ssmRow = ssm[n + i];
      const kRow = kernel[i + half];
      for (let j = -half; j < half; j++) {
        s += ssmRow[n + j] * kRow[j + half];
      }
    }
    novelty[n] = s;
  }
  return novelty;
}

function pickNoveltyPeaks(
  novelty: Float32Array,
  minSpacing: number
): number[] {
  const peaks: number[] = [];
  // Compute mean + std for adaptive threshold.
  let mean = 0;
  for (let i = 0; i < novelty.length; i++) mean += novelty[i];
  mean /= Math.max(1, novelty.length);
  let v = 0;
  for (let i = 0; i < novelty.length; i++) v += (novelty[i] - mean) ** 2;
  const std = Math.sqrt(v / Math.max(1, novelty.length));
  const threshold = mean + 0.5 * std;

  for (let i = 1; i < novelty.length - 1; i++) {
    if (
      novelty[i] > threshold &&
      novelty[i] > novelty[i - 1] &&
      novelty[i] > novelty[i + 1]
    ) {
      // Snap to multiples of 4 bars (16-bar phrases preferred but 4-bar is
      // safer for the variety of Suno output).
      const lastPeak = peaks[peaks.length - 1] ?? -minSpacing;
      if (i - lastPeak >= minSpacing) peaks.push(i);
    }
  }
  return peaks;
}

// ===========================================================================
// Section labelling — heuristic from per-bar RMS deltas
// ===========================================================================

function labelSections(
  boundaries: number[],
  downbeats: number[],
  rmsBars: number[],
  durationSec: number
): TrackSection[] {
  const sections: TrackSection[] = [];
  const points = [0, ...boundaries, downbeats.length - 1];
  // De-dup & sort.
  const sorted = Array.from(new Set(points)).sort((a, b) => a - b);

  // Compute global mean RMS for labelling.
  let globalMean = 0;
  for (let i = 0; i < rmsBars.length; i++) globalMean += rmsBars[i];
  globalMean /= Math.max(1, rmsBars.length);

  for (let s = 0; s < sorted.length - 1; s++) {
    const startBar = sorted[s];
    const endBar = sorted[s + 1];
    const startSec = downbeats[startBar] ?? 0;
    const endSec = downbeats[endBar] ?? durationSec;
    let sumRms = 0;
    let nBars = 0;
    for (let b = startBar; b < endBar; b++) {
      sumRms += rmsBars[b] ?? 0;
      nBars++;
    }
    const meanRms = nBars > 0 ? sumRms / nBars : 0;

    // Heuristic kind:
    let kind: TrackSection["kind"] = "main";
    const isFirst = s === 0;
    const isLast = s === sorted.length - 2;
    const isHigh = meanRms > globalMean * 1.15;
    const isLow = meanRms < globalMean * 0.7;
    if (isFirst && isLow) kind = "intro";
    else if (isLast && isLow) kind = "outro";
    else if (isHigh) {
      // Rising into this section?
      const prevMean =
        s > 0
          ? meanRangeRms(rmsBars, sorted[s - 1], sorted[s])
          : 0;
      kind = meanRms > prevMean * 1.3 ? "drop" : "main";
    } else if (isLow) {
      kind = "breakdown";
    } else {
      kind = "build";
    }

    sections.push({
      startSec,
      endSec,
      startDownbeat: startBar,
      endDownbeat: endBar,
      meanRms,
      kind,
    });
  }
  return sections;
}

function meanRangeRms(rmsBars: number[], a: number, b: number): number {
  let s = 0;
  let n = 0;
  for (let i = a; i < b; i++) {
    s += rmsBars[i] ?? 0;
    n++;
  }
  return n > 0 ? s / n : 0;
}

// ===========================================================================
// Intro end / outro start / drops from per-bar RMS
// ===========================================================================

function findIntroEnd(rmsBars: number[]): number {
  if (rmsBars.length < 8) return 0;
  // Find first downbeat where RMS over the next 8 bars is ≥1.3× the mean of
  // the first 4 bars.
  const introMean = mean(rmsBars.slice(0, 4));
  for (let i = 4; i < rmsBars.length - 8; i++) {
    const next = mean(rmsBars.slice(i, i + 8));
    if (next > introMean * 1.3) return i;
  }
  return Math.min(8, rmsBars.length - 1);
}

function findOutroStart(rmsBars: number[]): number {
  if (rmsBars.length < 16) return Math.max(0, rmsBars.length - 8);
  // From the end, find the last downbeat where RMS averaged over 8 bars
  // drops to ≤0.7× the global mean.
  const globalMean = mean(rmsBars);
  for (let i = rmsBars.length - 8; i > 8; i--) {
    const window = mean(rmsBars.slice(i, Math.min(rmsBars.length, i + 8)));
    if (window < globalMean * 0.7) return i;
  }
  return Math.max(0, rmsBars.length - 8);
}

function findDrops(rmsBars: number[]): number[] {
  // A "drop" is a downbeat where RMS over the following 8 bars rises
  // sharply (≥1.5×) above the previous 4 bars.
  const drops: number[] = [];
  for (let i = 4; i < rmsBars.length - 8; i++) {
    const prev = mean(rmsBars.slice(Math.max(0, i - 4), i));
    const after = mean(rmsBars.slice(i, i + 8));
    if (prev > 0 && after / prev >= 1.5) {
      // Avoid duplicates within 8 bars.
      if (drops.length === 0 || i - drops[drops.length - 1] >= 8) drops.push(i);
    }
  }
  return drops;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const v of xs) s += v;
  return s / xs.length;
}
