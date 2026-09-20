import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { InvalidStateError } from "@auth0/nextjs-auth0/errors";
import { GET } from "./route";
import { InvalidWebSession } from "@/lib/web-login";

const mock = vi.hoisted(() => ({ middleware: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth0: () => mock }));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

it.each([
  [new InvalidWebSession(), 401, "登录凭据无效"],
  [new InvalidStateError(), 400, "登录验证未完成"],
  [new Error("synthetic-private-payload"), 500, "暂时无法确认失败原因"],
] as const)("handles thrown failures safely without a retry redirect", async (error, status, copy) => {
  const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
  mock.middleware.mockRejectedValue(error);
  const response = await GET(new NextRequest("https://synthetic.test/auth/callback?code=synthetic-private-payload&returnTo=https://evil.test"));
  expect(response.status).toBe(status);
  expect(response.headers.has("location")).toBe(false);
  expect(response.headers.has("set-cookie")).toBe(false);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(body).toContain(copy);
  expect(body).not.toMatch(/synthetic-private-payload|evil\.test/);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("starts a different-account login using the SDK with only prompt=login", async () => {
  mock.middleware.mockResolvedValue(NextResponse.redirect("https://synthetic.auth0.com/authorize"));
  const response = await GET(new NextRequest("https://synthetic.test/auth/login?prompt=login&returnTo=//evil.test&challengeMode=popup&scope=admin&login_hint=synthetic"));
  expect(Object.fromEntries(mock.middleware.mock.calls[0][0].nextUrl.searchParams)).toEqual({ returnTo: "/", prompt: "login" });
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("preserves safe deep links and ignores unapproved authorization parameters", async () => {
  mock.middleware.mockResolvedValue(NextResponse.redirect("https://synthetic.auth0.com/authorize"));
  await GET(new NextRequest("https://synthetic.test/auth/login?returnTo=/sessions/doc_safe&prompt=none"));
  expect(Object.fromEntries(mock.middleware.mock.calls[0][0].nextUrl.searchParams)).toEqual({ returnTo: "/sessions/doc_safe" });
});

it("renders SDK login-start rejection as a sanitized failure page", async () => {
  mock.middleware.mockResolvedValue(new NextResponse("synthetic-private-payload", { status: 500 }));
  const response = await GET(new NextRequest("https://synthetic.test/auth/login"));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("synthetic-private-payload");
});

it("retains cross-site logout rejection and same-site logout cache clearing", async () => {
  const denied = await GET(new NextRequest("https://synthetic.test/auth/logout", { headers: { "sec-fetch-site": "cross-site" } }));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: "CSRF_REJECTED" });
  expect(mock.middleware).not.toHaveBeenCalled();
  mock.middleware.mockResolvedValue(NextResponse.redirect("https://synthetic.test"));
  const response = await GET(new NextRequest("https://synthetic.test/auth/logout"));
  expect(response.headers.get("clear-site-data")).toBe('"cache", "storage"');
  expect(response.headers.get("cache-control")).toBe("no-store");
});
