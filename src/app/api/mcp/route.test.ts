import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testDatabase, TEST_OWNER } from "@/test/database";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ scopes: ["read:voices", "create:readings", "read:readings"] }));
vi.mock("@/lib/auth", () => ({ requireOAuth: async () => ({ owner: TEST_OWNER, scopes: mocks.scopes }) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeEach(async () => {
  fixture = await testDatabase();
  vi.stubEnv("DEFAULT_VOICE_ID", "voice_test");
  vi.stubEnv("APP_BASE_URL", "https://synthetic.test");
  mocks.scopes = ["read:voices", "create:readings", "read:readings"];
});
afterEach(async () => { await fixture.close(); vi.unstubAllEnvs(); });
async function call(method: string, params = {}) {
  return POST(new Request("https://synthetic.test/api/mcp", { method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
}
it("uses the Streamable HTTP SDK and exposes accurate annotations", async () => {
  const initialized = await (await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } })).json();
  expect(initialized.result.serverInfo.name).toBe("voice-note");
  const body = await (await call("tools/list")).json();
  expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual(["list_voices", "create_reading", "get_reading_status"]);
  expect(body.result.tools[1].annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
});
it("creates a saved queued session, returns stable absolute URL, and deduplicates retry", async () => {
  const params = { name: "create_reading", arguments: { text: "合成中文测试", title: "Synthetic", idempotency_key: "mcp-request" } };
  const one = await (await call("tools/call", params)).json();
  const two = await (await call("tools/call", params)).json();
  expect(one.result.structuredContent.status).toBe("queued");
  expect(one.result.structuredContent.url).toMatch(/^https:\/\/synthetic.test\/sessions\/doc_/);
  expect(two.result.structuredContent).toEqual(one.result.structuredContent);
});
it("enforces write scope at the tool invocation, not just at transport auth", async () => {
  mocks.scopes = ["read:voices"];
  const response = await (await call("tools/call", { name: "create_reading", arguments: { text: "合成测试", idempotency_key: "forbidden-key" } })).json();
  expect(response.result.isError).toBe(true);
  expect((await fixture.db.query("SELECT * FROM jobs")).rows).toHaveLength(0);
});
