import { afterEach, expect, it, vi } from "vitest";
import { AuthorizationCodeGrantError, AuthorizationCodeGrantRequestError, AuthorizationError,
  DiscoveryError, InvalidConfigurationError, InvalidStateError, MissingStateError, OAuth2Error,
  AccessTokenError, AccessTokenErrorCode } from "@auth0/nextjs-auth0/errors";
import { AppError } from "./errors";
import { loginFailureKind, loginFailureResponse, InvalidWebSession, safeLoginReturnTo } from "./web-login";

afterEach(() => vi.restoreAllMocks());

it("distinguishes invalid sessions from provider access_denied without an owner allowlist", () => {
  expect(loginFailureKind(new InvalidWebSession())).toBe("session");
  expect(loginFailureKind(new AppError("synthetic", 403, "FORBIDDEN"))).toBe("unknown");
  expect(loginFailureKind({ code: "INVALID_WEB_SESSION" })).toBe("unknown");
  const denied = new AuthorizationError({ cause: new OAuth2Error({ code: "access_denied" }) });
  expect(loginFailureKind(denied)).toBe("authorization");
});

it.each([
  [new MissingStateError(), "transaction"],
  [new InvalidStateError(), "transaction"],
  [new AuthorizationCodeGrantRequestError(), "token"],
  [new AuthorizationCodeGrantError({ cause: new OAuth2Error({ code: "invalid_grant" }) }), "token"],
  [new AccessTokenError(AccessTokenErrorCode.SESSION_EXPIRED, "synthetic"), "token"],
  [new DiscoveryError(), "unavailable"],
  [new InvalidConfigurationError(), "unavailable"],
] as const)("maps an allowlisted SDK failure to a fixed category", (error, kind) => {
  expect(loginFailureKind(error)).toBe(kind);
});

it("sanitizes unknown errors and SDK causes without logging or reflecting input", async () => {
  const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
  const marker = "synthetic-private-payload";
  const error = Object.assign(new Error(marker), {
    code: marker, cause: { cookie: marker, token: marker, user: marker, url: `https://${marker}.test` },
  });
  const unknown = await loginFailureResponse(error).text();
  expect(unknown).toContain("暂时无法确认失败原因");
  expect(unknown).not.toContain(marker);
  const sdk = new AuthorizationCodeGrantError({
    message: marker, cause: new OAuth2Error({ code: marker, message: marker }),
  });
  const response = loginFailureResponse(sdk);
  expect(await response.text()).not.toContain(marker);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.has("location")).toBe(false);
  expect(response.headers.has("set-cookie")).toBe(false);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("provides manual, fixed same-origin recovery links without retry scripts", async () => {
  const response = loginFailureResponse(new InvalidWebSession());
  expect(response.status).toBe(401);
  const body = await response.text();
  expect(body).toContain('href="/auth/login?prompt=login"');
  expect(body).toContain("使用其他账号登录");
  expect(body).toContain('href="/auth/login"');
  expect(body).toContain('<meta name="referrer" content="no-referrer">');
  expect(body).toContain('rel="noreferrer"');
  expect(body).not.toMatch(/<script|http-equiv|returnTo=|login_hint|<link/);
  expect(await loginFailureResponse(new InvalidStateError()).text()).not.toContain("刚才登录的账号没有访问权限");
});

it.each([
  undefined, null, "", "/", "//evil.test", "https://evil.test", "https://synthetic.test/sessions/doc_safe",
  "/\\evil.test", "/auth/login", "/auth/logout", "/api/mcp", "/sessions/../auth/login",
  "/sessions/%2e%2e", "/sessions/%2f%2fevil.test", "/sessions/doc_safe?returnTo=//evil.test",
  "/sessions/doc_safe#fragment", "/sessions/doc_safe\n", "/sessions/" + "a".repeat(129),
])("rejects unsafe or non-reader return destinations", (value) => {
  expect(safeLoginReturnTo(value)).toBe("/");
});

it("keeps valid reader deep links", () => {
  expect(safeLoginReturnTo("/sessions/doc_safe-123")).toBe("/sessions/doc_safe-123");
});
