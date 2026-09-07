import { NextRequest } from "next/server";
import { auth0 } from "@/lib/auth";
import { errorResponse } from "@/lib/errors";
import { AppError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    if (request.nextUrl.pathname === "/auth/logout" && request.headers.get("sec-fetch-site") === "cross-site") {
      throw new AppError("请求来源不允许", 403, "CSRF_REJECTED");
    }
    const response = await auth0().middleware(request);
    response.headers.set("Cache-Control", "no-store");
    if (request.nextUrl.pathname === "/auth/logout") response.headers.set("Clear-Site-Data", '"cache", "storage"');
    return response;
  } catch {
    return errorResponse(new AppError("登录未完成，请检查拥有者权限或稍后重试", 403, "LOGIN_FAILED"));
  }
}
