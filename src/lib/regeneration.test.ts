import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { claimNext, completeGeneration, createReading, failedGeneration, queueDocument, readingStatus,
  regenerateDocument, regenerateSchema, retrySegment, uncertainGeneration, type RegenerateInput } from "./jobs";
import { findDocument } from "./store";
import { sha256 } from "./blob";
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
  vi.stubEnv("FISH_API_KEY", "synthetic-only");
  mocks.synthesize.mockReset().mockImplementation(async () => new Uint8Array([1, 2, mocks.synthesize.mock.calls.length]).buffer);
  mocks.put.mockReset().mockResolvedValue({});
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });

async function ready() {
  const source = await createReading({ text: "第一段合成测试。\n\n第二段合成测试。\n\n第三段合成测试。", title: "Synthetic",
    speed: 1, idempotency_key: "source-request" });
  for (let i = 0; i < 3; i++) await generateNext(source.jobId, TEST_OWNER);
  const document = await findDocument(source.documentId);
  expect(document.segments).toHaveLength(3);
  return { ...source, document };
}
function input(sourceJobId: string | null, changes: Partial<RegenerateInput> = {}): RegenerateInput {
  return { scope: "all", sourceJobId, voiceId: "voice_test", speed: 1, idempotencyKey: "regenerate-request",
    acknowledgeBilling: true, ...changes };
}
it("forces one ready segment, copies untouched selected keys, and never reverts them on ordinary playback", async () => {
  const source = await ready();
  const before = source.document.segments.map((item) => item.audioUrl);
  const request = input(source.jobId, { scope: "segment", segmentId: source.document.segments[1].id });
  const next = await regenerateDocument(source.documentId, request, TEST_OWNER);
  const queued = await readingStatus(next.jobId);
  expect(queued.regeneration).toBe(true);
  expect(queued.items.map((item) => item.status)).toEqual(["ready", "queued", "ready"]);
  expect((await findDocument(source.documentId)).segments.map((item) => item.audioUrl)).toEqual(before);
  await generateNext(next.jobId, TEST_OWNER);
  expect(mocks.synthesize).toHaveBeenCalledTimes(4);
  const after = (await findDocument(source.documentId)).segments.map((item) => item.audioUrl);
  expect(after[0]).toBe(before[0]); expect(after[2]).toBe(before[2]); expect(after[1]).not.toBe(before[1]);
  const ordinary = await queueDocument({ documentId: source.documentId, voiceId: "voice_test", speed: 1, idempotencyKey: "ordinary-playback" });
  expect(await generateNext(ordinary.jobId, TEST_OWNER)).toBe("done");
  expect(mocks.synthesize).toHaveBeenCalledTimes(4);
  expect((await findDocument(source.documentId)).segments.map((item) => item.audioUrl)).toEqual(after);
  expect((await fixture.db.query("SELECT * FROM audio_versions")).rows).toHaveLength(4);
  expect((await fixture.db.query("SELECT * FROM audio_cache")).rows).toHaveLength(4);
  const another = await regenerateDocument(source.documentId, input(ordinary.jobId, {
    scope: "segment", segmentId: source.document.segments[0].id, idempotencyKey: "another-single",
  }), TEST_OWNER);
  expect((await readingStatus(another.jobId)).items[1].audioUrl).toBe(after[1]);
  await generateNext(another.jobId, TEST_OWNER);
  expect(mocks.synthesize).toHaveBeenCalledTimes(5);
  expect((await findDocument(source.documentId)).segments[1].audioUrl).toBe(after[1]);
});
it("regenerates every item and reports ordered results even when completions arrive out of order", async () => {
  const source = await ready();
  const next = await regenerateDocument(source.documentId, input(source.jobId), TEST_OWNER);
  const a = await claimNext(next.jobId, TEST_OWNER);
  const b = await claimNext(next.jobId, TEST_OWNER);
  expect(await claimNext(next.jobId, TEST_OWNER)).toBe("busy");
  if (typeof a === "string" || typeof b === "string") throw new Error("Missing claims");
  for (const claim of [b, a]) await completeGeneration(claim, { objectHash: sha256(claim.key), pathname: `audio/${claim.key}`, size: 4 });
  await generateNext(next.jobId, TEST_OWNER);
  const after = await readingStatus(next.jobId);
  expect(after.status).toBe("completed");
  expect(after.items.map((item) => item.segment_id)).toEqual(source.document.segments.map((item) => item.id));
  expect(after.items.every((item, i) => item.audioUrl !== source.document.segments[i].audioUrl)).toBe(true);
  expect((await fixture.db.query("SELECT * FROM audio_versions")).rows).toHaveLength(6);
});
it("deduplicates double clicks, lost-response retries and refreshed requests before and after completion", async () => {
  const source = await ready();
  const payload = input(source.jobId);
  const results = await Promise.all(Array.from({ length: 6 }, () => regenerateDocument(source.documentId, payload, TEST_OWNER)));
  expect(new Set(results.map((item) => item.jobId)).size).toBe(1);
  for (let i = 0; i < 3; i++) await generateNext(results[0].jobId, TEST_OWNER);
  expect((await regenerateDocument(source.documentId, JSON.parse(JSON.stringify(payload)), TEST_OWNER)).jobId).toBe(results[0].jobId);
  expect(mocks.synthesize).toHaveBeenCalledTimes(6);
  expect((await fixture.db.query("SELECT * FROM jobs")).rows).toHaveLength(2);
  await expect(regenerateDocument(source.documentId, { ...payload, scope: "segment", segmentId: source.document.segments[0].id }, TEST_OWNER))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(regenerateDocument(source.documentId, { ...payload, idempotencyKey: "new-key-stale-session" }, TEST_OWNER))
    .rejects.toMatchObject({ code: "SETTINGS_CONFLICT" });
});
it("leaves every old playback/download version authorized on failure and supports explicit retry", async () => {
  const source = await ready();
  const next = await regenerateDocument(source.documentId, input(source.jobId), TEST_OWNER);
  const claim = await claimNext(next.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  await failedGeneration(claim);
  const before = source.document.segments.map((item) => item.audioUrl);
  expect((await findDocument(source.documentId)).segments.map((item) => item.audioUrl)).toEqual(before);
  const authorized = await fixture.db.query(`SELECT v.key FROM audio_versions v JOIN audio_cache c ON c.owner=v.owner AND c.key=v.key`);
  expect(authorized.rows).toHaveLength(3);
  await retrySegment(next.jobId, claim.segment.id, true, TEST_OWNER);
  await generateNext(next.jobId, TEST_OWNER);
  expect((await findDocument(source.documentId)).segments[0].audioUrl).not.toBe(before[0]);
});
it("rejects cross-owner, invalid segment, changed voice/speed and unfinished requests transactionally", async () => {
  const source = await ready();
  await expect(regenerateDocument(source.documentId, input(source.jobId), "auth0|other")).rejects.toMatchObject({ status: 404 });
  for (const changes of [{ voiceId: "voice_other" }, { speed: 1.2 }]) {
    await expect(regenerateDocument(source.documentId, input(source.jobId, changes), TEST_OWNER)).rejects.toMatchObject({ code: "SETTINGS_CONFLICT" });
  }
  await expect(regenerateDocument(source.documentId, input(source.jobId, { scope: "segment", segmentId: "seg_other" }), TEST_OWNER))
    .rejects.toMatchObject({ code: "SEGMENT_NOT_FOUND" });
  const next = await regenerateDocument(source.documentId, input(source.jobId), TEST_OWNER);
  const again = input(next.jobId, { idempotencyKey: "request-conflict" });
  await expect(regenerateDocument(source.documentId, again, TEST_OWNER)).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });
  const claim = await claimNext(next.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  await uncertainGeneration(claim);
  await expect(regenerateDocument(source.documentId, again, TEST_OWNER)).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });
  await fixture.db.query("UPDATE generation_claims SET expires_at=now()-interval '1 hour'");
  await expect(regenerateDocument(source.documentId, again, TEST_OWNER)).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });
  expect((await fixture.db.query("SELECT * FROM jobs")).rows).toHaveLength(2);
});
it("does not let late regenerated audio replace a newer settings selection", async () => {
  const source = await ready();
  const next = await regenerateDocument(source.documentId, input(source.jobId), TEST_OWNER);
  const claim = await claimNext(next.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  const newer = await queueDocument({ documentId: source.documentId, voiceId: "voice_test", speed: 1.2, idempotencyKey: "new-settings" });
  for (let i = 0; i < 3; i++) await generateNext(newer.jobId, TEST_OWNER);
  await completeGeneration(claim, { objectHash: sha256("late"), pathname: "audio/late", size: 4 });
  expect((await findDocument(source.documentId)).segments.every((segment) => segment.speed === 1.2)).toBe(true);
});
it("keeps superseded retries from selecting old audio and rejects single regeneration with missing untouched audio", async () => {
  const source = await createReading({ text: "第一段合成。\n\n第二段合成。", speed: 1, idempotency_key: "partial-source" });
  const claim = await claimNext(source.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  await failedGeneration(claim);
  const second = await claimNext(source.jobId, TEST_OWNER);
  if (typeof second === "string") throw new Error("Missing claim");
  await failedGeneration(second);
  await expect(regenerateDocument(source.documentId, input(source.jobId, { scope: "segment", segmentId: claim.segment.id }), TEST_OWNER))
    .rejects.toMatchObject({ code: "AUDIO_NOT_READY" });
  const next = await regenerateDocument(source.documentId, input(source.jobId), TEST_OWNER);
  for (let i = 0; i < 2; i++) await generateNext(next.jobId, TEST_OWNER);
  const selected = (await findDocument(source.documentId)).segments.map((item) => item.audioUrl);
  await retrySegment(source.jobId, claim.segment.id, true, TEST_OWNER);
  await generateNext(source.jobId, TEST_OWNER);
  expect((await findDocument(source.documentId)).segments.map((item) => item.audioUrl)).toEqual(selected);
});
it("supports legacy Fish sessions without a job and validates explicit scope and billing acknowledgement", async () => {
  const source = await ready();
  await fixture.db.query("UPDATE job_items SET status='ready'");
  // A legacy session has version files but no source task metadata.
  await fixture.db.query("DELETE FROM job_requests");
  await fixture.db.query("DELETE FROM job_items");
  await fixture.db.query("DELETE FROM jobs");
  const next = await regenerateDocument(source.documentId, input(null), TEST_OWNER);
  await generateNext(next.jobId, TEST_OWNER);
  expect(mocks.synthesize.mock.calls.at(-1)?.[0].providerVoiceId).toBe("test-reference");
  for (const value of [
    { ...input(null), acknowledgeBilling: false }, { ...input(null), scope: "segment" },
    { ...input(null), segmentId: "seg_unexpected" }, { ...input(null), text: "unsaved" },
  ]) expect(regenerateSchema.safeParse(value).success).toBe(false);
});
