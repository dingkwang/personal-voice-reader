import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { createReading, readingStatus, claimNext } from "./jobs";
import { ReplicateProvider } from "./providers/replicate";
import { generateNext } from "@/workflows/steps";
import { ownerPrefix, sha256, streamAudio } from "./blob";
import { webVoices, setWebVoice } from "./web-voices";
const mock = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn(), put: vi.fn(), head: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: mock.get, put: mock.put, head: mock.head }));
vi.mock("@/lib/config", async (original) => ({ ...await original<typeof import("./config")>(), validateResourceIdentity: async () => {} }));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
const raw = Buffer.from("RIFF0000WAVE" + "0".repeat(60));
beforeEach(async () => {
  fixture = await testDatabase();
  vi.stubEnv("AUTH0_OWNER_SUB", TEST_OWNER);
  vi.stubEnv("REPLICATE_API_KEY", "synthetic");
  vi.stubEnv("APP_BASE_URL", "https://synthetic.test");
  const hash = sha256(raw);
  await fixture.db.query("INSERT INTO voices(owner,id,data) VALUES($1,'voice_replicate',$2)", [TEST_OWNER, {
    id: "voice_replicate", provider: "replicate", providerVoiceId: hash, name: "Synthetic", language: "zh",
    reference: { pathname: `references/${ownerPrefix(TEST_OWNER)}/${hash}.wav`, hash, size: raw.length, seconds: 20 },
  }]);
  mock.get.mockReset().mockImplementation(async () => ({ stream: new Response(raw).body }));
  mock.put.mockReset().mockResolvedValue({});
  mock.fetch.mockReset().mockImplementation(async (_url, init) => Response.json({ id: "synthetic1", status: init?.method === "POST" ? "starting" : "processing" }));
  vi.stubGlobal("fetch", mock.fetch);
});
afterEach(async () => { await fixture.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const create = () => createReading({ text: "测试本人声音", voice_id: "voice_replicate", speed: 1, idempotency_key: randomUUID() });
async function due() { await fixture.db.query("UPDATE generation_claims SET poll_after=now()-interval '1 second'"); }

it("persists one prediction, survives polling failures, stores WAV and reuses cache", async () => {
  const job = await create();
  const claim = await claimNext(job.jobId, TEST_OWNER);
  if (typeof claim === "string") throw new Error("Missing claim");
  expect(await new ReplicateProvider().poll(claim)).toEqual({ status: "pending" });
  mock.fetch.mockRejectedValueOnce(new Error("poll timeout"));
  await due(); await generateNext(job.jobId, TEST_OWNER);
  mock.fetch.mockImplementation(async (url: string | URL) => String(url).includes("replicate.delivery") ? new Response(raw) : Response.json({ id: "synthetic1", status: "succeeded", output: "https://replicate.delivery/test.wav" }));
  await due(); await generateNext(job.jobId, TEST_OWNER);
  expect((await readingStatus(job.jobId)).status).toBe("completed");
  expect(mock.fetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
  expect(mock.fetch.mock.calls[0][1].headers["Cancel-After"]).toBe("5m");
  expect(mock.put.mock.calls[0][0]).toMatch(/\.wav$/);
  expect(mock.put.mock.calls[0][2].contentType).toBe("audio/wav");
  const repeated = await create();
  expect(await generateNext(repeated.jobId, TEST_OWNER)).toBe("done");
  expect(mock.fetch.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(1);
});
it("quarantines a lost creation reply without repeating the paid POST", async () => {
  const job = await create(); mock.fetch.mockRejectedValue(new Error("lost POST reply"));
  await generateNext(job.jobId, TEST_OWNER);
  await due(); await generateNext(job.jobId, TEST_OWNER);
  expect(mock.fetch).toHaveBeenCalledTimes(1);
  expect((await readingStatus(job.jobId)).items[0].status).toBe("uncertain");
});
it("fails terminal predictions and rejects non-1x settings", async () => {
  await expect(createReading({ text: "测试", voice_id: "voice_replicate", speed: 1.5, idempotency_key: randomUUID() })).rejects.toMatchObject({ status: 422 });
  mock.fetch.mockImplementation(async () => Response.json({ id: "synthetic1", status: "failed" }));
  const job = await create(); await generateNext(job.jobId, TEST_OWNER);
  expect((await readingStatus(job.jobId)).items[0].status).toBe("error");
});
it("keeps references private and validates ownership", async () => {
  await setWebVoice(TEST_OWNER, "voice_replicate");
  expect((await webVoices(TEST_OWNER)).voices.find((v) => v.id === "voice_replicate")).not.toHaveProperty("reference");
  await fixture.db.query("UPDATE voices SET data=jsonb_set(data,'{reference,pathname}','\"references/other/audio.wav\"') WHERE id='voice_replicate'");
  const job = await create(); await generateNext(job.jobId, TEST_OWNER);
  expect(mock.get).not.toHaveBeenCalled(); expect(mock.fetch).not.toHaveBeenCalled();
});
it("caps preview submissions and rejects untrusted result URLs", async () => {
  await fixture.db.query("INSERT INTO replicate_requests(owner,attempt) SELECT $1,'reserved-'||n FROM generate_series(1,6) n", [TEST_OWNER]);
  const blocked = await create(); await generateNext(blocked.jobId, TEST_OWNER);
  expect(mock.fetch).not.toHaveBeenCalled();
  expect((await readingStatus(blocked.jobId)).items[0].status).toBe("error");
  await fixture.db.query("DELETE FROM replicate_requests");
  mock.fetch.mockImplementation(async () => Response.json({ id: "synthetic1", status: "succeeded", output: "https://attacker.test/audio" }));
  const job = await create(); await generateNext(job.jobId, TEST_OWNER);
  expect((await readingStatus(job.jobId)).items[0].status).toBe("error");
  expect(mock.fetch.mock.calls.every((c) => String(c[0]).startsWith("https://api.replicate.com/"))).toBe(true);
});
it("streams WAV ranges with the correct MIME", async () => {
  mock.get.mockResolvedValue({ stream: new Response(raw.subarray(1, 10)).body, headers: new Headers({ "content-range": `bytes 1-9/${raw.length}` }) });
  const response = await streamAudio(new Request("https://synthetic.test/audio", { headers: { Range: "bytes=1-9" } }), { pathname: "audio/test.wav", size: raw.length, object_hash: sha256(raw) });
  expect(response.status).toBe(206); expect(response.headers.get("content-type")).toBe("audio/wav");
  expect((await response.arrayBuffer()).byteLength).toBe(9);
});
