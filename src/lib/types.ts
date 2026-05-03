export type SunoModel = "V4" | "V4_5" | "V4_5PLUS" | "V4_5ALL" | "V5" | "V5_5";

export type SunoTaskStatus =
  | "PENDING"
  | "TEXT_SUCCESS"
  | "FIRST_SUCCESS"
  | "SUCCESS"
  | "CREATE_TASK_FAILED"
  | "GENERATE_AUDIO_FAILED"
  | "CALLBACK_EXCEPTION"
  | "SENSITIVE_WORD_ERROR";

export interface SunoVariant {
  id: string;
  audioUrl?: string;
  /** Short-lived kie.ai proxy stream — may expire / truncate; avoid. */
  streamAudioUrl?: string;
  /** Original Suno CDN URL — full track, Range-supported, persistent. */
  sourceStreamAudioUrl?: string;
  /** Original Suno CDN URL for the rendered MP3. */
  sourceAudioUrl?: string;
  imageUrl?: string;
  title?: string;
  duration?: number;
  createTime?: string;
}

export interface TaskRecord {
  taskId: string;
  status: SunoTaskStatus;
  variants: SunoVariant[];
}

export const TERMINAL_FAILURES: ReadonlySet<SunoTaskStatus> = new Set([
  "CREATE_TASK_FAILED",
  "GENERATE_AUDIO_FAILED",
  "CALLBACK_EXCEPTION",
  "SENSITIVE_WORD_ERROR",
]);

export function isTerminal(status: SunoTaskStatus): boolean {
  return status === "SUCCESS" || TERMINAL_FAILURES.has(status);
}
