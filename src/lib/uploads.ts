import { randomUUID } from "node:crypto";
import { get, head } from "@vercel/blob";
import { z } from "zod";
import { database, ownerLock } from "./db";
import { ownerPrefix, sha256 } from "./blob";
import { AppError } from "./errors";
import { getVoiceProvider } from "./providers";
import { addVoice, findVoice } from "./store";
import type { Voice } from "./types";

export const uploadSchema = z.object({
  contentType: z.enum(["audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/aac", "audio/flac", "audio/x-m4a"]),
  size: z.number().int().min(1).max(20 * 1024 * 1024),
});
export async function reserveUpload(input: z.infer<typeof uploadSchema>, owner: string) {
  return database().transaction(async (db) => {
    await ownerLock(db, owner);
    const { rows } = await db.query<{ count: string; total: string }>("SELECT count(*),COALESCE(sum(size),0) AS total FROM uploads WHERE owner=$1 AND expires_at>now() AND NOT used", [owner]);
    if (Number(rows[0].count) >= 20 || Number(rows[0].total) + input.size > 100 * 1024 * 1024) throw new AppError("录音上传配额已满，十分钟后重试", 429);
    const id = randomUUID();
    const pathname = `uploads/${ownerPrefix(owner)}/${id}`;
    await db.query("INSERT INTO uploads(owner,id,pathname,content_type,size,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')", [owner, id, pathname, input.contentType, input.size]);
    return { id, pathname };
  });
}
type Upload = { id: string; pathname: string; content_type: string; size: number; expires_at: Date };
export async function uploadPermission(id: string, pathname: string, owner: string) {
  const { rows } = await database().query<Upload>("SELECT * FROM uploads WHERE owner=$1 AND id=$2 AND pathname=$3 AND NOT used AND expires_at>now()", [owner, id, pathname]);
  if (!rows[0] || !pathname.startsWith(`uploads/${ownerPrefix(owner)}/`)) throw new AppError("无效的录音上传授权", 403);
  return { allowedContentTypes: [rows[0].content_type], maximumSizeInBytes: rows[0].size,
    validUntil: new Date(rows[0].expires_at).getTime(), addRandomSuffix: false, allowOverwrite: false };
}
export const cloneSchema = z.object({
  name: z.string().trim().min(1).max(60), language: z.string().min(2).max(20).default("zh"),
  consent: z.literal(true), uploadIds: z.array(z.string().uuid()).min(1).max(20),
  idempotencyKey: z.string().uuid(),
});
export async function cloneUploadedVoice(input: z.infer<typeof cloneSchema>, owner: string) {
  const requestHash = sha256(JSON.stringify(input));
  const reservation = await database().transaction(async (db) => {
    await ownerLock(db, owner);
    const prior = await db.query<{ request_hash: string; voice_id: string | null }>("SELECT * FROM clone_requests WHERE owner=$1 AND id=$2", [owner, input.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new AppError("此请求标识已使用", 409);
      if (prior.rows[0].voice_id) return { voice: await findVoice(prior.rows[0].voice_id, owner, db), uploads: [] };
      throw new AppError("克隆请求已提交，结果可能已产生。请检查 Fish 后连接已有 ID，不要重复克隆。", 409, "CLONE_UNCERTAIN");
    }
    const uploads = await db.query<Upload>("SELECT * FROM uploads WHERE owner=$1 AND id=ANY($2::text[]) AND NOT used AND expires_at>now()", [owner, input.uploadIds]);
    if (uploads.rows.length !== input.uploadIds.length || uploads.rows.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) throw new AppError("录音无效、重复或已过期", 422);
    await db.query("INSERT INTO clone_requests(owner,id,request_hash,status) VALUES($1,$2,$3,'submitted')", [owner, input.idempotencyKey, requestHash]);
    await db.query("UPDATE uploads SET used=true WHERE owner=$1 AND id=ANY($2::text[])", [owner, input.uploadIds]);
    return { voice: null, uploads: uploads.rows };
  });
  if (reservation.voice) return reservation.voice;
  const audio: File[] = [];
  // Sequential, bounded reads of owned private objects. Never fetch input URLs.
  for (const file of reservation.uploads) {
    if (!file.pathname.startsWith(`uploads/${ownerPrefix(owner)}/`)) throw new AppError("录音不属于此用户", 403);
    const metadata = await head(file.pathname);
    if (metadata.size !== file.size || metadata.contentType !== file.content_type) throw new AppError("录音类型或大小不匹配", 422);
    const blob = await get(file.pathname, { access: "private" });
    if (!blob?.stream) throw new AppError("录音尚未上传完成", 422);
    audio.push(new File([await new Response(blob.stream).arrayBuffer()], `recording-${file.id}`, { type: file.content_type }));
  }
  const cloned = await getVoiceProvider("fish").cloneVoice({ name: input.name, audio });
  const voice: Voice = { id: `voice_${randomUUID()}`, name: input.name, language: input.language,
    provider: "fish", providerVoiceId: cloned.providerVoiceId, source: "cloned", createdAt: new Date().toISOString() };
  await database().transaction(async (db) => {
    await addVoice(voice, owner, db);
    await db.query("UPDATE clone_requests SET status='completed',voice_id=$3 WHERE owner=$1 AND id=$2", [owner, input.idempotencyKey, voice.id]);
  });
  return voice;
}
