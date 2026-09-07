import { randomUUID } from "node:crypto";
import { z } from "zod";
import { database, ownerLock, type Database } from "./db";
import { appOrigin, ownerSubject, required } from "./config";
import { AppError } from "./errors";
import { documentSchema, makeDocument } from "./documents";
import { findDocument, findSegment, findVoice, insertDocument } from "./store";
import { audioKey } from "./audio-key";
import { sha256 } from "./blob";
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

export async function createReading(input: CreateInput, owner = ownerSubject()) {
  const voiceId = input.voice_id || required("DEFAULT_VOICE_ID");
  return enqueue({ ...input, voiceId, idempotencyKey: input.idempotency_key }, owner);
}
export async function queueDocument(input: QueueInput, owner = ownerSubject()) {
  return enqueue(input, owner);
}
async function enqueue(input: QueueInput | (CreateInput & { voiceId: string; idempotencyKey: string }), owner: string) {
  return database().transaction(async (db) => {
    await ownerLock(db, owner);
    const model = process.env.FISH_TTS_MODEL || "s2-pro";
    const requestHash = sha256(JSON.stringify({
      document: "documentId" in input ? input.documentId : { text: input.text, title: input.title || "" },
      voiceId: input.voiceId, speed: input.speed, model,
    }));
    const prior = await db.query<ReadingJob & { request_hash: string }>(
      "SELECT j.*,r.request_hash FROM job_requests r JOIN jobs j ON j.owner=r.owner AND j.id=r.job_id WHERE r.owner=$1 AND r.key=$2", [owner, input.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_hash !== requestHash) throw new AppError("幂等键已用于不同内容", 409, "IDEMPOTENCY_CONFLICT");
      return { jobId: prior.rows[0].id, documentId: prior.rows[0].document_id };
    }
    const voice = await findVoice(input.voiceId, owner, db);
    const document = "documentId" in input ? await findDocument(input.documentId, owner, db) : await insertDocument(makeDocument(input), owner, db);
    // Reconnects/settings toggles may create fresh request IDs: coalesce an active
    // identical task while preserving explicit new snapshots.
    const active = await db.query<ReadingJob>(
      "SELECT * FROM jobs WHERE owner=$1 AND document_id=$2 AND voice_id=$3 AND speed=$4 AND model=$5 AND status IN ('queued','running') LIMIT 1",
      [owner, document.id, voice.id, input.speed, model]);
    if (active.rows[0]) {
      await db.query("INSERT INTO job_requests(owner,key,request_hash,job_id) VALUES($1,$2,$3,$4)", [owner, input.idempotencyKey, requestHash, active.rows[0].id]);
      return { jobId: active.rows[0].id, documentId: document.id };
    }
    const count = await db.query<{ count: string }>("SELECT count(*) FROM jobs WHERE owner=$1 AND status IN ('queued','running')", [owner]);
    if (Number(count.rows[0].count) >= 10) throw new AppError("队列已满，请等待现有任务完成", 429, "QUEUE_FULL");
    const id = `job_${randomUUID()}`;
    await db.query(`INSERT INTO jobs(owner,id,document_id,idempotency_key,request_hash,voice_id,speed,model)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [owner, id, document.id, input.idempotencyKey, requestHash, voice.id, input.speed, model]);
    await db.query("INSERT INTO job_requests(owner,key,request_hash,job_id) VALUES($1,$2,$3,$4)", [owner, input.idempotencyKey, requestHash, id]);
    for (const segment of document.segments) {
      const key = audioKey({ provider: voice.provider, providerVoiceId: voice.providerVoiceId, text: segment.text, model, speed: input.speed });
      await db.query("INSERT INTO job_items(owner,job_id,segment_id,position,key) VALUES($1,$2,$3,$4,$5)", [owner, id, segment.id, segment.index, key]);
      await db.query("UPDATE segments SET desired_job=$3 WHERE owner=$1 AND id=$2", [owner, segment.id, id]);
    }
    return { jobId: id, documentId: document.id };
  });
}

export async function readingStatus(id: string, owner = ownerSubject()): Promise<JobStatus> {
  const db = database();
  const { rows } = await db.query<ReadingJob>("SELECT id,document_id,voice_id,speed,model,status,run_id FROM jobs WHERE owner=$1 AND id=$2", [owner, id]);
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
    "SELECT id FROM jobs WHERE owner=$1 AND document_id=$2 ORDER BY created_at DESC LIMIT 1", [owner, documentId]);
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
    await ownerLock(db, owner);
    // A crashed step may already have been billed. Quarantine it, never resend.
    await db.query(`UPDATE job_items i SET status='uncertain',error='生成结果不确定；请确认可能重复计费后重试'
      FROM generation_claims c WHERE i.owner=c.owner AND i.job_id=c.job_id AND i.segment_id=c.segment_id
      AND i.attempt=c.attempt AND i.status='working' AND c.owner=$1 AND c.expires_at<now()`, [owner]);
    const { rows } = await db.query<ReadingJob>("SELECT * FROM jobs WHERE owner=$1 AND id=$2", [owner, jobId]);
    if (!rows[0]) return "done";
    const job = rows[0];
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
      await db.query(`INSERT INTO generation_claims(owner,slot,key,job_id,segment_id,attempt,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, [owner, slot, item.key, jobId, segment.id, attempt]);
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
    await db.query(`UPDATE job_items SET status='uncertain',error='生成结果不确定，可能已计费。十分钟后可确认重试。'
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
    if (active.rows.length) throw new AppError("请等待十分钟，避免与未完成请求重叠", 409, "REQUEST_STILL_UNCERTAIN");
    await db.query("DELETE FROM generation_claims WHERE owner=$1 AND attempt=$2", [owner, item.attempt]);
    await db.query("UPDATE job_items SET status='queued',attempt=NULL,error=NULL WHERE owner=$1 AND job_id=$2 AND segment_id=$3", [owner, jobId, segmentId]);
    await db.query("UPDATE segments SET desired_job=$3 WHERE owner=$1 AND id=$2", [owner, segmentId, jobId]);
    await db.query("UPDATE jobs SET status='queued',run_id=NULL,dispatch_after=now() WHERE owner=$1 AND id=$2", [owner, jobId]);
  });
}
