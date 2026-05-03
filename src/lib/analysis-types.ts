/**
 * Track analysis output — produced by the analysis worker on a fully
 * decoded AudioBuffer, used by the transition planner to pick cut points.
 *
 * All times are in seconds relative to track start.
 */

export interface TrackAnalysis {
  sampleRate: number;
  durationSec: number;
  /** Estimated tempo in beats per minute. */
  bpm: number;
  /** Confidence in the BPM estimate, 0..1. */
  bpmConfidence: number;
  /** Detected beat times (seconds). */
  beats: number[];
  /** Subset of `beats` that we believe are downbeats (start of each bar). */
  downbeats: number[];
  /** Per-bar broadband RMS energy (loudness curve), one per downbeat. */
  rmsBars: number[];
  /** Per-bar sub-bass (20–150 Hz) energy. */
  bassBars: number[];
  /** Detected structural segment boundaries (downbeat indices). */
  segmentBoundaries: number[];
  /**
   * Functional sections, in order. Time fields are in seconds.
   */
  sections: TrackSection[];
  /** Index in `downbeats` where intro ends / first “main” section starts. */
  introEndDownbeat: number;
  /** Index in `downbeats` where outro starts. */
  outroStartDownbeat: number;
  /** Strong drop / climax downbeat indices. */
  drops: number[];
}

export interface TrackSection {
  startSec: number;
  endSec: number;
  startDownbeat: number;
  endDownbeat: number;
  /** Average per-bar broadband RMS within the section. */
  meanRms: number;
  /** Heuristic label. */
  kind: "intro" | "build" | "drop" | "main" | "breakdown" | "outro";
}

export interface AnalysisRequest {
  taskId: string;
  /** Mono PCM samples, transferred. */
  pcm: Float32Array;
  sampleRate: number;
}

export interface AnalysisResponse {
  taskId: string;
  result?: TrackAnalysis;
  error?: string;
  durationMs: number;
}
