import { SdkError } from "@auth0/nextjs-auth0/errors";
import { NextResponse } from "next/server";
import { AppError } from "./errors";

export class InvalidWebSession extends AppError {
  constructor() { super("登录凭据无效，请重新登录", 401, "INVALID_WEB_SESSION"); }
}

// Only reader destinations are valid. Never return to auth/API routes or carry
// callback parameters into a redirect. Recovery deliberately starts at home.
export function safeLoginReturnTo(value: unknown): string {
  return typeof value === "string" && value === value.trim() &&
    /^\/sessions\/[A-Za-z0-9_-]{1,128}$/.test(value) ? value : "/";
}

export function loginFailureKind(error: unknown) {
  if (error instanceof InvalidWebSession) return "session";
  // Inspect only the SDK's top-level, allowlisted code, never message or cause.
  if (error instanceof SdkError) {
    switch (error.code) {
      case "missing_state":
      case "invalid_state": return "transaction";
      case "authorization_code_grant_request_error":
      case "authorization_code_grant_error":
      case "session_expired": return "token";
      case "authorization_error": return "authorization";
      case "discovery_error":
      case "invalid_configuration": return "unavailable";
    }
  }
  return "unknown";
}

const failures = {
  session: {
    status: 401, title: "登录凭据无效",
    message: "无法确认当前登录身份。请重新登录，你的文章和声音仅对自己的账号可见。",
  },
  transaction: {
    status: 400, title: "登录验证未完成",
    message: "无法验证这次登录的状态。登录可能已过期，或当前浏览器未能提供有效的登录 Cookie。这不表示账号没有权限。",
  },
  token: {
    status: 400, title: "登录凭据验证未完成",
    message: "登录服务未能完成凭据交换或验证。这不表示账号没有权限。请重新开始登录；如果仍然失败，请稍后再试。",
  },
  authorization: {
    status: 400, title: "登录授权未完成",
    message: "登录服务未能完成这次授权。请重新开始登录。",
  },
  unavailable: {
    status: 503, title: "登录服务暂不可用",
    message: "目前无法完成登录。请稍后重新开始登录；如果仍然失败，请联系站点维护者。",
  },
  unknown: {
    status: 500, title: "登录未完成",
    message: "暂时无法确认失败原因。请重新开始登录；如果仍然失败，请稍后再试。这不表示账号没有权限。",
  },
} as const;

export function loginFailureResponse(error: unknown): NextResponse {
  const kind = loginFailureKind(error);
  const failure = failures[kind];
  // All interpolated content is application-owned. No request/error details,
  // scripts, external assets, automatic retries or auth prefetching.
  return new NextResponse(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${failure.title} · 声笺</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:64px 20px;background:#f5f3ed;color:#17211d;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:560px;margin:auto;padding:32px;background:#fffdfa;border:1px solid #deddd5;border-radius:20px}
h1{font-size:28px;line-height:1.3}p{margin:20px 0}.brand{color:#68736e}
nav{display:flex;flex-direction:column;align-items:flex-start;gap:12px;margin-top:28px}
a{display:inline-block;padding:10px 16px;border:1px solid #1e654b;border-radius:10px;color:#1e654b;text-decoration:none;min-height:44px}
a:first-child{background:#1e654b;color:white}a:focus-visible{outline:3px solid #e46f43;outline-offset:4px}
</style></head><body><main aria-labelledby="login-title">
<p class="brand">声笺 · 个人阅读器</p><h1 id="login-title">${failure.title}</h1>
<p>${failure.message}</p>
${kind === "transaction" ? "<p>请在同一浏览器中重新开始，并允许此站点使用 Cookie。不要刷新或重复打开旧的登录回调页面。</p>" : ""}
<nav aria-label="登录恢复">
${kind === "session" ? '<a href="/auth/login?prompt=login" rel="noreferrer">使用其他账号登录</a>' : ""}
<a href="/auth/login" rel="noreferrer">重新开始登录</a>
</nav></main></body></html>`, {
    status: failure.status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
