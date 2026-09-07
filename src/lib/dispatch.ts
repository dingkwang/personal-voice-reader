import { getRun, start } from "workflow/api";
import { WorkflowRunNotFoundError } from "workflow/internal/errors";
import { generateReading } from "@/workflows/generate";
import { database } from "./db";
import { ownerSubject } from "./config";

export async function dispatchJob(jobId: string, owner: string) {
  const db = database();
  const { rows } = await db.query<{ run_id: string | null }>(
    `UPDATE jobs SET dispatch_after=now()+interval '2 minutes' WHERE owner=$1 AND id=$2
     AND status IN ('queued','running') AND dispatch_after<=now() RETURNING run_id`, [owner, jobId]);
  if (!rows[0]) return;
  try {
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
  const owner = ownerSubject();
  const { rows } = await database().query<{ id: string }>(
    "SELECT id FROM jobs WHERE owner=$1 AND status IN ('queued','running') AND dispatch_after<=now() ORDER BY created_at LIMIT 10", [owner]);
  for (const row of rows) await dispatchJob(row.id, owner);
  return rows.length;
}
