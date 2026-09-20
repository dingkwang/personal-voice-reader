import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { ReaderApp } from "./reader-app";
import { ownerPrefix } from "@/lib/blob";

export async function PrivateReader({ id }: { id?: string }) {
  let owner: string;
  try {
    owner = await requireOwner();
  } catch (error) {
    if (error instanceof AppError && error.status === 401) {
      redirect(`/auth/login?returnTo=${encodeURIComponent(id ? `/sessions/${id}` : "/")}`);
    }
    // Auth0 routes require a full navigation, not a client-side RSC request.
    // eslint-disable-next-line @next/next/no-html-link-for-pages
    return <main className="app-shell"><h1>声笺 · 个人阅读器</h1><p>登录或服务配置尚未就绪。登录后只能访问自己的文章和声音。</p><a href="/auth/login">登录</a></main>;
  }
  return <ReaderApp key={ownerPrefix(owner)} storageScope={ownerPrefix(owner)} initialSessionId={id} />;
}
