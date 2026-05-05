/**
 * Server-only kie.ai Suno API client.
 * Reads KIE_API_KEY from env. NEVER import from a client component.
 */
import "server-only";
import type { SunoModel, SunoVariant, TaskRecord } from "./types";

const BASE_URL = process.env.KIE_BASE_URL ?? "https://api.kie.ai";
const API_KEY = process.env.KIE_API_KEY;

if (!API_KEY) {
  throw new Error("KIE_API_KEY is not set in environment");
}

const HEADERS = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
} as const;

export interface GenerateRequest {
  style: string;
  prompt: string;
  title: string;
  model: SunoModel;
  /** If true, Suno generates a vocals-free track. Default false. */
  instrumental?: boolean;
  /**
   * If true (default), customMode is on: prompt is treated as exact
   * lyrics when instrumental is false, style + title are required.
   * If false, kie.ai auto-generates lyrics, style, and title from a
   * single description prompt — gives unique lyrics per call.
   */
  customMode?: boolean;
  styleWeight?: number;
  weirdnessConstraint?: number;
  audioWeight?: number;
  negativeTags?: string;
  personaId?: string;
}

export interface GenerateResponse {
  taskId: string;
}

export async function submitGeneration(
  req: GenerateRequest
): Promise<GenerateResponse> {
  const customMode = req.customMode ?? true;
  const body = {
    prompt: req.prompt,
    // style + title are only meaningful in custom mode; in non-custom
    // mode kie.ai auto-derives them from the prompt.
    ...(customMode && { style: req.style, title: req.title }),
    customMode,
    instrumental: req.instrumental ?? false,
    model: req.model,
    callBackUrl: "https://example.com/kie-callback",
    ...(req.styleWeight !== undefined && { styleWeight: req.styleWeight }),
    ...(req.weirdnessConstraint !== undefined && {
      weirdnessConstraint: req.weirdnessConstraint,
    }),
    ...(req.audioWeight !== undefined && { audioWeight: req.audioWeight }),
    ...(req.negativeTags && { negativeTags: req.negativeTags }),
    ...(req.personaId && { personaId: req.personaId }),
  };

  const resp = await fetch(`${BASE_URL}/api/v1/generate`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  if (!resp.ok || json.code !== 200) {
    throw new Error(
      `kie.ai generate failed: code=${json.code} msg=${json.msg ?? resp.statusText}`
    );
  }
  return { taskId: json.data.taskId };
}

export async function getTaskRecord(taskId: string): Promise<TaskRecord> {
  const url = new URL(`${BASE_URL}/api/v1/generate/record-info`);
  url.searchParams.set("taskId", taskId);

  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: HEADERS.Authorization },
    cache: "no-store",
  });

  const json = await resp.json();
  if (!resp.ok || json.code !== 200) {
    throw new Error(
      `kie.ai record-info failed: code=${json.code} msg=${json.msg ?? resp.statusText}`
    );
  }
  const data = json.data ?? {};
  const variants: SunoVariant[] = data.response?.sunoData ?? [];
  return {
    taskId: data.taskId ?? taskId,
    status: data.status ?? "PENDING",
    variants,
  };
}
