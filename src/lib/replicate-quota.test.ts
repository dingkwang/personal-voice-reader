import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { ownerLock, setTestDatabase, type Database } from "./db";
import { ownerPrefix, sha256 } from "./blob";
import { claimNext, createReading, retrySegment, uncertainGeneration } from "./jobs";
import { ReplicateProvider } from "./providers/replicate";
import { MAX_DAILY_ATTEMPTS, replicateDailyUsage, requireReplicateCapacity } from "./replicate-quota";

const mock = vi.hoisted(() => ({ fetch: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: mock.get }));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let db: Database;
let instant: Date;
let afterOwnerLock: (() => void) | undefined;
let queries: string[];
const raw = Buffer.from("RIFF0000WAVE" + "0".repeat(60));

// Replace only the clock input. Run the real quota SQL in ephemeral PostgreSQL.
function fixedClock(engine: Database): Database {
  return {
    async query<T>(sql: string, values: unknown[] = []) {
      queries.push(sql);
      const result = await engine.query<T>(
        sql.replaceAll("clock_timestamp()", `$${values.length + 1}::timestamptz`),
        sql.includes("clock_timestamp()") ? [...values, instant.toISOString()] : values);
      if (sql === "SELECT id FROM owners WHERE id=$1 FOR UPDATE") afterOwnerLock?.();
      return result;
    },
    transaction: (run) => engine.transaction((tx) => run(fixedClock(tx))),
  };
}

beforeEach(async () => {
  fixture = await testDatabase();
  instant = new Date("2026-09-13T19:00:00Z");
  afterOwnerLock = undefined;
  queries = [];
  db = fixedClock(fixture.db);
  setTestDatabase(db);
  vi.spyOn(Date, "now").mockImplementation(() => instant.getTime());
  vi.stubEnv("REPLICATE_API_KEY", "synthetic");
  const hash = sha256(raw);
  await db.query("INSERT INTO voices(owner,id,data) VALUES($1,'voice_replicate',$2)", [TEST_OWNER, {
    id: "voice_replicate", provider: "replicate", providerVoiceId: hash, name: "Synthetic", language: "zh",
    reference: { pathname: `references/${ownerPrefix(TEST_OWNER)}/${hash}.wav`, hash, size: raw.length, seconds: 20 },
  }]);
  mock.get.mockReset().mockImplementation(async () => ({ stream: new Response(raw).body }));
  mock.fetch.mockReset().mockImplementation(async (_url, init) =>
    Response.json({ id: "synthetic1", status: init?.method === "POST" ? "starting" : "processing" }));
  vi.stubGlobal("fetch", mock.fetch);
});
afterEach(async () => {
  await fixture.close();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

const key = (value: string) => sha256(value);
const create = (text = "合成测试") => createReading({
  text, voice_id: "voice_replicate", speed: 1, idempotency_key: randomUUID(),
}, TEST_OWNER);
async function claim(text = "合成测试") {
  const job = await create(text);
  const result = await claimNext(job.jobId, TEST_OWNER);
  if (typeof result === "string") throw new Error("Missing claim");
  return result;
}
async function attempts(count: number, at = instant.toISOString(), owner = TEST_OWNER) {
  await db.query(`INSERT INTO replicate_requests(owner,attempt,created_at)
    SELECT $1,$2||n,$3 FROM generate_series(1,$4::int) n`, [owner, randomUUID(), at, count]);
}
const capacity = (keys: string[]) => db.transaction(async (tx) => {
  await ownerLock(tx, TEST_OWNER);
  await requireReplicateCapacity(tx, TEST_OWNER, keys);
});
const usage = () => db.transaction(async (tx) => {
  await ownerLock(tx, TEST_OWNER);
  return replicateDailyUsage(tx, TEST_OWNER);
});
async function cache(cacheKey: string) {
  await db.query("INSERT INTO audio_cache(owner,key,object_hash,pathname,size) VALUES($1,$2,$2,'audio/synthetic.wav',72)",
    [TEST_OWNER, cacheKey]);
}

it.each([
  ["winter", "2026-01-16T06:30:00Z", "2026-01-15T08:00:00Z", "2026-01-16T08:00:00Z", 24],
  ["summer", "2026-09-14T06:30:00Z", "2026-09-13T07:00:00Z", "2026-09-14T07:00:00Z", 24],
  ["spring before jump", "2026-03-08T09:59:59Z", "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z", 23],
  ["spring after jump", "2026-03-08T10:00:00Z", "2026-03-08T08:00:00Z", "2026-03-09T07:00:00Z", 23],
  ["fall first 01:30", "2026-11-01T08:30:00Z", "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", 25],
  ["fall second 01:30", "2026-11-01T09:30:00Z", "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", 25],
  ["exact midnight", "2026-09-14T07:00:00Z", "2026-09-14T07:00:00Z", "2026-09-15T07:00:00Z", 24],
])("uses inclusive/exclusive LA bounds: %s", async (_name, now, start, end, hours) => {
  instant = new Date(now);
  await db.query("SET TIME ZONE 'Asia/Tokyo'");
  await db.query(`INSERT INTO replicate_requests(owner,attempt,created_at) VALUES
    ($1,'before',$2::timestamptz-interval '1 microsecond'),($1,'next',$3)`, [TEST_OWNER, start, end]);
  expect((await usage()).used).toBe(0);
  await db.query("INSERT INTO replicate_requests(owner,attempt,created_at) VALUES($1,'start',$2)", [TEST_OWNER, start]);
  expect((await usage()).used).toBe(1);
  await db.query(`INSERT INTO replicate_requests(owner,attempt,created_at)
    VALUES($1,'last',$2::timestamptz-interval '1 microsecond')`, [TEST_OWNER, end]);
  expect((Date.parse(end) - Date.parse(start)) / 3_600_000).toBe(hours);
  expect(await usage()).toEqual({ used: 2, startedAt: instant });
});

it("counts all current-day attempt statuses, but not previous days or other owners", async () => {
  await attempts(1000, "2026-09-13T06:59:59.999Z");
  await db.query("INSERT INTO owners(id) VALUES('synthetic-other')");
  await attempts(1000, instant.toISOString(), "synthetic-other");
  await db.query(`INSERT INTO replicate_requests(owner,attempt,status,created_at)
    SELECT $1,status,status,$2 FROM unnest(ARRAY['submitting','polling','ready','error','uncertain']) status`,
  [TEST_OWNER, instant]);
  expect((await usage()).used).toBe(5);
});

it.each(["previous", "current"])("admits 102 uncached items with 63 %s-day attempts", async (day) => {
  await attempts(63, day === "previous" ? "2026-09-13T06:59:59Z" : instant.toISOString());
  const job = await create(Array.from({ length: 102 }, (_, i) => `第 ${i + 1} 段合成测试。`).join("\n\n"));
  expect((await db.query("SELECT DISTINCT key FROM job_items WHERE owner=$1 AND job_id=$2",
    [TEST_OWNER, job.jobId])).rows).toHaveLength(102);
  expect(mock.fetch).not.toHaveBeenCalled();
  expect((await db.query("SELECT attempt FROM replicate_requests")).rows).toHaveLength(63);
});

it("allows exactly 1000 daily attempts and keeps cached requests free", async () => {
  expect(MAX_DAILY_ATTEMPTS).toBe(1000);
  await attempts(999);
  await expect(capacity([key("last"), key("last")])).resolves.toBeUndefined();
  await expect(capacity([key("last"), key("overflow")])).rejects.toMatchObject({ status: 422, code: "QUOTA_EXCEEDED" });
  await attempts(1);
  await cache(key("cached"));
  await expect(capacity([key("cached")])).resolves.toBeUndefined();
  await expect(capacity([key("new")])).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});

it("deduplicates carried-over queued/working reservations and excludes cached or other-provider keys", async () => {
  const working = await claim();
  await create();
  await createReading({ text: "其他提供商", voice_id: "voice_test", speed: 1, idempotency_key: randomUUID() }, TEST_OWNER);
  await db.query("UPDATE jobs SET created_at='2026-09-12T19:00:00Z'");
  await attempts(998);
  await cache(key("cached"));
  await expect(capacity([working.key, working.key, key("cached"), key("last")])).resolves.toBeUndefined();
  await expect(capacity([key("last"), key("overflow")])).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
  await cache(working.key);
  await expect(capacity([key("last"), key("overflow")])).resolves.toBeUndefined();
  expect(mock.fetch).not.toHaveBeenCalled();
});

it.each(["previous", "current"])("does not double-reserve a working attempt submitted on the %s day", async (day) => {
  const started = await claim();
  const queued = await create("未提交的排队任务");
  const queuedKey = (await db.query<{ key: string }>("SELECT key FROM job_items WHERE job_id=$1", [queued.jobId])).rows[0].key;
  await db.query("INSERT INTO replicate_requests(owner,attempt,created_at) VALUES($1,$2,$3)",
    [TEST_OWNER, started.attempt, day === "previous" ? "2026-09-13T06:59:59Z" : instant]);
  await attempts(day === "previous" ? 999 : 998);
  await expect(capacity([queuedKey])).resolves.toBeUndefined();
  await expect(capacity([key("new")])).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
});

it("rechecks submission capacity after preflight without starting a paid POST", async () => {
  const generation = await claim();
  await attempts(1000);
  await expect(new ReplicateProvider().poll(generation)).rejects.toMatchObject({ status: 422, code: "QUOTA_EXCEEDED" });
  expect(mock.fetch).not.toHaveBeenCalled();
  expect((await db.query("SELECT 1 FROM replicate_requests WHERE attempt=$1", [generation.attempt])).rows).toHaveLength(0);
});

it("serializes competing submissions at 999 and permits polling at 1000", async () => {
  const claims = [await claim("第一段"), await claim("第二段")];
  await attempts(1000, "2026-09-13T06:59:59Z");
  await attempts(999);
  const provider = new ReplicateProvider();
  const results = await Promise.allSettled(claims.map((generation) => provider.poll(generation)));
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "QUOTA_EXCEEDED" } });
  const accepted = claims[results.findIndex((result) => result.status === "fulfilled")];
  expect(await provider.poll(accepted)).toEqual({ status: "pending" });
  expect((await usage()).used).toBe(1000);
  expect(mock.fetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
});

it("keeps duplicate claim submissions idempotent at the daily limit", async () => {
  const generation = await claim();
  await attempts(999);
  const provider = new ReplicateProvider();
  await Promise.all([provider.poll(generation), provider.poll(generation)]);
  expect((await usage()).used).toBe(1000);
  expect(mock.fetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
});

it("timestamps a new submission after a lock wait crosses LA midnight", async () => {
  instant = new Date("2026-09-14T06:59:59Z");
  const generation = await claim();
  await attempts(1000);
  afterOwnerLock = () => { instant = new Date("2026-09-14T07:00:00Z"); };
  queries = [];
  expect(await new ReplicateProvider().poll(generation)).toEqual({ status: "pending" });
  const locked = queries.indexOf("SELECT id FROM owners WHERE id=$1 FOR UPDATE");
  expect(locked).toBeGreaterThanOrEqual(0);
  expect(queries.findIndex((sql) => sql.includes("clock_timestamp()"))).toBeGreaterThan(locked);
  const row = (await db.query<{ created_at: Date; deadline: Date }>(
    "SELECT created_at,deadline FROM replicate_requests WHERE owner=$1 AND attempt=$2", [TEST_OWNER, generation.attempt])).rows[0];
  expect(row.created_at).toEqual(instant);
  expect(row.deadline.getTime() - instant.getTime()).toBe(25 * 60_000);
  expect((await usage()).used).toBe(1);
});

it.each(["processing", "uncertain"])("does not resubmit yesterday's %s attempt after reset", async (status) => {
  instant = new Date("2026-09-14T06:59:59Z");
  const generation = await claim();
  const provider = new ReplicateProvider();
  if (status === "uncertain") mock.fetch.mockRejectedValue(new Error("lost POST reply"));
  expect(await provider.poll(generation)).toEqual({ status: status === "uncertain" ? "uncertain" : "pending" });
  if (status === "uncertain") await uncertainGeneration(generation);
  expect((await usage()).used).toBe(1);
  instant = new Date("2026-09-14T07:00:01Z");
  expect((await usage()).used).toBe(0);
  expect(await provider.poll(generation)).toEqual({ status: status === "uncertain" ? "uncertain" : "pending" });
  if (status === "uncertain") {
    await expect(retrySegment(generation.job.id, generation.segment.id, false, TEST_OWNER))
      .rejects.toMatchObject({ code: "BILLING_ACK_REQUIRED" });
    await expect(retrySegment(generation.job.id, generation.segment.id, true, TEST_OWNER))
      .rejects.toMatchObject({ code: "REQUEST_STILL_UNCERTAIN" });
    expect((await db.query("SELECT * FROM generation_claims")).rows).toHaveLength(1);
  }
  expect(mock.fetch.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
  expect((await db.query("SELECT * FROM replicate_requests")).rows).toHaveLength(1);
});
