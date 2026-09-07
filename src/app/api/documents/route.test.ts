/**
 * Backend integration tests for the documents API.
 * Uses an isolated temp dir for each test run so the real .data store
 * and user documents are never touched. No Fish / TTS calls occur —
 * only the chunker and the JSON store are exercised.
 */
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Store tmpDir and reset between tests so modules reading dataRoot at
// require-time pick up the right value via the env var.
let tmpDir: string;

// We import the route handlers lazily after setting VOICE_READER_DATA_DIR.
// vi.resetModules() ensures each test suite gets fresh module state.
import { vi } from "vitest";
import { TEST_OWNER } from "@/test/database";
vi.mock("@/lib/auth", () => ({ requireOwner: async () => TEST_OWNER }));
let fixture: Awaited<ReturnType<typeof import("@/test/database").testDatabase>>;

async function loadRoutes() {
  // Wipe module registry so the store re-reads the env var.
  vi.resetModules();
  fixture = await (await import("@/test/database")).testDatabase();
  process.env.AUTH0_OWNER_SUB = TEST_OWNER;
  // Import store before routes so all three share the same fresh instance.
  const store = await import("@/lib/store");
  const listRoute = await import("./route");
  const idRoute = await import("./[id]/route");
  return { store, listRoute, idRoute };
}

beforeEach(async () => {
  tmpDir = await mkTmpDir();
  process.env.VOICE_READER_DATA_DIR = tmpDir;
});

afterEach(async () => {
  await fixture?.close();
  delete process.env.VOICE_READER_DATA_DIR;
  await rm(tmpDir, { recursive: true, force: true });
});

async function mkTmpDir() {
  const dir = path.join(os.tmpdir(), `pvr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// Helper: simulate a POST to /api/documents
async function postDocument(opts: { text: string; title?: string }, routes: Awaited<ReturnType<typeof loadRoutes>>) {
  const req = new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  return routes.listRoute.POST(req);
}

// Helper: simulate GET /api/documents
async function getDocuments(routes: Awaited<ReturnType<typeof loadRoutes>>) {
  return routes.listRoute.GET();
}

// Helper: simulate GET /api/documents/[id]
async function getDocument(id: string, routes: Awaited<ReturnType<typeof loadRoutes>>) {
  const fakeReq = new Request(`http://localhost/api/documents/${id}`);
  return routes.idRoute.GET(fakeReq, { params: Promise.resolve({ id }) });
}

describe("GET /api/documents", () => {
  it("returns empty list when no documents exist", async () => {
    const routes = await loadRoutes();
    const res = await getDocuments(routes);

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json() as { documents: unknown[] };
    expect(body.documents).toEqual([]);
  });

  it("returns DocumentSummary shape — no segments or originalText", async () => {
    const routes = await loadRoutes();
    await postDocument({ text: "你好，世界。这是一段测试文字。", title: "测试文章" }, routes);

    const res = await getDocuments(routes);
    const body = await res.json() as { documents: Record<string, unknown>[] };

    expect(body.documents).toHaveLength(1);
    const summary = body.documents[0];

    // Required fields
    expect(typeof summary.id).toBe("string");
    expect(typeof summary.title).toBe("string");
    expect(typeof summary.createdAt).toBe("string");
    expect(typeof summary.characterCount).toBe("number");
    expect(typeof summary.segmentCount).toBe("number");
    expect(typeof summary.preview).toBe("string");

    // Forbidden fields
    expect(summary).not.toHaveProperty("originalText");
    expect(summary).not.toHaveProperty("segments");
  });

  it("preview is originalText.slice(0, 100)", async () => {
    const routes = await loadRoutes();
    const longText = "好".repeat(200);
    await postDocument({ text: longText }, routes);

    const res = await getDocuments(routes);
    const body = await res.json() as { documents: { preview: string }[] };
    expect(body.documents[0].preview).toBe(longText.slice(0, 100));
  });

  it("returns all saved documents, newest first", async () => {
    const routes = await loadRoutes();
    await postDocument({ text: "第一篇文章。", title: "第一" }, routes);
    // Small delay to ensure distinct createdAt timestamps
    await new Promise((r) => setTimeout(r, 10));
    await postDocument({ text: "第二篇文章。", title: "第二" }, routes);
    await new Promise((r) => setTimeout(r, 10));
    await postDocument({ text: "第三篇文章。", title: "第三" }, routes);

    const res = await getDocuments(routes);
    const body = await res.json() as { documents: { title: string }[] };

    expect(body.documents).toHaveLength(3);
    expect(body.documents[0].title).toBe("第三");
    expect(body.documents[1].title).toBe("第二");
    expect(body.documents[2].title).toBe("第一");
  });

  it("keeps older sessions when saving beyond 100 snapshots", async () => {
    const routes = await loadRoutes();
    const response = await postDocument({ text: "最早的会话。", title: "最早" }, routes);
    const { document: oldest } = await response.json();
    const template = await routes.store.findDocument(oldest.id);
    for (let index = 0; index < 100; index++) {
      await routes.store.addDocument({ ...template, id: `doc_fixture_${index}`, segments: [] });
    }
    await postDocument({ text: "新的会话。", title: "最新" }, routes);
    const body = await (await getDocuments(routes)).json();
    expect(body.documents).toHaveLength(102);
    expect((await getDocument(oldest.id, routes)).status).toBe(200);
  });
});

describe("GET /api/documents/[id]", () => {
  it("returns 404 for unknown id", async () => {
    const routes = await loadRoutes();
    const res = await getDocument("doc_does_not_exist", routes);

    expect(res.status).toBe(404);
    const body = await res.json() as { code: string };
    expect(body.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("returns the full document including originalText", async () => {
    const routes = await loadRoutes();
    const originalText = "这是完整的原始文字，应该被完整保存并返回。";
    const postRes = await postDocument({ text: originalText, title: "完整文章" }, routes);
    const postBody = await postRes.json() as { document: { id: string } };
    const id = postBody.document.id;

    const res = await getDocument(id, routes);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = await res.json() as {
      document: {
        id: string;
        title: string;
        originalText: string;
        characterCount: number;
        segments: { id: string; audioUrl: string | null }[];
      };
    };

    expect(body.document.id).toBe(id);
    expect(body.document.originalText).toBe(originalText);
    expect(body.document.characterCount).toBe(originalText.length);
    expect(Array.isArray(body.document.segments)).toBe(true);
    expect(body.document.segments.length).toBeGreaterThan(0);
  });

  it("preserves original segment ids and audioUrl (null initially)", async () => {
    const routes = await loadRoutes();
    const postRes = await postDocument({ text: "保存片段ID测试。" }, routes);
    const postBody = await postRes.json() as { document: { id: string; segments: { id: string }[] } };
    const docId = postBody.document.id;
    const firstSegId = postBody.document.segments[0].id;

    const res = await getDocument(docId, routes);
    const body = await res.json() as {
      document: { segments: { id: string; audioUrl: string | null }[] };
    };

    expect(body.document.segments[0].id).toBe(firstSegId);
    expect(body.document.segments[0].audioUrl).toBeNull();
  });

  it("creating a second document with same text produces a distinct id", async () => {
    const routes = await loadRoutes();
    const text = "重复提交测试。";
    const r1 = await postDocument({ text }, routes);
    const r2 = await postDocument({ text }, routes);
    const b1 = await r1.json() as { document: { id: string } };
    const b2 = await r2.json() as { document: { id: string } };

    expect(b1.document.id).not.toBe(b2.document.id);

    // Both retrievable independently
    const [res1, res2] = await Promise.all([
      getDocument(b1.document.id, routes),
      getDocument(b2.document.id, routes),
    ]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
  });

  it("returns ready-segment fields (voiceId, speed, audioHash, audioUrl) unchanged", async () => {
    // Arrange: create a document then simulate TTS completing on its first segment
    // by patching the store directly — no Fish call, no real MP3 file needed.
    const routes = await loadRoutes();
    const postRes = await postDocument({ text: "音频就绪片段测试。" }, routes);
    const postBody = await postRes.json() as {
      document: { id: string; segments: { id: string }[] };
    };
    const docId = postBody.document.id;
    const segId = postBody.document.segments[0].id;

    // Fake values that match the store's validation constraints:
    // audioHash must be 64 lowercase hex chars; audioUrl is an arbitrary string.
    const fakeHash = "a".repeat(64);
    const fakeVoiceId = "voice_test_001";
    const fakeAudioUrl = `/api/audio/${fakeHash}`;
    const fakeSpeed = 1.25;

    await fixture.db.query("UPDATE segments SET data=data || $3::jsonb WHERE owner=$1 AND id=$2",
      [TEST_OWNER, segId, JSON.stringify({ status: "ready", voiceId: fakeVoiceId, speed: fakeSpeed, audioHash: fakeHash, audioUrl: fakeAudioUrl })]);

    // Act
    const res = await getDocument(docId, routes);
    expect(res.status).toBe(200);

    const body = await res.json() as {
      document: {
        segments: {
          id: string;
          status: string;
          voiceId: string | null;
          speed: number | null;
          audioHash: string | null;
          audioUrl: string | null;
        }[];
      };
    };

    // Assert: every patched field comes back byte-identical
    const returnedSeg = body.document.segments.find((s) => s.id === segId)!;
    expect(returnedSeg.status).toBe("ready");
    expect(returnedSeg.voiceId).toBe(fakeVoiceId);
    expect(returnedSeg.speed).toBe(fakeSpeed);
    expect(returnedSeg.audioHash).toBe(fakeHash);
    expect(returnedSeg.audioUrl).toBe(fakeAudioUrl);
  });

  it("preserves originalText paragraph and newline formatting byte-for-byte", async () => {
    // Zod .trim() only removes leading/trailing whitespace; internal newlines
    // must survive the POST → store → GET round-trip unchanged.
    const routes = await loadRoutes();
    const originalText =
      "第一段落，句子一。句子二。\n\n第二段落，句子三。\n第二段落续行。\n\n第三段落。";

    const postRes = await postDocument({ text: originalText }, routes);
    const postBody = await postRes.json() as { document: { id: string } };

    const res = await getDocument(postBody.document.id, routes);
    const body = await res.json() as { document: { originalText: string } };

    expect(body.document.originalText).toBe(originalText);
  });
});
