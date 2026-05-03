/**
 * Same-origin proxy for kie.ai audio URLs so Web Audio API
 * (MediaElementSource → AnalyserNode) can read sample data without CORS taint.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PREFIXES = [
  "https://musicfile.kie.ai/",
  "https://tempfile.aiquickdraw.com/",
  "https://cdn1.suno.ai/",
  "https://cdn2.suno.ai/",
  "https://cdn3.suno.ai/",
  "https://cdn4.suno.ai/",
];

function isAllowed(u: string): boolean {
  if (ALLOWED_PREFIXES.some((p) => u.startsWith(p))) return true;
  // Allow any cdn*.suno.ai subdomain for forward-compat
  try {
    const url = new URL(u);
    return /^cdn\d*\.suno\.ai$/.test(url.hostname);
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const upstreamUrl = url.searchParams.get("url");
  if (!upstreamUrl) {
    return new Response("missing url", { status: 400 });
  }
  if (!isAllowed(upstreamUrl)) {
    return new Response("forbidden upstream", { status: 403 });
  }

  // Forward Range header so the browser can do byte-range seeks through us
  // (Suno CDN supports it; kie.ai short-stream URLs do not).
  const range = req.headers.get("range");
  const fwdHeaders: Record<string, string> = { Accept: "audio/*,*/*" };
  if (range) fwdHeaders["Range"] = range;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { headers: fwdHeaders });
  } catch (e) {
    return new Response(
      `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      { status: 502 }
    );
  }

  if (!upstream.ok || !upstream.body) {
    return new Response(`upstream ${upstream.status}`, {
      status: upstream.status === 0 ? 502 : upstream.status,
    });
  }

  // Pass through the Range / Length / Accept-Ranges headers so the
  // <audio> element knows the resource is seekable.
  const respHeaders: Record<string, string> = {
    "Content-Type": upstream.headers.get("Content-Type") ?? "audio/mpeg",
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  };
  const cl = upstream.headers.get("Content-Length");
  if (cl) respHeaders["Content-Length"] = cl;
  const cr = upstream.headers.get("Content-Range");
  if (cr) respHeaders["Content-Range"] = cr;
  const ar = upstream.headers.get("Accept-Ranges");
  if (ar) respHeaders["Accept-Ranges"] = ar;

  return new Response(upstream.body, {
    status: upstream.status, // preserves 206 for partial content
    headers: respHeaders,
  });
}
