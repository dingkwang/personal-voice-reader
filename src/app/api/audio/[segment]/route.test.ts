import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { makeDocument } from "@/lib/documents";
import { addDocument } from "@/lib/store";
import { GET } from "./route";
import { parseRange } from "@/lib/blob";
vi.mock("@/lib/auth", () => ({ requireOwner: async () => TEST_OWNER }));
vi.mock("@vercel/blob", () => ({
  get: vi.fn(async (_path: string, options: { headers?: { Range: string } }) => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const range = parseRange(options.headers?.Range || null, bytes.length);
    const selected = range && range !== "invalid" ? bytes.slice(range.start, range.end + 1) : bytes;
    return { stream: new Response(selected).body, headers: new Headers(range && range !== "invalid" ? { "content-range": `bytes ${range.start}-${range.end}/4` } : {}) };
  }),
}));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
let segment: string;
const original = "a".repeat(64), latest = "b".repeat(64);
beforeEach(async () => {
  fixture = await testDatabase();
  const document = makeDocument({ text: "合成测试。" });
  segment = document.segments[0].id;
  document.segments[0].audioHash = latest;
  await addDocument(document, TEST_OWNER);
  for (const key of [original, latest]) {
    await fixture.db.query("INSERT INTO audio_cache(owner,key,object_hash,pathname,size) VALUES($1,$2,$2,'audio/test',4)", [TEST_OWNER, key]);
    await fixture.db.query("INSERT INTO audio_versions VALUES($1,$2,$3)", [TEST_OWNER, segment, key]);
  }
});
afterEach(async () => fixture.close());
const get = (version?: string, range?: string) => GET(
  new Request(`http://localhost/api/audio/${segment}${version ? `?v=${version}` : ""}`, { headers: range ? { Range: range } : {} }),
  { params: Promise.resolve({ segment }) });
it("preserves historical audio and streams bounded Range bytes, never browser caches", async () => {
  const saved = await get(original.slice(0, 12));
  expect(saved.status).toBe(200);
  expect(saved.headers.get("etag")).toBe(`"${original}"`);
  expect(saved.headers.get("cache-control")).toBe("private, no-store");
  expect([...new Uint8Array(await saved.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  const range = await get(original, "bytes=1-2");
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 1-2/4");
  expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([2, 3]);
  expect((await get()).headers.get("etag")).toBe(`"${latest}"`);
  expect((await get("c".repeat(12))).status).toBe(404);
  expect((await get("../invalid")).status).toBe(404);
});
it.each(["bytes=-", "bytes=-0", "bytes=4-", "bytes=3-1", "bytes=1-2,3-4", "bytes=999999999999999999999-"])("rejects invalid range %s with size", async (value) => {
  const response = await get(original, value);
  expect(response.status).toBe(416);
  expect(response.headers.get("content-range")).toBe("bytes */4");
});
it.each([["bytes=-2", [3, 4]], ["bytes=2-", [3, 4]], ["bytes=0-99", [1, 2, 3, 4]]])("supports suffix and open ranges %s", async (value, expected) => {
  const response = await get(original, value as string);
  expect(response.status).toBe(206);
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(expected);
});
it("does not allow another segment's cache key", async () => {
  await fixture.db.query("DELETE FROM audio_versions WHERE key=$1", [original]);
  expect((await get(original)).status).toBe(404);
});
