import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { claimNext, completeGeneration, createReading, readingStatus, retrySegment, uncertainGeneration } from "./jobs";
import { sha256 } from "./blob";
import { findDocument } from "./store";
import { generateNext } from "@/workflows/steps";
const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/providers", () => ({ getVoiceProvider: () => ({ synthesize: mocks.synthesize }) }));
vi.mock("@/lib/config", async (original) => ({ ...await original<typeof import("./config")>(), validateResourceIdentity: async () => {} }));
vi.mock("@vercel/blob", () => ({ put: mocks.put, BlobPreconditionFailedError: class extends Error {} }));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
  vi.stubEnv("AUTH0_OWNER_SUB", TEST_OWNER);
  vi.stubEnv("DEFAULT_VOICE_ID", "voice_test");
  vi.stubEnv("APP_BASE_URL", "http://localhost:3108");
  mocks.synthesize.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  mocks.put.mockReset().mockResolvedValue({});
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
const input = (key: string, text = "这是纯合成测试文本。") => ({ text, title: "Synthetic", speed: 1, idempotency_key: key });
it("atomically deduplicates concurrent calls and rejects changed payload", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => createReading(input("request-same"))));
  expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
  expect((await fixture.db.query("SELECT * FROM documents")).rows).toHaveLength(1);
  await expect(createReading(input("request-same", "不同文字"))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(mocks.synthesize).not.toHaveBeenCalled();
});
it("persistently limits owner to two claims across jobs and releases on completion", async () => {
  const jobs = await Promise.all([0, 1, 2].map((i) => createReading(input(`request-${i}`, `第${i}段测试`))));
  const claims = await Promise.all(jobs.map((job) => claimNext(job.jobId, TEST_OWNER)));
  expect(claims.filter((c) => typeof c !== "string")).toHaveLength(2);
  expect(claims).toContain("busy");
  const claim = claims.find((c) => typeof c !== "string")!;
  if (typeof claim === "string") throw new Error("Missing claim");
  await completeGeneration(claim, { objectHash: sha256("test"), pathname: "audio/test", size: 4 });
  const blocked = jobs[claims.indexOf("busy")];
  expect(await claimNext(blocked.jobId, TEST_OWNER)).not.toBe("busy");
});
it("reuses completed cache in another session and retains model/key dimensions", async () => {
  const first = await createReading(input("request-first"));
  await generateNext(first.jobId, TEST_OWNER);
  const second = await createReading(input("request-second"));
  expect(await generateNext(second.jobId, TEST_OWNER)).toBe("done");
  expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  expect((await readingStatus(second.jobId)).status).toBe("completed");
  expect((await findDocument(second.documentId)).segments[0].audioUrl).toContain("?v=");
  const third = await createReading({ ...input("request-third"), speed: 1.2 });
  await generateNext(third.jobId, TEST_OWNER);
  expect(mocks.synthesize).toHaveBeenCalledTimes(2);
});
it("deduplicates identical in-flight cache keys across documents", async () => {
  const a = await createReading(input("request-cache-a"));
  const b = await createReading(input("request-cache-b"));
  const c = await claimNext(a.jobId, TEST_OWNER);
  expect(await claimNext(b.jobId, TEST_OWNER)).toBe("busy");
  if (typeof c === "string") throw new Error("Missing claim");
  await completeGeneration(c, { objectHash: sha256("test"), pathname: "audio/test", size: 4 });
  expect(await claimNext(b.jobId, TEST_OWNER)).toBe("done");
});
it("quarantines uncertain provider calls, keeps slots, requires delayed explicit billing acknowledgement", async () => {
  const job = await createReading(input("request-uncertain"));
  mocks.synthesize.mockRejectedValueOnce(new Error("private provider error"));
  await generateNext(job.jobId, TEST_OWNER);
  const status = await readingStatus(job.jobId);
  expect(status.status).toBe("attention");
  expect(status.items[0].status).toBe("uncertain");
  expect(JSON.stringify(status)).not.toContain("private provider error");
  await generateNext(job.jobId, TEST_OWNER);
  expect(mocks.synthesize).toHaveBeenCalledTimes(1);
  expect((await fixture.db.query("SELECT * FROM generation_claims")).rows).toHaveLength(1);
  await expect(retrySegment(job.jobId, status.items[0].segment_id, false, TEST_OWNER)).rejects.toMatchObject({ code: "BILLING_ACK_REQUIRED" });
  await expect(retrySegment(job.jobId, status.items[0].segment_id, true, TEST_OWNER)).rejects.toMatchObject({ code: "REQUEST_STILL_UNCERTAIN" });
  await fixture.db.query("UPDATE generation_claims SET expires_at=now()-interval '1 minute'");
  await retrySegment(job.jobId, status.items[0].segment_id, true, TEST_OWNER);
  await generateNext(job.jobId, TEST_OWNER);
  expect(mocks.synthesize).toHaveBeenCalledTimes(2);
});
it("recovers interrupted claims without automatically reissuing paid synthesis", async () => {
  const job = await createReading(input("request-crash"));
  await claimNext(job.jobId, TEST_OWNER);
  await fixture.db.query("UPDATE generation_claims SET expires_at=now()-interval '1 minute'");
  expect(await generateNext(job.jobId, TEST_OWNER)).toBe("done");
  expect((await readingStatus(job.jobId)).status).toBe("attention");
  expect(mocks.synthesize).not.toHaveBeenCalled();
});
it("isolates job and document access by owner", async () => {
  const job = await createReading(input("request-owner"));
  await expect(readingStatus(job.jobId, "auth0|other")).rejects.toMatchObject({ status: 404 });
  await expect(findDocument(job.documentId, "auth0|other")).rejects.toMatchObject({ status: 404 });
});
it("late completion cannot overwrite settings from a newer job", async () => {
  const original = await createReading(input("request-old"));
  const old = await claimNext(original.jobId, TEST_OWNER);
  const { queueDocument } = await import("./jobs");
  const newer = await queueDocument({ documentId: original.documentId, voiceId: "voice_test", speed: 1.3, idempotencyKey: "request-new" });
  await generateNext(newer.jobId, TEST_OWNER);
  if (typeof old === "string") throw new Error("Missing old claim");
  await completeGeneration(old, { objectHash: sha256("old"), pathname: "audio/old", size: 3 });
  expect((await findDocument(original.documentId)).segments[0].speed).toBe(1.3);
  expect((await fixture.db.query("SELECT * FROM audio_versions")).rows).toHaveLength(2);
});
it("marks explicit uncertain attempts without returning provider payload", async () => {
  const job = await createReading(input("request-manual"));
  const claim = await claimNext(job.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  await uncertainGeneration(claim);
  expect((await readingStatus(job.jobId)).items[0].error).toContain("可能已计费");
});
it("does not quarantine a committed completion after a lost commit acknowledgement", async () => {
  const job = await createReading(input("request-commit"));
  const claim = await claimNext(job.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  await completeGeneration(claim, { objectHash: sha256("audio"), pathname: "audio/test", size: 5 });
  await uncertainGeneration(claim);
  expect((await readingStatus(job.jobId)).status).toBe("completed");
});
it("persists coalesced web request keys after the shared task completes", async () => {
  const first = await createReading(input("request-coalesce"));
  const { queueDocument } = await import("./jobs");
  const secondInput = { documentId: first.documentId, voiceId: "voice_test", speed: 1, idempotencyKey: "request-alias" };
  expect((await queueDocument(secondInput)).jobId).toBe(first.jobId);
  await generateNext(first.jobId, TEST_OWNER);
  expect((await queueDocument(secondInput)).jobId).toBe(first.jobId);
  expect((await fixture.db.query("SELECT * FROM jobs")).rows).toHaveLength(1);
});
