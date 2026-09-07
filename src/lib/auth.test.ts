import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { assertCsrf, assertTokenClaims, requireOAuth, requireOwner } from "./auth";
const mock = vi.hoisted(() => ({ getSession: vi.fn(), keys: undefined as unknown }));
vi.mock("@auth0/nextjs-auth0/server", () => ({ Auth0Client: class { getSession = mock.getSession; } }));
vi.mock("jose", async (original) => ({ ...await original<typeof import("jose")>(), createRemoteJWKSet: () => mock.keys }));
vi.mock("./config", async (original) => ({ ...await original<typeof import("./config")>(), validateResourceIdentity: async () => {} }));
let key: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
beforeEach(async () => {
  vi.stubEnv("AUTH0_OWNER_SUB", "auth0|owner");
  vi.stubEnv("AUTH0_MCP_CLIENT_ID", "mcp-client");
  vi.stubEnv("AUTH0_DOMAIN", "synthetic.auth0.com");
  vi.stubEnv("AUTH0_AUDIENCE", "https://synthetic.test/api/mcp");
  vi.stubEnv("AUTH0_CLIENT_ID", "synthetic-web");
  vi.stubEnv("AUTH0_CLIENT_SECRET", "synthetic-not-a-real-secret");
  vi.stubEnv("AUTH0_SECRET", "0".repeat(64));
  vi.stubEnv("APP_BASE_URL", "https://synthetic.test");
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  mock.keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: "test", alg: "RS256" }] });
  mock.getSession.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it("checks exact origin on every cookie mutation, including missing Origin", () => {
  const request = (origin?: string) => new Request("https://synthetic.test/api/tts", { method: "POST", headers: origin ? { Origin: origin } : {} });
  expect(() => assertCsrf(request("https://synthetic.test"))).not.toThrow();
  expect(() => assertCsrf(request("https://evil.test"))).toThrow();
  expect(() => assertCsrf(request())).toThrow();
});
it("requires the configured owner and authorized registered MCP client and scope", () => {
  const payload = { sub: "auth0|owner", azp: "mcp-client", scope: "read:voices", exp: 9999999999 };
  expect(assertTokenClaims(payload, "read:voices").owner).toBe("auth0|owner");
  expect(() => assertTokenClaims(payload, "create:readings")).toThrow();
  expect(() => assertTokenClaims({ ...payload, sub: "auth0|other" })).toThrow();
  expect(() => assertTokenClaims({ ...payload, azp: "other-client" })).toThrow();
});
async function token(options: { exp?: string; audience?: string; issuer?: string; scope?: string } = {}) {
  return new SignJWT({ sub: "auth0|owner", azp: "mcp-client", scope: options.scope || "read:voices" })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuedAt()
    .setIssuer(options.issuer || "https://synthetic.auth0.com/").setAudience(options.audience || "https://synthetic.test/api/mcp")
    .setExpirationTime(options.exp || "5m").sign(key);
}
it("validates real signed JWT issuer, audience, expiry and scopes", async () => {
  const request = async (options = {}) => new Request("https://synthetic.test/api/mcp", { headers: { Authorization: `Bearer ${await token(options)}` } });
  expect((await requireOAuth(await request(), "read:voices")).owner).toBe("auth0|owner");
  for (const options of [{ audience: "wrong" }, { issuer: "https://evil.test/" }, { exp: "-1m" }]) {
    await expect(requireOAuth(await request(options))).rejects.toMatchObject({ status: 401 });
  }
  await expect(requireOAuth(await request(), "create:readings")).rejects.toMatchObject({ status: 403 });
});
it("rejects cookie-only MCP access and bearer-only web access", async () => {
  await expect(requireOAuth(new Request("https://synthetic.test/api/mcp", { headers: { Cookie: "session=synthetic" } }))).rejects.toMatchObject({ status: 401 });
  mock.getSession.mockResolvedValue(null);
  await expect(requireOwner(new Request("https://synthetic.test/api/documents", { headers: { Authorization: `Bearer ${await token()}` } }))).rejects.toMatchObject({ status: 401 });
  mock.getSession.mockResolvedValue({ user: { sub: "auth0|other" } });
  await expect(requireOwner()).rejects.toMatchObject({ status: 403 });
});
