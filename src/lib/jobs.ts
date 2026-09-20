import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, ownerLock, type Database } from "./db";
import { appOrigin, ownerSubject, required } from "./config";
import { AppError } from "./errors";
import { documentSchema, makeDocument } from "./documents";
import { findDocument, findSegment, findVoice, insertDocument } from "./store";
import { providerReady, synthesisSettings } from "./tts-config";
import { audioKey, stableJson } from "./audio-key";
import { sha256 } from "./blob";
import { requireReplicateCapacity } from "./replicate-quota";
import type { JobStatus, ReadingJob, Segment, Voice } from "./types";

export const createReadingSchema = documentSchema.extend({
  voice_id: z.string().min(1).max(120).optional(),
  speed: z.number().min(0.5).max(2).default(1),
  idempotency_key: z.string().min(8).max(160),
});
export const queueSchema = z.object({
  documentId: z.string().min(5).max(100),
  voiceId: z.string().min(5).max(120),
  speed: z.number().min(0.5).max(2).default(1),
  idempotencyKey: z.string().min(8).max(160),
});
type QueueInput = z.infer<typeof queueSchema>;
type CreateInput = z.infer<typeof createReadingSchema>;

export const regenerateSchema = z.object({
  scope: z.enum(["segment", "all"]),
  segmentId: z.string().min(5).max(100).optional(),
  sourceJobId: z.string().min(5).max(100).nullable(),
  voiceId: z.string().min(5).max(120),
  speed: z.number().min(0.5).max(2),
  idempotencyKey: z.string().min(8).max(160),
  acknowledgeBilling: z.literal(true),
}).strict().refine((input) => input.scope === "segment" ? Boolean(input.segmentId) : input.segmentId === undefined,
  "仅单段重新生成需要 segmentId");
export type RegenerateInput = z.infer<typeof regenerateSchema>;

// The request hash namespace distinguishes intentional regeneration without
// adding columns or mixing operation metadata into synthesis settings.
export async function regenerateDocument(documentId: string, input: RegenerateInput, owner: string) {
  return database().transaction(async (db) => {
    await ownerLock(db, owner);
    const requestHash = `regenerate:${sha256(stableJson({ documentId, ...input }))}`;
    const prior = await db.query<{ id: string; document_id: string; request_hash: string }>(
      "SELECT j.id,j.document_id,r.request_hash FROM job_requests r JOIN jobs j ON j.owner=r.owner AND j.id=r.job_id WHERE r.owner=$1 AND r.key=$2",
      [owner, input.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new AppError("幂等键已用于不同内容", 409, "IDEMPOTENCY_CONFLICT");
      return { jobId: prior.rows[0].id, documentId: prior.rows[0].document_id };
    }
    const document = await findDocument(documentId, owner, db);
    const source = (await db.query<ReadingJob>(
      "SELECT * FROM jobs WHERE owner=$1 AND document_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [owner, documentId])).rows[0];
    const saved = source ? { voiceId: source.voice_id, speed: source.speed } : document.segments.find((item) => item.status === "ready");
    if ((source?.id || null) !== input.sourceJobId || !saved?.voiceId || saved.voiceId !== input.voiceId || saved.speed !== input.speed) {
      throw new AppError("会话或声音设置已变化，请重新打开会话后确认", 409, "SETTINGS_CONFLICT");
    }
    if (input.scope === "segment" && !document.segments.some((item) => item.id === input.segmentId)) {
      throw new AppError("找不到这个会话段落", 404, "SEGMENT_NOT_FOUND");
    }
    const unsafe = await db.query(`SELECT 1 FROM jobs j WHERE j.owner=$1 AND j.document_id=$2 AND (
      j.status IN ('queued','running') OR EXISTS(SELECT 1 FROM job_items i WHERE i.owner=j.owner AND i.job_id=j.id
        AND i.status IN ('queued','working','uncertain')) OR EXISTS(SELECT 1 FROM generation_claims c WHERE c.owner=j.owner AND c.job_id=j.id)) LIMIT 1`,
      [owner, documentId]);
    if (unsafe.rows.length) throw new AppError("存在未完成或结果不确定的请求，请先处理原任务，避免重复计费", 409, "GENERATION_CONFLICT");
    const voice = await findVoice(saved.voiceId, owner, db);
    const synthesis = source?.synthesis || { ...synthesisSettings(voice), ...(source ? { model: source.model } : {}) };
    providerReady(synthesis.provider);
    if (synthesis.provider === "replicate" && saved.speed !== 1) throw new AppError("IndexTTS 2 当前使用自然语速 1×", 422);
    const id = `job_${randomUUID()}`;
    const items = document.segments.map((segment) => ({
      segment, regenerate: input.scope === "all" || segment.id === input.segmentId,
      key: sha256(stableJson({ regeneration: id, segment: segment.id, synthesis, speed: saved.speed })),
    }));
    for (const item of items) {
      if (item.regenerate) continue;
      const segment = item.segment;
      const version = await db.query("SELECT 1 FROM audio_versions WHERE owner=$1 AND segment_id=$2 AND key=$3",
        [owner, segment.id, segment.audioHash]);
      if (segment.status !== "ready" || segment.voiceId !== saved.voiceId || segment.speed !== saved.speed || !version.rows.length) {
        throw new AppError("其他段落尚无当前设置的音频，请先完成原任务或重新生成整篇", 409, "AUDIO_NOT_READY");
      }
      item.key = segment.audioHash!;
    }
    if (synthesis.provider === "replicate") await requireReplicateCapacity(db, owner, items.filter((item) => item.regenerate).map((item) => item.key));
    const count = await db.query<{ count: string }>("SELECT count(*) FROM jobs WHERE owner=$1 AND status IN ('queued','running')", [owner]);
    if (Number(count.rows[0].count) >= 10) throw new AppError("队列已满，请等待现有任务完成", 429, "QUEUE_FULL");
    await db.query(`INSERT INTO jobs(owner,id,document_id,idempotency_key,request_hash,voice_id,speed,model,synthesis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [owner, id, documentId, input.idempotencyKey, requestHash, saved.voiceId, saved.speed, synthesis.model, synthesis]);
    await db.query("INSERT INTO job_requests(owner,key,request_hash,job_id) VALUES($1,$2,$3,$4)", [owner, input.idempotencyKey, requestHash, id]);
    for (const item of items) {
      await db.query("INSERT INTO job_items(owner,job_id,segment_id,position,key,status) VALUES($1,$2,$3,$4,$5,$6)",
        [owner, id, item.segment.id, item.segment.index, item.key, item.regenerate ? "queued" : "ready"]);
      await db.query("UPDATE segments SET desired_job=$3 WHERE owner=$1 AND id=$2", [owner, item.segment.id, id]);
    }
    return { jobId: id, documentId };
  });
}

export async function createReading(input: CreateInput, owner: string) {
  // Only MCP's original owner retains the configured default. Web generation
  // requires an explicitly selected, owned voice through queueDocument.
  const voiceId = input.voice_id || (owner === ownerSubject() ? required("DEFAULT_VOICE_ID") : "");
  if (!voiceId) throw new AppError("请先添加并选择自己的声音", 422, "VOICE_REQUIRED");
  return enqueue({ ...input, voiceId, idempotencyKey: input.idempotency_key }, owner);
}
export async function queueDocument(input: QueueInput, owner: string) {
  return enqueue(input, owner);
}
async function enqueue(input: QueueInput | (CreateInput & { voiceId: string; idempotencyKey: string }), owner: string) {
  return database().transaction(async (db) => {
    await ownerLock(db, owner);
    const voice = await findVoice(input.voiceId, owner, db);
    if (voice.provider === "replicate" && input.speed !== 1) throw new AppError("IndexTTS 2 当前使用自然语速 1×", 422);
    const prior = await db.query<ReadingJob & { request_hash: string }>(
      "SELECT j.*,r.request_hash FROM job_requests r JOIN jobs j ON j.owner=r.owner AND j.id=r.job_id WHERE r.owner=$1 AND r.key=$2", [owner, input.idempotencyKey]);
    const synthesis = prior.rows[0]?.synthesis || synthesisSettings(voice);
    const model = prior.rows[0]?.model || synthesis.model;
    const requestHash = sha256((["indextts", "replicate"].includes(synthesis.provider) ? stableJson : JSON.stringify)({
      document: "documentId" in input ? input.documentId : { text: input.text, title: input.title || "" },
      voiceId: input.voiceId, speed: input.speed, model,
      ...(["indextts", "replicate"].includes(synthesis.provider) ? { synthesis } : {}),
    }));
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new AppError("幂等键已用于不同内容", 409, "IDEMPOTENCY_CONFLICT");
      return { jobId: prior.rows[0].id, documentId: prior.rows[0].document_id };
    }
    const document = "documentId" in input ? await findDocument(input.documentId, owner, db) : await insertDocument(makeDocument(input), owner, db);
    // Reconnects/settings toggles may create fresh request IDs: coalesce an active
    // identical task while preserving explicit new snapshots.
    const active = await db.query<ReadingJob>(
      "SELECT * FROM jobs WHERE owner=$1 AND document_id=$2 AND voice_id=$3 AND speed=$4 AND model=$5 AND status IN ('queued','running') AND (synthesis=$6::jsonb OR (synthesis IS NULL AND $7='fish')) LIMIT 1",
      [owner, document.id, voice.id, input.speed, model, synthesis, voice.provider]);
    if (active.rows[0]) {
      await db.query("INSERT INTO job_requests(owner,key,request_hash,job_id) VALUES($1,$2,$3,$4)", [owner, input.idempotencyKey, requestHash, active.rows[0].id]);
      return { jobId: active.rows[0].id, documentId: document.id };
    }
    const count = await db.query<{ count: string }>("SELECT count(*) FROM jobs WHERE owner=$1 AND status IN ('queued','running')", [owner]);
    if (Number(count.rows[0].count) >= 10) throw new AppError("队列已满，请等待现有任务完成", 429, "QUEUE_FULL");
    const id = `job_${randomUUID()}`;
    await db.query(`INSERT INTO jobs(owner,id,document_id,idempotency_key,request_hash,voice_id,speed,model,synthesis)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [owner, id, document.id, input.idempotencyKey, requestHash, voice.id, input.speed, model, synthesis]);
    await db.query("INSERT INTO job_requests(owner,key,request_hash,job_id) VALUES($1,$2,$3,$4)", [owner, input.idempotencyKey, requestHash, id]);
    const planned: { segment: Segment; key: string; cached: boolean }[] = [];
    for (const segment of document.segments) {
      let key = ["indextts", "replicate"].includes(voice.provider)
        ? sha256(stableJson({ version: 2, synthesis, text: segment.text, speed: input.speed }))
        : audioKey({ provider: voice.provider, providerVoiceId: voice.providerVoiceId, text: segment.text, model, speed: input.speed });
      // Ordinary playback must not restore the base cache over a selected regeneration.
      if (segment.audioHash && segment.voiceId === voice.id && segment.speed === input.speed) {
        const selected = await db.query(`SELECT 1 FROM audio_versions v
          JOIN job_items i ON i.owner=v.owner AND i.segment_id=v.segment_id AND i.key=v.key
          JOIN jobs j ON j.owner=i.owner AND j.id=i.job_id
          WHERE v.owner=$1 AND v.segment_id=$2 AND v.key=$3 AND i.status='ready'
          AND j.voice_id=$4 AND j.speed=$5 AND j.model=$6
          AND (j.synthesis=$7::jsonb OR (j.synthesis IS NULL AND $8='fish')) LIMIT 1`,
          [owner, segment.id, segment.audioHash, voice.id, input.speed, model, synthesis, voice.provider]);
        if (selected.rows.length) key = segment.audioHash;
      }
      const cache = await db.query("SELECT 1 FROM audio_cache WHERE owner=$1 AND key=$2", [owner, key]);
      planned.push({ segment, key, cached: cache.rows.length > 0 });
    }
    if (voice.provider === "replicate") await requireReplicateCapacity(db, owner, planned.filter((item) => !item.cached).map((item) => item.key));
    for (const { segment, key } of planned) {
      await db.query("INSERT INTO job_items(owner,job_id,segment_id,position,key) VALUES($1,$2,$3,$4,$5)", [owner, id, segment.id, segment.index, key]);
      await db.query("UPDATE segments SET desired_job=$3 WHERE owner=$1 AND id=$2", [owner, segment.id, id]);
    }
    return { jobId: id, documentId: document.id };
  });
}

export async function readingStatus(id: string, owner: string): Promise<JobStatus> {
  const db = database();
  const { rows } = await db.query<ReadingJob & { regeneration: boolean }>("SELECT id,document_id,voice_id,speed,model,status,run_id,request_hash LIKE 'regenerate:%' AS regeneration FROM jobs WHERE owner=$1 AND id=$2", [owner, id]);
  if (!rows[0]) throw new AppError("找不到这个任务", 404, "JOB_NOT_FOUND");
  const items = await db.query<{ segment_id: string; status: Segment["status"]; error: string | null; key: string }>(
    "SELECT segment_id,status,error,key FROM job_items WHERE owner=$1 AND job_id=$2 ORDER BY position", [owner, id]);
  return { ...rows[0], items: items.rows.map((item) => ({
    segment_id: item.segment_id, status: item.status, error: item.error,
    audioUrl: item.status === "ready" ? `/api/audio/${item.segment_id}?v=${item.key}` : null,
  })), url: `${appOrigin()}/sessions/${rows[0].document_id}` };
}

export async function latestJob(documentId: string, owner: string) {
  const { rows } = await database().query<{ id: string }>(
    "SELECT id FROM jobs WHERE owner=$1 AND document_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [owner, documentId]);
  return rows[0] ? readingStatus(rows[0].id, owner) : null;
}

export async function settleJob(db: Database, owner: string, jobId: string) {
  await db.query(`UPDATE jobs SET status=CASE
    WHEN EXISTS(SELECT 1 FROM job_items WHERE owner=$1 AND job_id=$2 AND status IN ('queued','working')) THEN 'running'
    WHEN EXISTS(SELECT 1 FROM job_items WHERE owner=$1 AND job_id=$2 AND status IN ('error','uncertain')) THEN 'attention'
    ELSE 'completed' END, updated_at=now() WHERE owner=$1 AND id=$2`, [owner, jobId]);
}

async function attach(db: Database, owner: string, job: ReadingJob, segmentId: string, key: string) {
  await db.query("INSERT INTO audio_versions(owner,segment_id,key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [owner, segmentId, key]);
  await db.query("UPDATE job_items SET status='ready',error=NULL WHERE owner=$1 AND job_id=$2 AND segment_id=$3", [owner, job.id, segmentId]);
  await db.query(`UPDATE segments SET data=data || $4::jsonb WHERE owner=$1 AND id=$2 AND desired_job=$3`,
    [owner, segmentId, job.id, JSON.stringify({ status: "ready", audioHash: key, audioUrl: `/api/audio/${segmentId}?v=${key}`, voiceId: job.voice_id, speed: job.speed })]);
}

export type Generation = { attempt: string; key: string; segment: Segment; voice: Voice; job: ReadingJob; owner: string };
export async function claimNext(jobId: string, owner: string): Promise<Generation | "busy" | "done"> {
  return database().transaction(async (db) => {
    // Resolve the persisted owner/job pair before any locks or recovery writes.
    // An invalid workflow argument must not create a tenant or affect its jobs.
    const { rows } = await db.query<ReadingJob>("SELECT * FROM jobs WHERE owner=$1 AND id=$2", [owner, jobId]);
    if (!rows[0]) return "done";
    await ownerLock(db, owner);
    // A crashed step may already have been billed. Quarantine it, never resend.
    await db.query(`UPDATE job_items i SET status='uncertain',error='生成结果不确定；请确认可能重复计费后重试'
      FROM generation_claims c WHERE i.owner=c.owner AND i.job_id=c.job_id AND i.segment_id=c.segment_id
      AND i.attempt=c.attempt AND i.status='working' AND c.owner=$1 AND c.expires_at<now()`, [owner]);
    const job = rows[0];
    if (["indextts", "replicate"].includes(job.synthesis?.provider || "")) {
      const resumed = await db.query<{ segment_id: string; key: string; attempt: string }>(`UPDATE generation_claims c SET poll_after=now()+interval '40 seconds'
        FROM job_items i WHERE c.owner=$1 AND c.job_id=$2 AND c.poll_after<=now() AND c.expires_at>now()
        AND i.owner=c.owner AND i.job_id=c.job_id AND i.segment_id=c.segment_id AND i.status='working'
        AND c.attempt=(SELECT attempt FROM generation_claims WHERE owner=$1 AND job_id=$2 AND poll_after<=now() ORDER BY poll_after LIMIT 1)
        RETURNING c.segment_id,c.key,c.attempt`, [owner, jobId]);
      if (resumed.rows[0]) {
        const c = resumed.rows[0];
        const [{ segment }, voice] = await Promise.all([findSegment(c.segment_id, owner, db), findVoice(job.voice_id, owner, db)]);
        return { attempt: c.attempt, key: c.key, segment, voice, job, owner };
      }
    }
    const items = await db.query<{ segment_id: string; key: string }>(
      "SELECT segment_id,key FROM job_items WHERE owner=$1 AND job_id=$2 AND status='queued' ORDER BY position", [owner, jobId]);
    for (const item of items.rows) {
      const cache = await db.query("SELECT key FROM audio_cache WHERE owner=$1 AND key=$2", [owner, item.key]);
      if (cache.rows.length) {
        await attach(db, owner, job, item.segment_id, item.key);
        continue;
      }
      const claims = await db.query<{ slot: number; key: string }>("SELECT slot,key FROM generation_claims WHERE owner=$1", [owner]);
      if (claims.rows.some((c) => c.key === item.key) || claims.rows.length >= 2) continue;
      const slot = claims.rows.some((c) => c.slot === 1) ? 2 : 1;
      const attempt = randomUUID();
      const [{ segment }, voice] = await Promise.all([findSegment(item.segment_id, owner, db), findVoice(job.voice_id, owner, db)]);
      await db.query(`INSERT INTO generation_claims(owner,slot,key,job_id,segment_id,attempt,expires_at,poll_after)
        VALUES($1,$2,$3,$4,$5,$6,now()+$7::interval,now()+interval '40 seconds')`, [owner, slot, item.key, jobId, segment.id, attempt, ["indextts", "replicate"].includes(job.synthesis?.provider || "") ? "30 minutes" : "10 minutes"]);
      await db.query("UPDATE job_items SET status='working',attempt=$4 WHERE owner=$1 AND job_id=$2 AND segment_id=$3", [owner, jobId, segment.id, attempt]);
      await db.query("UPDATE jobs SET status='running',updated_at=now() WHERE owner=$1 AND id=$2", [owner, jobId]);
      return { attempt, key: item.key, segment, voice, job, owner };
    }
    await settleJob(db, owner, jobId);
    const pending = await db.query("SELECT 1 FROM job_items WHERE owner=$1 AND job_id=$2 AND status IN ('queued','working') LIMIT 1", [owner, jobId]);
    return pending.rows.length ? "busy" : "done";
  });
}

export async function completeGeneration(claim: Generation, audio: { objectHash: string; pathname: string; size: number }) {
  const { owner, job, segment, key, attempt } = claim;
  await database().transaction(async (db) => {
    await ownerLock(db, owner);
    const live = await db.query("SELECT 1 FROM generation_claims WHERE owner=$1 AND attempt=$2", [owner, attempt]);
    if (!live.rows.length) return; // An explicitly superseded attempt cannot overwrite newer state.
    await db.query(`INSERT INTO audio_cache(owner,key,object_hash,pathname,size) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [owner, key, audio.objectHash, audio.pathname, audio.size]);
    await attach(db, owner, job, segment.id, key);
    await db.query("DELETE FROM generation_claims WHERE owner=$1 AND attempt=$2", [owner, attempt]);
    await settleJob(db, owner, job.id);
  });
}

export async function uncertainGeneration(claim: Generation) {
  await database().transaction(async (db) => {
    await ownerLock(db, claim.owner);
    await db.query(`UPDATE job_items SET status='uncertain',error='生成结果不确定，可能已计费。等待当前请求结束后可确认重试。'
      WHERE owner=$1 AND job_id=$2 AND segment_id=$3 AND attempt=$4 AND status='working'
      AND EXISTS(SELECT 1 FROM generation_claims WHERE owner=$1 AND attempt=$4)`, [claim.owner, claim.job.id, claim.segment.id, claim.attempt]);
    await settleJob(db, claim.owner, claim.job.id);
  });
}

export async function retrySegment(jobId: string, segmentId: string, acknowledge: boolean, owner: string) {
  return database().transaction(async (db) => {
    await ownerLock(db, owner);
    const result = await db.query<{ status: string; attempt: string }>(
      "SELECT status,attempt FROM job_items WHERE owner=$1 AND job_id=$2 AND segment_id=$3", [owner, jobId, segmentId]);
    const item = result.rows[0];
    if (!item) throw new AppError("找不到这个任务段落", 404);
    if (!["uncertain", "error"].includes(item.status)) return;
    if (!acknowledge) throw new AppError("请确认可能重复计费", 409, "BILLING_ACK_REQUIRED");
    const active = await db.query("SELECT 1 FROM generation_claims WHERE owner=$1 AND attempt=$2 AND expires_at>now()", [owner, item.attempt]);
    if (active.rows.length) throw new AppError("请等待当前请求结束，避免重复生成", 409, "REQUEST_STILL_UNCERTAIN");
    const retry = await db.query<{ key: string; provider: string }>(`SELECT i.key,j.synthesis->>'provider' AS provider
      FROM job_items i JOIN jobs j ON j.owner=i.owner AND j.id=i.job_id WHERE i.owner=$1 AND i.job_id=$2 AND i.segment_id=$3`,
      [owner, jobId, segmentId]);
    if (retry.rows[0].provider === "replicate") await requireReplicateCapacity(db, owner, [retry.rows[0].key]);
    await db.query("DELETE FROM generation_claims WHERE owner=$1 AND attempt=$2", [owner, item.attempt]);
    await db.query("UPDATE job_items SET status='queued',attempt=NULL,error=NULL WHERE owner=$1 AND job_id=$2 AND segment_id=$3", [owner, jobId, segmentId]);
    // Retrying may resolve an older uncertain claim. It must not reselect an
    // obsolete task over the current audio/settings; attach checks desired_job.
    await db.query("UPDATE jobs SET status='queued',run_id=NULL,dispatch_after=now() WHERE owner=$1 AND id=$2", [owner, jobId]);
  });
}

export async function requireJobProvider(jobId: string, owner: string) {
  const { rows } = await database().query<ReadingJob>("SELECT * FROM jobs WHERE owner=$1 AND id=$2", [owner, jobId]);
  if (!rows[0]) throw new AppError("找不到这个任务", 404);
  const voice = await findVoice(rows[0].voice_id, owner);
  providerReady(rows[0].synthesis?.provider || voice.provider);
}
export async function pendingGeneration(claim: Generation) {
  await database().query("UPDATE generation_claims SET poll_after=now()+interval '5 seconds' WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt]);
}
export async function failedGeneration(claim: Generation) {
  await database().transaction(async (db) => {
    await ownerLock(db, claim.owner);
    await db.query(`UPDATE job_items SET status='error',error='IndexTTS 生成失败，请重试' WHERE owner=$1 AND job_id=$2 AND segment_id=$3 AND attempt=$4 AND status='working'`,
      [claim.owner, claim.job.id, claim.segment.id, claim.attempt]);
    await db.query("DELETE FROM generation_claims WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt]);
    await settleJob(db, claim.owner, claim.job.id);
  });
}
