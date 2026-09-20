import { hkdfSync } from "node:crypto";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EncryptJWT, exportJWK, generateKeyPair, SignJWT } from "jose";
import { NextRequest } from "next/server";
import { GET } from "@/app/auth/[...path]/route";

const mock = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@auth0/nextjs-auth0/server", async (original) => {
  const sdk = await original<typeof import("@auth0/nextjs-auth0/server")>();
  return { ...sdk, Auth0Client: class extends sdk.Auth0Client {
    constructor(options: ConstructorParameters<typeof sdk.Auth0Client>[0]) {
      super({ ...options, customFetch: mock.fetch });
    }
  } };
});

const origin = "https://synthetic.test", issuer = "https://synthetic.auth0.com/";
const secret = "0".repeat(64);
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let token = "";
beforeAll(async () => { keys = await generateKeyPair("RS256"); });
beforeEach(() => {
  for (const [name, value] of Object.entries({
    AUTH0_SECRET: secret, AUTH0_CLIENT_ID: "synthetic-web", AUTH0_CLIENT_SECRET: "synthetic-only",
    AUTH0_DOMAIN: "synthetic.auth0.com", AUTH0_OWNER_SUB: "auth0|owner", APP_BASE_URL: origin,
  })) vi.stubEnv(name, value);
  // No real OAuth, remote JWKS or provider calls are allowed.
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  mock.fetch.mockReset().mockImplementation(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.origin !== new URL(issuer).origin) throw new Error("Unexpected test origin");
    if (url.pathname === "/.well-known/openid-configuration") return Response.json({
      issuer, authorization_endpoint: `${issuer}authorize`, token_endpoint: `${issuer}oauth/token`,
      jwks_uri: `${issuer}.well-known/jwks.json`, response_types_supported: ["code"],
      subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
    });
    if (url.pathname === "/oauth/token") return Response.json({
      access_token: "synthetic-access", id_token: token, token_type: "Bearer", expires_in: 3600,
    });
    if (url.pathname === "/.well-known/jwks.json") return Response.json({
      keys: [{ ...await exportJWK(keys.publicKey), kid: "synthetic-key", alg: "RS256" }],
    });
    throw new Error("Unexpected test endpoint");
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function callback(sub: string, returnTo = "/sessions/doc_safe", claims: { iss?: string; aud?: string; exp?: string; nonce?: string } = {}) {
  token = await new SignJWT({ sub, nonce: claims.nonce || "synthetic-nonce" }).setProtectedHeader({ alg: "RS256", kid: "synthetic-key" })
    .setIssuer(claims.iss || issuer).setAudience(claims.aud || "synthetic-web").setIssuedAt().setExpirationTime(claims.exp || "5m").sign(keys.privateKey);
  const key = new Uint8Array(hkdfSync("sha256", secret, "", "JWE CEK", 32));
  const transaction = await new EncryptJWT({
    state: "synthetic-state", nonce: "synthetic-nonce", codeVerifier: "synthetic-verifier",
    responseType: "code", returnTo,
  }).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setExpirationTime("5m").encrypt(key);
  return GET(new NextRequest(`${origin}/auth/callback?state=synthetic-state&code=synthetic-code`, {
    headers: { cookie: `__txn_synthetic-state=${transaction}` },
  }));
}

it.each(["auth0|other", "auth0|owner-extra", "google-oauth2|owner"])("accepts a verified tenant subject without linking identities: %s", async (subject) => {
  const response = await callback(subject);
  expect(response.status).toBe(307);
  expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session"))).toBe(true);
  expect(response.headers.get("location")).toBe(`${origin}/sessions/doc_safe`);
});

it("retains the original database owner's login and safe session deep links", async () => {
  const response = await callback("auth0|owner");
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe(`${origin}/sessions/doc_safe`);
  expect(response.headers.has("set-cookie")).toBe(true);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it.each([{ iss: "https://other.auth0.com/" }, { aud: "other-client" }, { exp: "-5m" }, { nonce: "wrong" }])(
  "keeps SDK issuer, audience, expiry and nonce validation", async (claims) => {
    const response = await callback("google-oauth2|synthetic", "/", claims);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session"))).toBe(false);
    expect(response.headers.has("location")).toBe(false);
  },
);

it.each(["", "   "])("does not store an identity-less session", async (sub) => {
  const response = await callback(sub);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session"))).toBe(false);
});

it.each(["//evil.test", "/auth/login", "/sessions/doc_safe?code=synthetic-private"])(
  "clamps unsafe callback returnTo even in a valid SDK transaction", async (returnTo) => {
    const response = await callback("auth0|owner", returnTo);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${origin}/`);
  },
);

it.each(["missing", "absent-cookie", "invalid-cookie"])("handles real SDK transaction failure: %s", async (kind) => {
  const response = await GET(new NextRequest(`${origin}/auth/callback${kind === "missing" ? "" : "?state=synthetic-state"}`, {
    headers: kind === "invalid-cookie" ? { cookie: "__txn_synthetic-state=synthetic-invalid" } : {},
  }));
  expect(response.status).toBe(400);
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.has("location")).toBe(false);
  expect(await response.text()).toContain("登录验证未完成");
  expect(mock.fetch).not.toHaveBeenCalled();
});

it("sanitizes a real SDK token failure and leaves no authenticated session", async () => {
  const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
  const normalFetch = mock.fetch.getMockImplementation()!;
  mock.fetch.mockImplementation(async (input: string | URL) => new URL(String(input)).pathname === "/oauth/token"
    ? Response.json({ error: "invalid_grant", error_description: "synthetic-private-payload" }, { status: 400 })
    : normalFetch(input));
  const response = await callback("auth0|owner");
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).toContain("登录凭据验证未完成");
  expect(body).not.toContain("synthetic-private-payload");
  // The SDK may delete the transaction cookie, but must not save a session.
  expect(response.headers.getSetCookie().some((cookie) => cookie.startsWith("__session"))).toBe(false);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("uses the installed SDK to generate prompt=login without forwarding hostile parameters", async () => {
  const response = await GET(new NextRequest(`${origin}/auth/login?prompt=login&returnTo=//evil.test&challengeMode=popup&scope=admin`));
  const location = new URL(response.headers.get("location")!);
  expect(response.status).toBe(307);
  expect(location.origin).toBe(new URL(issuer).origin);
  expect(location.searchParams.get("prompt")).toBe("login");
  expect(location.searchParams.get("scope")).toBe("openid profile");
  expect(location.searchParams.get("redirect_uri")).toBe(`${origin}/auth/callback`);
  expect(location.searchParams.has("challengeMode")).toBe(false);
  expect(response.headers.has("set-cookie")).toBe(true);
});
