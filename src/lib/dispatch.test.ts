import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { createReading } from "./jobs";
import { dispatchJob, recoverDispatches } from "./dispatch";
const mocks = vi.hoisted(() => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("workflow/api", () => mocks);
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
  vi.stubEnv("AUTH0_OWNER_SUB", TEST_OWNER);
  vi.stubEnv("DEFAULT_VOICE_ID", "voice_test");
  mocks.start.mockReset().mockResolvedValue({ runId: "mock-run" });
  mocks.getRun.mockReset().mockReturnValue({ status: Promise.resolve("failed") });
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
it("recovers outbox dispatch failures and deduplicates concurrent dispatch claims", async () => {
  const job = await createReading({ text: "合成测试", speed: 1, idempotency_key: "dispatch-key" });
  mocks.start.mockRejectedValueOnce(new Error("Unavailable"));
  await dispatchJob(job.jobId, TEST_OWNER);
  expect((await fixture.db.query("SELECT run_id FROM jobs")).rows[0].run_id).toBeNull();
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 second'");
  await Promise.all([recoverDispatches(), recoverDispatches()]);
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect((await fixture.db.query("SELECT run_id FROM jobs")).rows[0].run_id).toBe("mock-run");
});
it("restarts a failed workflow but does not start another running workflow", async () => {
  const job = await createReading({ text: "合成测试", speed: 1, idempotency_key: "restart-key" });
  await dispatchJob(job.jobId, TEST_OWNER);
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 second'");
  mocks.getRun.mockReturnValueOnce({ status: Promise.resolve("running") });
  await recoverDispatches();
  expect(mocks.start).toHaveBeenCalledTimes(1);
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 second'");
  await recoverDispatches();
  expect(mocks.start).toHaveBeenCalledTimes(2);
});
