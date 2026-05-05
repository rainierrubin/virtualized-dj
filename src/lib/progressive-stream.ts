"use client";
/**
 * Progressive MP3 streaming via Media Source Extensions.
 *
 * kie.ai's `streamAudioUrl` is served as a chunked progressive MP3:
 * the chunked HTTP response closes when Suno's renderer has emitted
 * everything-so-far, even if the track isn't done. A plain
 * `<audio src=streamAudioUrl>` then thinks the song is over and pins
 * its duration to the partial length — which is the "songs are 25
 * seconds long" bug.
 *
 * This module manages the buffer ourselves:
 *
 *   1. Bind the audio element to a MediaSource (via blob URL).
 *   2. Open a SourceBuffer for `audio/mpeg`.
 *   3. fetch() the stream URL and append each incoming chunk to the
 *      SourceBuffer. The audio element plays continuously off whatever
 *      we've appended.
 *   4. When the HTTP response closes, ask the caller via `isComplete()`
 *      whether more bytes are still coming.
 *   5. If incomplete, poll until complete, then re-fetch the same URL,
 *      skip the bytes we already have, append the rest.
 *   6. `mediaSource.endOfStream()` when truly done.
 *
 * Because we control the buffer, the audio element never sees `ended`
 * mid-track and never reloads — playback is seamless.
 *
 * Caveats:
 *   - kie.ai must serve the same bytes for the same URL across
 *     re-fetches; if it re-encoded between fetches we'd corrupt the
 *     stitched stream. Memory note says it doesn't.
 *   - SourceBuffer for `audio/mpeg` is supported in Chrome/Edge/Firefox
 *     and Safari 14+; older browsers fall back to plain `<audio src>`
 *     via the `onError` callback.
 */

const MIME = "audio/mpeg";
const DEFAULT_POLL_MS = 3000;
const MAX_POLL_MS = 8 * 60_000;

export interface ProgressiveStreamOptions {
  /** The streamAudioUrl (or a proxy that fronts it). */
  url: string;
  audio: HTMLAudioElement;
  /**
   * After the first HTTP response closes, this is polled to learn
   * whether the upstream rendering has finished and a re-fetch will
   * return the full file. Return true when SUCCESS has arrived.
   * Return false to keep waiting.
   */
  isComplete: () => Promise<boolean>;
  /** Polling cadence while waiting for SUCCESS. */
  pollIntervalMs?: number;
  /** Total time to give up after if completion never arrives. */
  maxWaitMs?: number;
  /** Called once per non-fatal error during streaming. */
  onError?: (e: Error) => void;
  /** Called when the full track has been buffered (endOfStream). */
  onDone?: () => void;
}

export interface ProgressiveStreamHandle {
  destroy(): void;
  /** Bytes successfully appended to the SourceBuffer so far. */
  bytesAppended(): number;
  /** Whether MediaSource was supported and the attach succeeded. */
  active(): boolean;
}

export function isMseAudioSupported(): boolean {
  if (typeof MediaSource === "undefined") return false;
  try {
    return MediaSource.isTypeSupported(MIME);
  } catch {
    return false;
  }
}

export function attachProgressiveStream(
  opts: ProgressiveStreamOptions,
): ProgressiveStreamHandle {
  const {
    url,
    audio,
    isComplete,
    pollIntervalMs = DEFAULT_POLL_MS,
    maxWaitMs = MAX_POLL_MS,
    onError,
    onDone,
  } = opts;

  if (!isMseAudioSupported()) {
    // Fall back: caller should bind the URL directly to <audio src>.
    onError?.(new Error("MSE audio/mpeg not supported"));
    return {
      destroy: () => {},
      bytesAppended: () => 0,
      active: () => false,
    };
  }

  let cancelled = false;
  let bytesAppended = 0;
  let mediaSource: MediaSource | null = new MediaSource();
  let sourceBuffer: SourceBuffer | null = null;
  let abortController: AbortController | null = null;
  let blobUrl: string | null = URL.createObjectURL(mediaSource);
  // Pending chunks queue — appendBuffer can only run when sourceBuffer
  // isn't updating, so we serialize through this.
  const queue: Uint8Array[] = [];
  let processing = false;

  audio.src = blobUrl;

  mediaSource.addEventListener("sourceopen", () => {
    if (cancelled || !mediaSource) return;
    try {
      sourceBuffer = mediaSource.addSourceBuffer(MIME);
      sourceBuffer.mode = "sequence";
      sourceBuffer.addEventListener("updateend", drainQueue);
      sourceBuffer.addEventListener("error", () => {
        onError?.(new Error("SourceBuffer error"));
      });
      runStreamingLoop().catch((e) => {
        if (!cancelled) onError?.(e instanceof Error ? e : new Error(String(e)));
      });
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  });

  async function runStreamingLoop(): Promise<void> {
    // Phase 1: fetch the stream URL and append everything we get.
    await fetchAndAppend(0);

    // Phase 2: did kie.ai close the chunked response prematurely?
    // Poll until rendering is complete, then re-fetch from the byte
    // position we left off at and append the remaining tail.
    const t0 = Date.now();
    while (!cancelled) {
      let done = false;
      try {
        done = await isComplete();
      } catch {
        // Transient polling error — continue waiting; the timeout below
        // will eventually break us out.
      }
      if (done) break;
      if (Date.now() - t0 > maxWaitMs) {
        onError?.(new Error("progressive stream: completion poll timed out"));
        break;
      }
      await sleep(pollIntervalMs, () => cancelled);
    }

    if (cancelled) return;

    // Phase 3: re-fetch and append the rest.
    const skip = bytesAppended;
    await fetchAndAppend(skip);

    // Phase 4: signal end-of-stream if we still own the MediaSource.
    if (cancelled) return;
    if (mediaSource && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {
        // ignore — already closed
      }
    }
    onDone?.();
  }

  async function fetchAndAppend(skipBytes: number): Promise<void> {
    if (cancelled) return;
    abortController = new AbortController();
    let response: Response;
    try {
      response = await fetch(url, { signal: abortController.signal });
    } catch (e) {
      if (cancelled) return;
      throw e;
    }
    if (!response.ok || !response.body) {
      throw new Error(`progressive fetch ${url} ${response.status}`);
    }
    const reader = response.body.getReader();
    let totalSeen = 0;
    while (!cancelled) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value;
      const chunkStart = totalSeen;
      totalSeen += chunk.byteLength;
      if (totalSeen <= skipBytes) {
        // Entire chunk is bytes we already have; skip.
        continue;
      }
      let toAppend: Uint8Array = chunk;
      if (chunkStart < skipBytes) {
        // Partial overlap: slice off the duplicate prefix.
        toAppend = chunk.subarray(skipBytes - chunkStart);
      }
      enqueue(toAppend);
      bytesAppended += toAppend.byteLength;
      // Yield so the SourceBuffer drains; otherwise the queue grows
      // unboundedly on slow decoders.
      await waitForDrain();
    }
  }

  function enqueue(chunk: Uint8Array) {
    queue.push(chunk);
    drainQueue();
  }

  function drainQueue() {
    if (cancelled || !sourceBuffer || sourceBuffer.updating) return;
    if (processing) return;
    const next = queue.shift();
    if (!next) return;
    processing = true;
    try {
      // Copy into a fresh ArrayBuffer — appendBuffer's TS signature
      // refuses generic ArrayBufferLike (SharedArrayBuffer-tainted).
      const buf = new ArrayBuffer(next.byteLength);
      new Uint8Array(buf).set(next);
      sourceBuffer.appendBuffer(buf);
    } catch (e) {
      processing = false;
      onError?.(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // updateend listener (registered above) will reset processing.
    sourceBuffer.addEventListener(
      "updateend",
      () => {
        processing = false;
        drainQueue();
      },
      { once: true },
    );
  }

  async function waitForDrain(): Promise<void> {
    // Limit the in-memory queue so we don't hold the entire track in
    // RAM if appendBuffer is slow.
    const MAX_QUEUE = 32;
    while (!cancelled && queue.length > MAX_QUEUE) {
      await sleep(20, () => cancelled);
    }
  }

  function destroy() {
    if (cancelled) return;
    cancelled = true;
    try {
      abortController?.abort();
    } catch {
      // ignore
    }
    if (mediaSource && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {
        // ignore
      }
    }
    try {
      if (audio.src.startsWith("blob:")) {
        audio.removeAttribute("src");
        audio.load();
      }
    } catch {
      // ignore
    }
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
    }
    blobUrl = null;
    mediaSource = null;
    sourceBuffer = null;
  }

  return {
    destroy,
    bytesAppended: () => bytesAppended,
    active: () => true,
  };
}

function sleep(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (isCancelled()) return resolve();
      if (Date.now() - start >= ms) return resolve();
      setTimeout(tick, Math.min(100, ms));
    };
    tick();
  });
}
