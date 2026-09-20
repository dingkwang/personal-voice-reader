import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { POST } from "./route";
import { createReading, claimNext, completeGeneration } from "@/lib/jobs";
import { sha256 } from "@/lib/blob";

const mock = vi.hoisted(() => ({ session: vi.fn(), after: vi.fn() }));
vi.mock("@auth0/nextjs-auth0/server", () => ({ Auth0Client: class { getSession = mock.session; } }));
vi.mock("next/server", () => ({ after: mock.after }));
vi.mock("@/lib/dispatch", () => ({ dispatchJob: vi.fn() }));
vi.mock("@/lib/config", async (original) => ({ ...await original<typeof import("@/lib/config")>(), validateResourceIdentity: async () => {} }));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let documentId: string;
let payload: Record<string, unknown>;
beforeEach(async () => {
  fixture = await testDatabase();
  for (const [key, value] of Object.entries({ AUTH0_OWNER_SUB: TEST_OWNER, DEFAULT_VOICE_ID: "voice_test",
    APP_BASE_URL: "https://synthetic.test", FISH_API_KEY: "synthetic", AUTH0_DOMAIN: "synthetic.auth0.com",
    AUTH0_CLIENT_ID: "synthetic", AUTH0_CLIENT_SECRET: "synthetic", AUTH0_SECRET: "0".repeat(64) })) vi.stubEnv(key, value);
  mock.session.mockReset().mockResolvedValue({ user: { sub: TEST_OWNER } });
  mock.after.mockReset();
  const source = await createReading({ text: "合成接口测试。", speed: 1, idempotency_key: "source-request" }, TEST_OWNER);
  documentId = source.documentId;
  const claim = await claimNext(source.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  await completeGeneration(claim, { objectHash: sha256("synthetic"), pathname: "audio/synthetic", size: 9 });
  payload = { scope: "segment", segmentId: claim.segment.id, sourceJobId: source.jobId, voiceId: "voice_test",
    speed: 1, idempotencyKey: "regeneration-api", acknowledgeBilling: true };
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
function post(body = payload, origin: string | null = "https://synthetic.test", id = documentId) {
  return POST(new Request(`https://synthetic.test/api/documents/${id}/regenerate`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });
}
it("requires owner cookies and same-origin CSRF before enqueue or dispatch", async () => {
  for (const origin of [null, "https://evil.test"]) {
    expect((await post(payload, origin)).status).toBe(403);
  }
  mock.session.mockResolvedValue(null);
  expect((await post()).status).toBe(401);
  mock.session.mockResolvedValue({ user: { sub: "auth0|other" } });
  expect((await post()).status).toBe(404);
  expect(mock.after).not.toHaveBeenCalled();
  expect((await fixture.db.query("SELECT * FROM jobs")).rows).toHaveLength(1);
});
it("validates scope, billing, unexpected fields, ownership and source settings", async () => {
  for (const body of [{ ...payload, acknowledgeBilling: false }, { ...payload, scope: "all" },
    { ...payload, scope: "segment", segmentId: undefined }, { ...payload, text: "unsaved" }]) {
    expect((await post(body)).status).toBe(422);
  }
  expect((await post({ ...payload, speed: 1.3 })).status).toBe(409);
  expect((await post({ ...payload, segmentId: "other-segment" })).status).toBe(404);
  expect((await post(payload, "https://synthetic.test", "other-document")).status).toBe(404);
  expect(mock.after).not.toHaveBeenCalled();
});
it("returns the same durable task after a lost response, with no-store and safe ordered progress", async () => {
  const first = await post();
  const repeated = await post();
  expect(first.status).toBe(202);
  expect(first.headers.get("Cache-Control")).toBe("no-store");
  const a = await first.json(); const b = await repeated.json();
  expect(a.job.id).toBe(b.job.id);
  expect(a.job.regeneration).toBe(true);
  expect(a.job.items[0].status).toBe("queued");
  expect(a.job).not.toHaveProperty("synthesis");
  expect((await fixture.db.query("SELECT * FROM jobs")).rows).toHaveLength(2);
});
