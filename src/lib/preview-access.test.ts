import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { requireOwner } from "./auth";
import { GET as documents } from "@/app/api/documents/route";
import { POST as tts } from "@/app/api/tts/route";
import { POST as retry } from "@/app/api/jobs/[id]/route";
import { GET as recover } from "@/app/api/jobs/recover/route";

const mock = vi.hoisted(() => ({ session: vi.fn(), query: vi.fn(), queue: vi.fn(), dispatch: vi.fn() }));
vi.mock("@auth0/nextjs-auth0/server", () => ({ Auth0Client: class { getSession = mock.session; } }));
vi.mock("./db", () => ({ database: () => ({ query: mock.query }) }));
vi.mock("./jobs", async () => ({ queueDocument: mock.queue, retrySegment: mock.queue, readingStatus: vi.fn(),
  requireJobProvider: async () => { (await import("./config")).fishApiKey(); },
  queueSchema: z.object({ voiceId: z.string(), documentId: z.string(), speed: z.number(), idempotencyKey: z.string() }) }));
vi.mock("./store", async (original) => ({ ...await original<typeof import("./store")>(), findVoice: async () => ({ provider: "fish" }) }));
vi.mock("./dispatch", () => ({ dispatchJob: mock.dispatch, recoverDispatches: mock.dispatch }));
vi.mock("next/server", () => ({ after: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["DATABASE_URL", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_AUDIENCE",
    "AUTH0_MCP_CLIENT_ID", "BLOB_READ_WRITE_TOKEN", "DEFAULT_VOICE_ID", "CRON_SECRET"]) vi.stubEnv(name, "synthetic");
  vi.stubEnv("AUTH0_OWNER_SUB", "auth0|owner");
  vi.stubEnv("AUTH0_SECRET", "0".repeat(64));
  vi.stubEnv("AUTH0_DOMAIN", "synthetic.auth0.com");
  vi.stubEnv("APP_BASE_URL", "https://synthetic.test");
  for (const name of ["APP_ENV", "RESOURCE_ENV", "VERCEL_ENV"]) vi.stubEnv(name, "preview");
  for (const name of ["FISH_API_KEY", "FISH_AUDIO_API_KEY"]) vi.stubEnv(name, "");
  mock.session.mockResolvedValue({ user: { sub: "auth0|owner" } });
  mock.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("deployment_identity")
    ? [{ project: "personal-voice-reader", environment: "preview" }] : [] }));
});
afterEach(() => vi.unstubAllEnvs());

it("allows the owner guard and document reads with real config validation and no Fish key", async () => {
  expect(await requireOwner()).toBe("auth0|owner");
  const response = await documents();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ documents: [] });
});
it("still rejects missing sessions, wrong users and wrong resource environments", async () => {
  mock.session.mockResolvedValue(null);
  await expect(requireOwner()).rejects.toMatchObject({ status: 401 });
  mock.session.mockResolvedValue({ user: { sub: "auth0|other" } });
  await expect(requireOwner()).rejects.toMatchObject({ status: 403 });
  mock.session.mockResolvedValue({ user: { sub: "auth0|owner" } });
  mock.query.mockResolvedValue({ rows: [{ project: "personal-voice-reader", environment: "production" }] });
  await expect(requireOwner()).rejects.toMatchObject({ code: "RESOURCE_MISMATCH" });
});
it("rejects unconfigured Fish generation and retries before queue mutation", async () => {
  const request = () => new Request("https://synthetic.test/api/tts", { method: "POST", headers: { Origin: "https://synthetic.test" }, body: JSON.stringify({ voiceId: "voice_test", documentId: "doc_test", speed: 1, idempotencyKey: "synthetic-request" }) });
  for (const response of [await tts(request()), await retry(request(), { params: Promise.resolve({ id: "job_test" }) })]) {
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_NOT_CONFIGURED" });
  }
  expect(mock.queue).not.toHaveBeenCalled();
  expect(mock.dispatch).not.toHaveBeenCalled();
  expect((await recover(new Request("https://synthetic.test/api/jobs/recover"))).status).toBe(401);
});

it("lets authorized recovery inspect tasks without a globally required Fish key", async () => {
  mock.dispatch.mockResolvedValue(0);
  const response = await recover(new Request("https://synthetic.test/api/jobs/recover", { headers: { Authorization: "Bearer synthetic" } }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ checked: 0 });
});
