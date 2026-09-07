import { createHash } from "node:crypto";
import { get, head, put } from "@vercel/blob";
import { AppError } from "./errors";

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const ownerPrefix = (owner: string) => sha256(owner).slice(0, 32);

export async function putAudio(owner: string, audio: ArrayBuffer) {
  const objectHash = sha256(new Uint8Array(audio));
  const pathname = `audio/${ownerPrefix(owner)}/${objectHash}.mp3`;
  try {
    await put(pathname, audio, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "audio/mpeg" });
  } catch (error) {
    // Blob's "already exists" errors are not a dedicated SDK class. Confirm the
    // immutable object after any ambiguous PUT instead of overwriting it.
    const existing = await head(pathname).catch(() => null);
    if (!existing || existing.size !== audio.byteLength || existing.contentType !== "audio/mpeg") throw error;
  }
  return { objectHash, pathname, size: audio.byteLength };
}

export function parseRange(range: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";
  const first = Number(match[1]), last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return "invalid";
  if (!match[1]) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : "invalid";
  const end = match[2] ? Math.min(last, size - 1) : size - 1;
  return first <= end && first < size ? { start: first, end } : "invalid";
}

export async function streamAudio(request: Request, audio: { pathname: string; size: number; object_hash: string }) {
  const etag = `"${audio.object_hash}"`;
  const range = parseRange(!request.headers.has("if-range") || request.headers.get("if-range") === etag ? request.headers.get("range") : null, audio.size);
  const headers = new Headers({
    "Accept-Ranges": "bytes", "Cache-Control": "private, no-store", "Content-Type": "audio/mpeg",
    "X-Content-Type-Options": "nosniff", ETag: etag,
  });
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${audio.size}`);
    return new Response(null, { status: 416, headers });
  }
  const upstream = await get(audio.pathname, {
    access: "private", abortSignal: request.signal,
    ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
  });
  if (!upstream?.stream) throw new AppError("音频暂时不可用", 404, "AUDIO_NOT_FOUND");
  // SDK reports 200 even for upstream 206; verify the actual Content-Range.
  if (range) {
    const expected = `bytes ${range.start}-${range.end}/${audio.size}`;
    if (upstream.headers.get("content-range") !== expected) {
      await upstream.stream.cancel();
      throw new AppError("音频服务暂不支持此范围", 502, "INVALID_AUDIO_RANGE");
    }
    headers.set("Content-Range", expected);
  }
  headers.set("Content-Length", String(range ? range.end - range.start + 1 : audio.size));
  return new Response(upstream.stream, { status: range ? 206 : 200, headers });
}
