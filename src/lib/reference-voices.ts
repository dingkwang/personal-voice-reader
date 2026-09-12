import { randomUUID } from "node:crypto";
import { get, head, put } from "@vercel/blob";
import { z } from "zod";
import { database, ownerLock } from "./db";
import { ownerPrefix, sha256 } from "./blob";
import { AppError } from "./errors";
import { addVoice, findVoice } from "./store";
import { boundedBytes, normalizeReference } from "./providers/indextts";
import { providerReady } from "./tts-config";
import type { Voice } from "./types";

export const referenceVoiceSchema = z.object({
  provider: z.literal("indextts"), name: z.string().trim().min(1).max(60),
  language: z.enum(["zh", "en", "ja", "es", "ar"]).default("zh"), consent: z.literal(true),
  uploadIds: z.array(z.string().uuid()).length(1), idempotencyKey: z.string().uuid(),
  makeDefault: z.boolean().default(true),
});
export async function registerReferenceVoice(input: z.infer<typeof referenceVoiceSchema>, owner: string) {
  providerReady("indextts");
  const db = database();
  const hash = sha256(JSON.stringify(input));
  const prior = await db.query<{ request_hash: string; voice_id: string }>("SELECT request_hash,voice_id FROM clone_requests WHERE owner=$1 AND id=$2", [owner, input.idempotencyKey]);
  if (prior.rows[0]) {
    if (prior.rows[0].request_hash !== hash || !prior.rows[0].voice_id) throw new AppError("此请求标识已使用", 409);
    return findVoice(prior.rows[0].voice_id, owner);
  }
  const { rows } = await db.query<{ pathname: string; size: number; content_type: string }>(
    "SELECT pathname,size,content_type FROM uploads WHERE owner=$1 AND id=$2 AND NOT used AND expires_at>now()", [owner, input.uploadIds[0]]);
  const upload = rows[0];
  if (!upload || !upload.pathname.startsWith(`uploads/${ownerPrefix(owner)}/`)) throw new AppError("录音无效或已过期", 422);
  const meta = await head(upload.pathname);
  if (meta.size !== upload.size || meta.contentType !== upload.content_type) throw new AppError("录音大小或类型不符", 422);
  const source = await get(upload.pathname, { access: "private" });
  if (!source?.stream) throw new AppError("录音尚未上传完成", 422);
  const raw = await boundedBytes(new Response(source.stream), 20 * 1024 * 1024);
  if (raw.length !== upload.size) throw new AppError("录音大小不符", 422);
  const normalized = await normalizeReference(raw);
  const pathname = `references/${ownerPrefix(owner)}/${normalized.hash}.wav`;
  try { await put(pathname, normalized.bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "audio/wav" }); }
  catch (error) {
    const existing = await get(pathname, { access: "private" }).catch(() => null);
    if (!existing?.stream || sha256(await boundedBytes(new Response(existing.stream), 2_700_000)) !== normalized.hash) throw error;
  }
  return db.transaction(async (tx) => {
    await ownerLock(tx, owner);
    const repeated = await tx.query<{ request_hash: string; voice_id: string }>("SELECT request_hash,voice_id FROM clone_requests WHERE owner=$1 AND id=$2", [owner, input.idempotencyKey]);
    if (repeated.rows[0]) {
      if (repeated.rows[0].request_hash !== hash || !repeated.rows[0].voice_id) throw new AppError("此请求标识已使用", 409);
      return findVoice(repeated.rows[0].voice_id, owner, tx);
    }
    const claimed = await tx.query("UPDATE uploads SET used=true WHERE owner=$1 AND id=$2 AND NOT used AND expires_at>now() RETURNING id", [owner, input.uploadIds[0]]);
    if (!claimed.rows.length) throw new AppError("录音已使用或过期", 409);
    const voice: Voice = { id: `voice_${randomUUID()}`, name: input.name, provider: "indextts", providerVoiceId: normalized.hash,
      language: input.language, createdAt: new Date().toISOString(), source: "cloned",
      reference: { pathname, hash: normalized.hash, size: normalized.bytes.length, seconds: normalized.seconds } };
    await addVoice(voice, owner, tx);
    await tx.query("INSERT INTO clone_requests(owner,id,request_hash,status,voice_id) VALUES($1,$2,$3,'completed',$4)", [owner, input.idempotencyKey, hash, voice.id]);
    if (input.makeDefault) await tx.query(`INSERT INTO reader_preferences(owner,web_voice_id) VALUES($1,$2)
      ON CONFLICT(owner) DO UPDATE SET web_voice_id=excluded.web_voice_id`, [owner, voice.id]);
    return voice;
  });
}
