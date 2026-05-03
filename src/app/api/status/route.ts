import { NextResponse } from "next/server";
import { getTaskRecord } from "@/lib/kie";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId");
  if (!taskId) {
    return NextResponse.json({ error: "taskId required" }, { status: 400 });
  }
  try {
    const record = await getTaskRecord(taskId);
    return NextResponse.json(record);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
