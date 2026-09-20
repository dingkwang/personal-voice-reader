import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { GET as documents, POST as save } from "@/app/api/documents/route";
import { GET as document } from "@/app/api/documents/[id]/route";
import { GET as voices, POST as voice, PATCH as preference } from "@/app/api/voices/route";
import { POST as upload } from "@/app/api/uploads/route";
import { POST as tts } from "@/app/api/tts/route";
import { GET as audio } from "@/app/api/audio/[segment]/route";
import { GET as status, POST as retry } from "@/app/api/jobs/[id]/route";
import { GET as events } from "@/app/api/jobs/[id]/events/route";
import { POST as regenerate } from "@/app/api/documents/[id]/regenerate/route";
import { GET as recover } from "@/app/api/jobs/recover/route";
import { addVoice, findDocument, findVoice } from "./store";
import { createReading, readingStatus, claimNext } from "./jobs";
import { reserveUpload } from "./uploads";
import { generateNext } from "@/workflows/steps";
import { ownerPrefix } from "./blob";
import { encodePcmWav } from "./wav";

const mock = vi.hoisted(() => ({
  session: vi.fn(), after: vi.fn(), dispatch: vi.fn(), recover: vi.fn(),
  synthesize: vi.fn(), cloneVoice: vi.fn(), get: vi.fn(), put: vi.fn(), head: vi.fn(), fetch: vi.fn(),
}));
vi.mock("@auth0/nextjs-auth0/server", () => ({ Auth0Client: class { getSession = mock.session; } }));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), after: mock.after }));
vi.mock("./dispatch", () => ({ dispatchJob: mock.dispatch, recoverDispatches: mock.recover }));
vi.mock("./providers", () => ({ getVoiceProvider: () => ({ synthesize: mock.synthesize, cloneVoice: mock.cloneVoice }) }));
vi.mock("@vercel/blob", () => ({ get: mock.get, put: mock.put, head: mock.head }));
vi.mock("@vercel/blob/client", () => ({
  handleUpload: async ({ body, onBeforeGenerateToken }: {
    body: { payload: { pathname: string; clientPayload: string } };
    onBeforeGenerateToken: (path: string, id: string) => Promise<unknown>;
  }) => onBeforeGenerateToken(body.payload.pathname, body.payload.clientPayload),
}));

const other = "google-oauth2|synthetic-other", origin = "https://synthetic.test";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let reference: Buffer;
const session = (sub: string | null) => mock.session.mockResolvedValue(sub ? { user: { sub, email: "same@example.test" } } : null);
const request = (path: string, body?: unknown, method = "POST") => new Request(`${origin}${path}`, {
  method: body === undefined ? "GET" : method, headers: { Origin: origin, "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const context = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await testDatabase();
  for (const name of ["DATABASE_URL", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_MCP_CLIENT_ID",
    "AUTH0_AUDIENCE", "BLOB_READ_WRITE_TOKEN", "CRON_SECRET", "FISH_API_KEY", "REPLICATE_API_KEY"]) vi.stubEnv(name, "synthetic");
  for (const name of ["APP_ENV", "RESOURCE_ENV", "VERCEL_ENV"]) vi.stubEnv(name, "development");
  vi.stubEnv("AUTH0_SECRET", "0".repeat(64));
  vi.stubEnv("AUTH0_DOMAIN", "synthetic.auth0.com");
  vi.stubEnv("AUTH0_OWNER_SUB", TEST_OWNER);
  vi.stubEnv("DEFAULT_VOICE_ID", "voice_test");
  vi.stubEnv("APP_BASE_URL", origin);
  await fixture.db.query("INSERT INTO deployment_identity(environment,project) VALUES('development','personal-voice-reader')");
  session(TEST_OWNER);
  reference = Buffer.from(await encodePcmWav(new Float32Array(24_000 * 12)).arrayBuffer());
  mock.get.mockImplementation(async () => ({ stream: new Response(new Uint8Array(reference)).body, headers: new Headers() }));
  mock.head.mockResolvedValue({ size: reference.length, contentType: "audio/wav" });
  mock.put.mockResolvedValue({});
  mock.synthesize.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  mock.fetch.mockImplementation(() => { throw new Error("Unexpected network request"); });
  vi.stubGlobal("fetch", mock.fetch);
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["owners", "documents", "segments", "voices", "reader_preferences", "uploads", "clone_requests",
    "jobs", "job_items", "job_requests", "generation_claims", "audio_versions", "audio_cache", "replicate_requests"]) {
    result[table] = (await fixture.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return result;
}
async function seedOther() {
  await addVoice({ ...await findVoice("voice_test", TEST_OWNER), id: "voice_other" }, other);
}
const create = (owner: string, voiceId: string) => createReading({
  text: "相同的合成测试文字", voice_id: voiceId, speed: 1, idempotency_key: "same-tenant-request",
}, owner);

it("starts a Google user empty, keeps the legacy owner intact, and saves only to the session subject", async () => {
  const old = await create(TEST_OWNER, "voice_test");
  const before = await snapshot();
  session(other);
  expect(await (await documents()).json()).toEqual({ documents: [] });
  expect(await (await voices()).json()).toEqual({ voices: [], defaultVoiceId: null, canLinkFishVoice: false });
  expect(await snapshot()).toEqual(before); // Reads do not create a tenant.
  const created = await save(request("/api/documents", { text: "新的合成文章", owner: TEST_OWNER }));
  expect(created.status).toBe(201);
  const id = (await created.json()).document.id;
  expect((await (await document(request("/"), context(id))).json()).allowLegacyRecovery).toBe(false);
  expect((await findDocument(id, other)).originalText).toBe("新的合成文章");
  await expect(findDocument(id, TEST_OWNER)).rejects.toMatchObject({ status: 404 });
  session(TEST_OWNER);
  const original = await document(request("/"), context(old.documentId));
  expect(original.status).toBe(200);
  expect((await original.json()).allowLegacyRecovery).toBe(true);
  expect((await (await voices()).json()).defaultVoiceId).toBe("voice_test");
  expect((await fixture.db.query("SELECT id FROM owners")).rows).toHaveLength(2);
});

it("registers each user's own private Replicate voice with independent upload/idempotency/defaults and no synthesis", async () => {
  const key = randomUUID();
  const saved = [];
  for (const owner of [TEST_OWNER, other]) {
    session(owner);
    const reservation = await upload(request("/api/uploads", { contentType: "audio/wav", size: reference.length }));
    expect(reservation.status).toBe(201);
    const reserved = await reservation.json();
    expect(reserved.pathname).toMatch(new RegExp(`^uploads/${ownerPrefix(owner)}/`));
    const input = { provider: "replicate", name: "我的合成声音", language: "zh", consent: true,
      uploadIds: [reserved.id], idempotencyKey: key };
    const response = await voice(request("/api/voices", input));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.voice).not.toHaveProperty("reference");
    expect(await (await voice(request("/api/voices", input))).json()).toEqual(body);
    expect((await (await voices()).json()).defaultVoiceId).toBe(body.voice.id);
    expect((await findVoice(body.voice.id, owner)).reference?.pathname).toMatch(new RegExp(`^references/${ownerPrefix(owner)}/`));
    saved.push(body.voice.id);
  }
  expect(saved[0]).not.toBe(saved[1]);
  await expect(findVoice(saved[0], other)).rejects.toMatchObject({ status: 404 });
  expect(mock.put).toHaveBeenCalledTimes(2);
  expect(mock.fetch).not.toHaveBeenCalled();
  expect(mock.synthesize).not.toHaveBeenCalled();
  expect(mock.cloneVoice).not.toHaveBeenCalled();
});

it.each([TEST_OWNER, other])("denies cross-user APIs before any storage, dispatch or provider side effect", async (attacker) => {
  await seedOther();
  const jobs = [await create(TEST_OWNER, "voice_test"), await create(other, "voice_other")];
  for (const [i, owner] of [TEST_OWNER, other].entries()) await generateNext(jobs[i].jobId, owner);
  const victim = attacker === TEST_OWNER ? other : TEST_OWNER;
  const target = jobs[victim === TEST_OWNER ? 0 : 1], own = jobs[attacker === TEST_OWNER ? 0 : 1];
  const ownVoice = attacker === TEST_OWNER ? "voice_test" : "voice_other";
  const victimVoice = victim === TEST_OWNER ? "voice_test" : "voice_other";
  const doc = await findDocument(target.documentId, victim), seg = doc.segments[0];
  const reserved = await reserveUpload({ contentType: "audio/wav", size: reference.length }, victim);
  session(attacker);
  const before = await snapshot();
  for (const fn of [mock.get, mock.put, mock.head, mock.synthesize, mock.cloneVoice, mock.after]) fn.mockClear();
  const responses = [
    await document(request("/"), context(target.documentId)),
    await status(request("/"), context(target.jobId)),
    await events(request("/"), context(target.jobId)),
    ...await Promise.all(["", `?v=${seg.audioHash}`, `?v=${seg.audioHash!.slice(0, 12)}`].map((version) =>
      audio(new Request(`${origin}/api/audio/${seg.id}${version}`, { headers: { Range: "bytes=0-1" } }),
        { params: Promise.resolve({ segment: seg.id }) }))),
    await tts(request("/api/tts", { documentId: target.documentId, voiceId: ownVoice, speed: 1, idempotencyKey: "forbidden-queue" })),
    await tts(request("/api/tts", { documentId: own.documentId, voiceId: victimVoice, speed: 1, idempotencyKey: "forbidden-voice" })),
    await preference(request("/api/voices", { voiceId: victimVoice }, "PATCH")),
    await retry(request("/", { segmentId: seg.id, acknowledgeBilling: true }), context(target.jobId)),
    await retry(request("/", { segmentId: seg.id, acknowledgeBilling: true }), context(own.jobId)),
    await regenerate(request("/", { scope: "all", sourceJobId: target.jobId, voiceId: victimVoice,
      speed: 1, acknowledgeBilling: true, idempotencyKey: "forbidden-regenerate" }), context(target.documentId)),
    await regenerate(request("/", { scope: "segment", segmentId: seg.id, sourceJobId: target.jobId, voiceId: victimVoice,
      speed: 1, acknowledgeBilling: true, idempotencyKey: "forbidden-segment" }), context(target.documentId)),
    await upload(request("/api/uploads", { type: "blob.generate-client-token",
      payload: { pathname: reserved.pathname, clientPayload: reserved.id } })),
    await voice(request("/api/voices", { provider: "replicate", name: "Denied", consent: true,
      uploadIds: [reserved.id], idempotencyKey: randomUUID() })),
    await voice(request("/api/voices", { provider: "fish", name: "Denied", consent: true,
      uploadIds: [reserved.id], idempotencyKey: randomUUID() })),
  ];
  for (const response of responses) {
    expect([403, 404, 422]).toContain(response.status);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(await snapshot()).toEqual(before);
  for (const fn of [mock.get, mock.put, mock.head, mock.synthesize, mock.cloneVoice, mock.fetch, mock.after, mock.dispatch]) expect(fn).not.toHaveBeenCalled();
});

it("does not let a new user link private Fish IDs or inherit the configured default", async () => {
  session(other);
  const before = await snapshot();
  expect((await voice(request("/", { name: "Denied", providerVoiceId: "test-reference" }))).status).toBe(403);
  await expect(createReading({ text: "测试", speed: 1, idempotency_key: "missing-own-voice" }, other)).rejects.toMatchObject({ code: "VOICE_REQUIRED" });
  expect(await snapshot()).toEqual(before);
  session(TEST_OWNER);
  expect((await voice(request("/", { name: "Legacy link", providerVoiceId: "legacy-reference" }))).status).toBe(201);
});

it("isolates identical idempotency/cache keys and permits workflows for both owners only with a persisted job pair", async () => {
  await seedOther();
  const a = await create(TEST_OWNER, "voice_test"), b = await create(other, "voice_other");
  expect(a.jobId).not.toBe(b.jobId);
  expect(await create(other, "voice_other")).toEqual(b);
  await generateNext(a.jobId, TEST_OWNER);
  const before = await snapshot();
  expect(await generateNext(a.jobId, other)).toBe("done");
  expect(await claimNext(b.jobId, "google-oauth2|unregistered")).toBe("done");
  expect(await snapshot()).toEqual(before);
  await generateNext(b.jobId, other);
  expect(mock.synthesize).toHaveBeenCalledTimes(2); // No cross-user cache hit.
  expect((await readingStatus(b.jobId, other)).status).toBe("completed");
  const cached = (await fixture.db.query<{ owner: string; key: string; pathname: string }>("SELECT owner,key,pathname FROM audio_cache")).rows;
  expect(cached).toHaveLength(2);
  expect(cached[0].key).toBe(cached[1].key);
  expect(cached[0].pathname).not.toBe(cached[1].pathname);
  for (const row of cached) expect(row.pathname).toContain(ownerPrefix(row.owner));
});

it("preserves original legacy audio without granting other tenants legacy or foreign Blob access", async () => {
  await seedOther();
  const a = await create(TEST_OWNER, "voice_test"), b = await create(other, "voice_other");
  for (const [job, owner] of [[a, TEST_OWNER], [b, other]] as const) await generateNext(job.jobId, owner);
  await fixture.db.query("UPDATE audio_cache SET legacy=true");
  await fixture.db.query("DELETE FROM audio_versions");
  const segmentA = (await findDocument(a.documentId, TEST_OWNER)).segments[0];
  const segmentB = (await findDocument(b.documentId, other)).segments[0];
  mock.get.mockImplementation(async () => ({ stream: new Response(new Uint8Array([1, 2, 3])).body, headers: new Headers() }));
  const get = (segment: typeof segmentA) => audio(request(`/api/audio/${segment.id}?v=${segment.audioHash!.slice(0, 12)}`),
    { params: Promise.resolve({ segment: segment.id }) });
  session(TEST_OWNER);
  const original = await get(segmentA);
  expect(original.status).toBe(200);
  expect([...new Uint8Array(await original.arrayBuffer())]).toEqual([1, 2, 3]);
  session(other);
  mock.get.mockClear();
  expect((await get(segmentB)).status).toBe(404);
  await fixture.db.query("INSERT INTO audio_versions(owner,segment_id,key) VALUES($1,$2,$3)", [other, segmentB.id, segmentB.audioHash]);
  await fixture.db.query("UPDATE audio_cache SET pathname=$2 WHERE owner=$1", [other, `audio/${ownerPrefix(TEST_OWNER)}/private.mp3`]);
  const before = await snapshot();
  expect((await get(segmentB)).status).toBe(404);
  expect(mock.get).not.toHaveBeenCalled();
  expect(await snapshot()).toEqual(before);
});

it("denies anonymous web reads/mutations and user sessions cannot authorize cron recovery", async () => {
  session(null);
  for (const response of [
    await documents(), await voices(), await document(request("/"), context("doc_test")),
    await audio(request("/api/audio/seg_test"), { params: Promise.resolve({ segment: "seg_test" }) }),
    await status(request("/"), context("job_test")), await events(request("/"), context("job_test")),
    await save(request("/", { text: "denied" })), await tts(request("/", {})),
    await voice(request("/", {})), await upload(request("/", {})), await preference(request("/", {}, "PATCH")),
    await retry(request("/", {}), context("job_test")), await regenerate(request("/", {}), context("doc_test")),
  ]) expect(response.status).toBe(401);
  session(other);
  expect((await recover(request("/api/jobs/recover"))).status).toBe(401);
  expect(mock.recover).not.toHaveBeenCalled();
  const before = await snapshot();
  expect((await save(new Request(`${origin}/api/documents`, { method: "POST", body: JSON.stringify({ text: "denied" }) }))).status).toBe(403);
  expect(await snapshot()).toEqual(before);
});
