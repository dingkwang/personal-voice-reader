import { NextRequest } from "next/server";
import { auth0 } from "@/lib/auth";
import { AppError, errorResponse } from "@/lib/errors";
import { loginFailureResponse, safeLoginReturnTo } from "@/lib/web-login";

export async function GET(request: NextRequest) {
  if (request.nextUrl.pathname === "/auth/logout" && request.headers.get("sec-fetch-site") === "cross-site") {
    return errorResponse(new AppError("请求来源不允许", 403, "CSRF_REJECTED"));
  }
  try {
    // Keep the web flow in redirect mode. Do not forward arbitrary SDK/OIDC
    // parameters (including popup mode) from untrusted query strings.
    let sdkRequest = request;
    if (request.nextUrl.pathname === "/auth/login") {
      const url = request.nextUrl.clone();
      url.search = "";
      url.searchParams.set("returnTo", safeLoginReturnTo(request.nextUrl.searchParams.get("returnTo")));
      if (request.nextUrl.searchParams.get("prompt") === "login") url.searchParams.set("prompt", "login");
      sdkRequest = new NextRequest(url, { headers: request.headers });
    }
    const response = await auth0().middleware(sdkRequest);
    if (request.nextUrl.pathname === "/auth/login" && response.status >= 400) {
      return loginFailureResponse(null);
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    if (request.nextUrl.pathname === "/auth/logout") response.headers.set("Clear-Site-Data", '"cache", "storage"');
    return response;
  } catch (error) {
    return loginFailureResponse(error);
  }
}
