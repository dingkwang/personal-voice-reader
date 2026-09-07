import { z } from "zod";
import { database, ownerLock } from "./db";
import { putAudio } from "./blob";
import { AppError } from "./errors";
import { insertDocument } from "./store";
import type { ReaderDocument, StoreData, Voice } from "./types";

const voiceSchema = z.object({ id: z.string().min(1), name: z.string(), provider: z.enum(["fish", "elevenlabs", "minimax", "local"]),
  providerVoiceId: z.string().nullable(), language: z.string(), createdAt: z.string(), source: z.enum(["default", "cloned", "linked"]) });
const segmentSchema = z.object({ id: z.string().min(1), documentId: z.string(), index: z.number().int(), text: z.string(),
  status: z.enum(["idle", "ready", "error"]), audioHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  audioUrl: z.string().nullable(), voiceId: z.string().nullable(), speed: z.number().nullable() });
const legacySchema = z.object({
  voices: z.array(voiceSchema),
  documents: z.array(z.object({ id: z.string().min(1), title: z.string(), originalText: z.string(), createdAt: z.string(), segments: z.array(segmentSchema) })),
  audioCache: z.record(z.string().regex(/^[a-f0-9]{64}$/), z.string()),
});
export async function importLegacy(input: unknown, owner: string, readAudio: (key: string) => Promise<ArrayBuffer>,
  persist: typeof putAudio = putAudio) {
  const data: StoreData = legacySchema.parse(input);
  const counts = {
    voices: data.voices.length, documents: data.documents.length,
    segments: data.documents.reduce((n, doc) => n + doc.segments.length, 0),
  };
  if (new Set(data.voices.map((v) => v.id)).size !== counts.voices ||
    new Set(data.documents.map((d) => d.id)).size !== counts.documents ||
    new Set(data.documents.flatMap((d) => d.segments.map((s) => s.id))).size !== counts.segments) throw new AppError("旧数据包含重复 ID", 422);
  await database().transaction(async (db) => {
    await ownerLock(db, owner);
    for (const voice of data.voices) {
      const { rows } = await db.query<{ data: Voice }>("SELECT data FROM voices WHERE owner=$1 AND id=$2", [owner, voice.id]);
      if (rows[0] && JSON.stringify(voiceSchema.parse(rows[0].data)) !== JSON.stringify(voiceSchema.parse(voice))) throw new AppError("声音 ID 冲突，已停止导入", 409);
      await db.query("INSERT INTO voices(owner,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [owner, voice.id, voice]);
    }
    for (const document of data.documents) {
      if (document.segments.some((s) => s.documentId !== document.id)) throw new AppError("旧段落关联无效", 422);
      const { rows } = await db.query<{ data: Omit<ReaderDocument, "segments"> }>("SELECT data FROM documents WHERE owner=$1 AND id=$2", [owner, document.id]);
      if (!rows.length) await insertDocument(document, owner, db);
      else {
        const value = rows[0].data;
        if (value.title !== document.title || value.originalText !== document.originalText || value.createdAt !== document.createdAt) throw new AppError("会话 ID 冲突，已停止导入", 409);
        const segments = await db.query<{ data: ReaderDocument["segments"][number] }>("SELECT data FROM segments WHERE owner=$1 AND document_id=$2 ORDER BY position", [owner, document.id]);
        if (JSON.stringify(segments.rows.map(({ data: s }) => [s.id, s.text, s.index])) !== JSON.stringify(document.segments.map((s) => [s.id, s.text, s.index]))) throw new AppError("段落 ID 冲突，已停止导入", 409);
      }
    }
  });
  const keys = [...new Set([...Object.keys(data.audioCache), ...data.documents.flatMap((d) => d.segments.flatMap((s) => s.audioHash ? [s.audioHash] : []))])];
  for (const key of keys) {
    const bytes = await readAudio(key);
    const audio = await persist(owner, bytes);
    await database().transaction(async (db) => {
      const prior = await db.query<{ object_hash: string; size: number }>("SELECT object_hash,size FROM audio_cache WHERE owner=$1 AND key=$2", [owner, key]);
      if (prior.rows[0] && (prior.rows[0].object_hash !== audio.objectHash || prior.rows[0].size !== audio.size)) throw new AppError("音频校验不匹配，已停止导入", 409);
      await db.query("INSERT INTO audio_cache(owner,key,object_hash,pathname,size,legacy) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING", [owner, key, audio.objectHash, audio.pathname, audio.size]);
      for (const document of data.documents) for (const segment of document.segments) {
        if (segment.audioHash === key) await db.query("INSERT INTO audio_versions(owner,segment_id,key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [owner, segment.id, key]);
      }
    });
  }
  const [{ rows: voices }, { rows: docs }, { rows: segments }, { rows: audio }] = await Promise.all([
    database().query("SELECT id FROM voices WHERE owner=$1 AND id=ANY($2::text[])", [owner, data.voices.map((v) => v.id)]),
    database().query("SELECT id FROM documents WHERE owner=$1 AND id=ANY($2::text[])", [owner, data.documents.map((d) => d.id)]),
    database().query("SELECT id FROM segments WHERE owner=$1 AND id=ANY($2::text[])", [owner, data.documents.flatMap((d) => d.segments.map((s) => s.id))]),
    database().query("SELECT key FROM audio_cache WHERE owner=$1 AND key=ANY($2::text[])", [owner, keys]),
  ]);
  if (voices.length !== counts.voices || docs.length !== counts.documents || segments.length !== counts.segments || audio.length !== keys.length) throw new AppError("迁移计数校验失败", 409);
  return { ...counts,
    audio: keys.length, idsPreserved: true, hashesVerified: true };
}
