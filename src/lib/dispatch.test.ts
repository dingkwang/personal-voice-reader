import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { createReading } from "./jobs";
import { dispatchJob, recoverDispatches } from "./dispatch";
import { addVoice, findVoice } from "./store";
const mocks = vi.hoisted(() => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock("workflow/api", () => mocks);
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
  vi.stubEnv("AUTH0_OWNER_SUB", TEST_OWNER);
  vi.stubEnv("DEFAULT_VOICE_ID", "voice_test");
  vi.stubEnv("FISH_API_KEY", "synthetic-test-key");
  mocks.start.mockReset().mockResolvedValue({ runId: "mock-run" });
  mocks.getRun.mockReset().mockReturnValue({ status: Promise.resolve("failed") });
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
it("recovers outbox dispatch failures and deduplicates concurrent dispatch claims", async () => {
  const job = await createReading({ text: "合成测试", speed: 1, idempotency_key: "dispatch-key" }, TEST_OWNER);
  mocks.start.mockRejectedValueOnce(new Error("Unavailable"));
  await dispatchJob(job.jobId, TEST_OWNER);
  expect((await fixture.db.query("SELECT run_id FROM jobs")).rows[0].run_id).toBeNull();
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 second'");
  await Promise.all([recoverDispatches(), recoverDispatches()]);
  expect(mocks.start).toHaveBeenCalledTimes(2);
  expect((await fixture.db.query("SELECT run_id FROM jobs")).rows[0].run_id).toBe("mock-run");
});
it("restarts a failed workflow but does not start another running workflow", async () => {
  const job = await createReading({ text: "合成测试", speed: 1, idempotency_key: "restart-key" }, TEST_OWNER);
  await dispatchJob(job.jobId, TEST_OWNER);
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 second'");
  mocks.getRun.mockReturnValueOnce({ status: Promise.resolve("running") });
  await recoverDispatches();
  expect(mocks.start).toHaveBeenCalledTimes(1);
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 second'");
  await recoverDispatches();
  expect(mocks.start).toHaveBeenCalledTimes(2);
});

it("recovers multiple tenants fairly in bounded batches without losing owner propagation", async () => {
  const owners = [TEST_OWNER, ...Array.from({ length: 11 }, (_, i) => `google-oauth2|synthetic-${i}`)];
  for (const owner of owners) {
    if (owner !== TEST_OWNER) await addVoice(await findVoice("voice_test", TEST_OWNER), owner);
    const count = owner === TEST_OWNER ? 10 : 1;
    for (let i = 0; i < count; i++) await createReading({
      text: `合成测试 ${i}`, voice_id: "voice_test", speed: 1, idempotency_key: `recovery-${i}`,
    }, owner);
  }
  // The noisy legacy tenant has the oldest ten jobs. It gets only one turn
  // before other owners. Missing providers must also advance the dispatch lease.
  await fixture.db.query("UPDATE jobs SET dispatch_after=now()-interval '1 hour' WHERE owner=$1", [TEST_OWNER]);
  await fixture.db.query("UPDATE jobs SET synthesis=jsonb_set(synthesis,'{provider}','\"local\"') WHERE owner=$1", [TEST_OWNER]);
  expect(await recoverDispatches()).toBe(10);
  expect(mocks.start).toHaveBeenCalledTimes(9);
  const firstOwners = mocks.start.mock.calls.map((call) => call[1][1]);
  expect(new Set(firstOwners).size).toBe(9);
  expect(firstOwners).not.toContain(TEST_OWNER);
  expect(await recoverDispatches()).toBe(10);
  expect(new Set(mocks.start.mock.calls.map((call) => call[1][1])).size).toBe(11);
  for (const [, [jobId, owner]] of mocks.start.mock.calls) {
    expect((await fixture.db.query("SELECT 1 FROM jobs WHERE owner=$1 AND id=$2", [owner, jobId])).rows).toHaveLength(1);
  }
  expect((await fixture.db.query("SELECT 1 FROM jobs WHERE dispatch_after>now()")).rows).toHaveLength(20);
});
