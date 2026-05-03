import { NextResponse } from "next/server";
import { submitGeneration, type GenerateRequest } from "@/lib/kie";
import type { SunoModel } from "@/lib/types";

const MODELS: ReadonlySet<SunoModel> = new Set([
  "V4",
  "V4_5",
  "V4_5PLUS",
  "V4_5ALL",
  "V5",
  "V5_5",
]);

function clamp01(n: unknown): number | undefined {
  if (typeof n !== "number" || Number.isNaN(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const style = typeof body.style === "string" ? body.style.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const model = typeof body.model === "string" ? (body.model as SunoModel) : "V5_5";

  if (!style) return NextResponse.json({ error: "style required" }, { status: 400 });
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });
  if (!MODELS.has(model)) return NextResponse.json({ error: "invalid model" }, { status: 400 });

  const payload: GenerateRequest = {
    style,
    prompt,
    title,
    model,
    styleWeight: clamp01(body.styleWeight),
    weirdnessConstraint: clamp01(body.weirdnessConstraint),
    audioWeight: clamp01(body.audioWeight),
    negativeTags:
      typeof body.negativeTags === "string" && body.negativeTags.trim()
        ? body.negativeTags.trim()
        : undefined,
    personaId:
      typeof body.personaId === "string" && body.personaId.trim()
        ? body.personaId.trim()
        : undefined,
  };

  try {
    const { taskId } = await submitGeneration(payload);
    return NextResponse.json({ taskId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
