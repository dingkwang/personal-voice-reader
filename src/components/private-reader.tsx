import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { ReaderApp } from "./reader-app";

export async function PrivateReader({ id }: { id?: string }) {
  try {
    await requireOwner();
  } catch (error) {
    if (error instanceof AppError && error.status === 401) {
      redirect(`/auth/login?returnTo=${encodeURIComponent(id ? `/sessions/${id}` : "/")}`);
    }
    // Auth0 routes require a full navigation, not a client-side RSC request.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    return <main className="app-shell"><h1>声笺 · 私人阅读器</h1><p>仅限 Dingkang 使用。登录或服务配置尚未就绪。</p><a href="/auth/login">登录</a></main>;
  }
  return <ReaderApp initialSessionId={id} />;
}
