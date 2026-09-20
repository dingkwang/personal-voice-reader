import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";
import { generateReading } from "@/workflows/generate";
import { database } from "./db";
import { requireJobProvider } from "./jobs";

export async function dispatchJob(jobId: string, owner: string) {
  const db = database();
  const { rows } = await db.query<{ run_id: string | null }>(
    `UPDATE jobs SET dispatch_after=now()+interval '2 minutes' WHERE owner=$1 AND id=$2
     AND status IN ('queued','running') AND dispatch_after<=now() RETURNING run_id`, [owner, jobId]);
  if (!rows[0]) return;
  try {
    await requireJobProvider(jobId, owner);
    if (rows[0].run_id) {
      try {
        const status = await getRun(rows[0].run_id).status;
        if (status === "running" || status === "pending") return;
      } catch (error) {
        if (!WorkflowRunNotFoundError.is(error)) throw error;
      }
    }
    // Starting and recording the run are not atomic. Duplicate runs after a
    // crash are harmless: all provider work must acquire a persisted claim.
    const run = await start(generateReading, [jobId, owner]);
    await db.query("UPDATE jobs SET run_id=$3 WHERE owner=$1 AND id=$2", [owner, jobId, run.runId]);
  } catch {
    // The durable outbox remains due for recovery. Never log provider/input data.
  }
}
export async function recoverDispatches() {
  // Round-robin tenants, oldest due first. The dispatch lease advances even for
  // unavailable providers, so a broken tenant cannot starve later tenants.
  const { rows } = await database().query<{ id: string; owner: string }>(`
    SELECT id,owner FROM (
      SELECT id,owner,dispatch_after,
        row_number() OVER (PARTITION BY owner ORDER BY dispatch_after,created_at,id) AS turn
      FROM jobs WHERE status IN ('queued','running') AND dispatch_after<=now()
    ) due ORDER BY turn,dispatch_after,id LIMIT 10`);
  let checked = 0;
  for (const row of rows) {
    await dispatchJob(row.id, row.owner);
    checked++;
  }
  return checked;
}
