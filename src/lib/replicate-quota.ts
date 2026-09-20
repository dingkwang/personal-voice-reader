import type { Database } from "./db";
import { AppError } from "./errors";

export const MAX_DAILY_ATTEMPTS = 1000;

// All callers hold the owner lock. Read the clock after acquiring it, not at BEGIN.
export async function replicateDailyUsage(db: Database, owner: string) {
  const { rows } = await db.query<{ started_at: Date; count: string }>(`WITH quota_clock AS MATERIALIZED (
    SELECT clock_timestamp() AS started_at
  ), local_day AS (
    SELECT started_at, (started_at AT TIME ZONE 'America/Los_Angeles')::date AS day FROM quota_clock
  )
  SELECT started_at, (SELECT count(*) FROM replicate_requests WHERE owner=$1
    AND created_at >= (day::timestamp AT TIME ZONE 'America/Los_Angeles')
    AND created_at < ((day+1)::timestamp AT TIME ZONE 'America/Los_Angeles')) AS count
  FROM local_day`, [owner]);
  return { used: Number(rows[0].count), startedAt: rows[0].started_at };
}

export async function requireReplicateCapacity(db: Database, owner: string, keys: string[]) {
  const { used } = await replicateDailyUsage(db, owner);
  const pending = await db.query<{ key: string }>(`SELECT DISTINCT i.key FROM job_items i
    JOIN jobs j ON j.owner=i.owner AND j.id=i.job_id
    WHERE i.owner=$1 AND j.synthesis->>'provider'='replicate' AND i.status IN ('queued','working')
    AND NOT EXISTS(SELECT 1 FROM replicate_requests r WHERE r.owner=i.owner AND r.attempt=i.attempt)
    AND NOT EXISTS(SELECT 1 FROM audio_cache c WHERE c.owner=i.owner AND c.key=i.key)`, [owner]);
  const cached = await db.query<{ key: string }>(
    "SELECT key FROM audio_cache WHERE owner=$1 AND key=ANY($2::text[])", [owner, keys]);
  const cachedKeys = new Set(cached.rows.map((item) => item.key));
  const reservations = new Set([...pending.rows.map((item) => item.key), ...keys.filter((key) => !cachedKeys.has(key))]);
  if (used + reservations.size > MAX_DAILY_ATTEMPTS) {
    throw new AppError(`今日生成额度不足（每日 ${MAX_DAILY_ATTEMPTS} 次，洛杉矶时间零点重置，包含排队预留），未创建新任务`, 422, "QUOTA_EXCEEDED");
  }
}
