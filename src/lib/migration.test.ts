import { afterEach, beforeEach, expect, it } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { importLegacy } from "./migration";
import { sha256 } from "./blob";
import { makeDocument } from "./documents";
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => { fixture = await testDatabase(); });
afterEach(async () => fixture.close());
it("imports twice, preserves IDs, reference ID, old key and byte checksums", async () => {
  const doc = makeDocument({ text: "合成迁移测试。" });
  const key = "a".repeat(64);
  doc.segments[0].audioHash = key;
  const source = { voices: [{ id: "voice_legacy", name: "Synthetic legacy", provider: "fish", providerVoiceId: "preserved-synthetic-reference",
    language: "zh", createdAt: "2026-09-06T00:00:00Z", source: "cloned" }], documents: [doc], audioCache: { [key]: key } };
  const before = JSON.stringify(source);
  const bytes = new Uint8Array([2, 4, 6]).buffer;
  const persist = async () => ({ objectHash: sha256(new Uint8Array(bytes)), pathname: "audio/synthetic", size: 3 });
  const first = await importLegacy(source, TEST_OWNER, async () => bytes, persist);
  expect(await importLegacy(source, TEST_OWNER, async () => bytes, persist)).toEqual(first);
  expect(JSON.stringify(source)).toBe(before);
  expect((await fixture.db.query("SELECT id FROM documents")).rows).toEqual([{ id: doc.id }]);
  expect((await fixture.db.query("SELECT id FROM segments")).rows).toEqual([{ id: doc.segments[0].id }]);
  expect((await fixture.db.query("SELECT key,object_hash FROM audio_cache")).rows).toEqual([{ key, object_hash: sha256(new Uint8Array(bytes)) }]);
  expect((await fixture.db.query<{ data: { providerVoiceId: string } }>("SELECT data FROM voices WHERE id='voice_legacy'")).rows[0].data.providerVoiceId).toBe("preserved-synthetic-reference");
});
it("fails on conflicting original document content and never overwrites it", async () => {
  const doc = makeDocument({ text: "原始合成文本" });
  await importLegacy({ voices: [], documents: [doc], audioCache: {} }, TEST_OWNER, async () => new ArrayBuffer(0));
  await expect(importLegacy({ voices: [], documents: [{ ...doc, originalText: "冲突" }], audioCache: {} }, TEST_OWNER, async () => new ArrayBuffer(0))).rejects.toMatchObject({ status: 409 });
  expect((await fixture.db.query<{ data: { originalText: string } }>("SELECT data FROM documents")).rows[0].data.originalText).toBe(doc.originalText);
});
