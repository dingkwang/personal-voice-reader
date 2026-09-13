import type { Database } from "./db";
import { AppError } from "./errors";

// Keep the existing Preview cap. All callers hold the owner lock.
export const MAX_PREVIEW_ATTEMPTS = 100;

export async function requireReplicateCapacity(db: Database, owner: string, keys: string[]) {
  const used = await db.query<{ count: string }>(
    "SELECT count(*) FROM replicate_requests WHERE owner=$1", [owner]);
  const pending = await db.query<{ key: string }>(`SELECT DISTINCT i.key FROM job_items i
    JOIN jobs j ON j.owner=i.owner AND j.id=i.job_id
    WHERE i.owner=$1 AND j.synthesis->>'provider'='replicate' AND i.status IN ('queued','working')
    AND NOT EXISTS(SELECT 1 FROM replicate_requests r WHERE r.owner=i.owner AND r.attempt=i.attempt)
    AND NOT EXISTS(SELECT 1 FROM audio_cache c WHERE c.owner=i.owner AND c.key=i.key)`, [owner]);
  const cached = await db.query<{ key: string }>(
    "SELECT key FROM audio_cache WHERE owner=$1 AND key=ANY($2::text[])", [owner, keys]);
  const cachedKeys = new Set(cached.rows.map((item) => item.key));
  const reservations = new Set([...pending.rows.map((item) => item.key), ...keys.filter((key) => !cachedKeys.has(key))]);
  if (Number(used.rows[0].count) + reservations.size > MAX_PREVIEW_ATTEMPTS) {
    throw new AppError("预览生成额度不足（包含排队中的预留额度），未创建新任务", 422, "QUOTA_EXCEEDED");
  }
}
