import { get } from "@vercel/blob";
import { z } from "zod";
import { database } from "../db";
import { ownerPrefix, sha256 } from "../blob";
import { indexTtsConfig } from "../tts-config";
import { AppError } from "../errors";
import type { Generation } from "../jobs";

export async function boundedBytes(response: Response, maximum: number) {
  if (Number(response.headers.get("content-length")) > maximum) throw new AppError("音频超过大小限制", 422);
  const reader = response.body?.getReader();
  if (!reader) throw new AppError("音频内容为空", 422);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) throw new AppError("音频超过大小限制", 422);
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}
export async function indexRequest(path: string, init?: RequestInit) {
  const config = indexTtsConfig();
  return fetch(`${config.url}${path}`, { ...init, headers: {
    ...Object.fromEntries(new Headers(init?.headers)), "Modal-Key": config.key, "Modal-Secret": config.secret,
  }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30_000) });
}
export async function normalizeReference(audio: Uint8Array) {
  const response = await indexRequest("/normalize", { method: "POST", body: new Uint8Array(audio), headers: { "Content-Type": "application/octet-stream" } });
  if (!response.ok) throw new AppError(response.status === 422 ? "请上传 10–60 秒清晰人声录音" : "参考录音服务暂时不可用", response.status === 422 ? 422 : 502);
  const bytes = await boundedBytes(response, 2_700_000);
  const seconds = Number(response.headers.get("x-audio-seconds"));
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 60 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new AppError("参考录音返回格式错误", 502);
  }
  return { bytes, seconds, hash: sha256(bytes) };
}
const statusSchema = z.object({ status: z.enum(["pending", "dispatching", "queued", "running", "ready", "error", "uncertain", "collected"]) });
export class IndexTtsProvider {
  async poll(claim: Generation): Promise<{ status: "pending" | "error" | "uncertain" } | { status: "ready"; audio: ArrayBuffer }> {
    const settings = claim.job.synthesis;
    if (!settings?.reference) throw new AppError("缺少参考录音", 422);
    const owner = ownerPrefix(claim.owner);
    const db = database();
    const existing = await db.query("SELECT id FROM indextts_requests WHERE owner=$1 AND id=$2", [owner, claim.attempt]);
    if (!existing.rows.length) {
      const ref = settings.reference;
      if (!ref.pathname.startsWith(`references/${owner}/`)) throw new AppError("参考录音不属于此用户", 403);
      const result = await get(ref.pathname, { access: "private" });
      if (!result?.stream) throw new AppError("参考录音不存在", 422);
      const bytes = await boundedBytes(new Response(result.stream), 2_700_000);
      if (bytes.length !== ref.size || sha256(bytes) !== ref.hash) throw new AppError("参考录音校验失败", 422);
      await db.query(`INSERT INTO indextts_requests(owner,id,payload,reference) VALUES($1,$2,$3,$4)
        ON CONFLICT(owner,id) DO NOTHING`, [owner, claim.attempt, {
        text: claim.segment.text, speed: claim.job.speed, model: settings.model, language: settings.language,
        reference_hash: ref.hash,
      }, bytes]);
    }
    // POST claims the persistent request once. Retrying the same ID never starts a second inference.
    const response = await indexRequest(`/requests/${owner}/${claim.attempt}`, { method: "POST" });
    if (!response.ok) throw new AppError("IndexTTS 暂时不可用，正在重连", 502);
    const { status } = statusSchema.parse(await response.json());
    if (status === "ready") {
      const output = await indexRequest(`/requests/${owner}/${claim.attempt}/audio`);
      if (!output.ok || output.headers.get("content-type")?.split(";")[0] !== "audio/mpeg") throw new AppError("音频暂未取回，正在重连", 502);
      const bytes = await boundedBytes(output, 16 * 1024 * 1024);
      if (bytes.length < 3 || !(bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) throw new AppError("音频格式无效", 502);
      return { status: "ready", audio: new Uint8Array(bytes).buffer };
    }
    if (status === "error") return { status: "error" };
    if (status === "uncertain" || status === "collected") return { status: "uncertain" };
    return { status: "pending" };
  }
}
