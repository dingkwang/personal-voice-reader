import { after } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { requireOAuth, type Scope } from "@/lib/auth";
import { appOrigin } from "@/lib/config";
import { AppError, errorResponse } from "@/lib/errors";
import { listVoices } from "@/lib/store";
import { createReading, createReadingSchema, readingStatus } from "@/lib/jobs";
import { dispatchJob } from "@/lib/dispatch";
export const runtime = "nodejs";

export async function POST(request: Request) {
  let server: McpServer | undefined;
  try {
    const { owner, scopes } = await requireOAuth(request);
    const origin = request.headers.get("origin");
    if (origin && ![appOrigin(), "https://chatgpt.com"].includes(origin)) throw new AppError("请求来源不允许", 403);
    const need = (scope: Scope) => {
      if (!scopes.includes(scope)) throw new AppError("授权范围不足", 403, "INSUFFICIENT_SCOPE");
    };
    const result = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data });
    const safe = async (fn: () => Promise<Record<string, unknown>>) => {
      try { return result(await fn()); }
      catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: error instanceof AppError ? error.message : "无法完成请求，请使用相同幂等键重试" }] };
      }
    };
    server = new McpServer({ name: "voice-note", version: "1.0.0" }, {
      instructions: "声笺是 Dingkang 的私人阅读器。将用户确认的最终中文文本交给 create_reading。不要读取整个聊天历史，不调用其他模型。同一次意图重试时使用相同 idempotency_key。返回播放链接；生成在后台继续。默认声音 Dingkang，语速 1。",
    });
    server.registerTool("list_voices", {
      description: "列出拥有者已保存的声音，不克隆声音。",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, () => safe(async () => {
      need("read:voices");
      const voices = await listVoices(owner);
      return { voices: voices.map(({ id, name, language, provider }) => ({ id, name, language, provider })) };
    }));
    server.registerTool("create_reading", {
      description: "将用户确认的最终中文文本保存为会话并排队生成语音，可能产生 Fish 费用。立即返回私人播放链接。相同请求重试必须复用幂等键。",
      inputSchema: createReadingSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, (input) => safe(async () => {
      need("create:readings");
      const queued = await createReading(input, owner);
      after(() => dispatchJob(queued.jobId, owner));
      const job = await readingStatus(queued.jobId, owner);
      return { session_id: queued.documentId, job_id: queued.jobId, status: job.status, url: job.url };
    }));
    server.registerTool("get_reading_status", {
      description: "查询已保存的生成任务状态和私人播放链接。",
      inputSchema: { job_id: z.string().min(5).max(100) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, ({ job_id }) => safe(async () => {
      need("read:readings");
      const job = await readingStatus(job_id, owner);
      return { job_id, session_id: job.document_id, status: job.status, url: job.url,
        total: job.items.length, ready: job.items.filter((i) => i.status === "ready").length,
        failed: job.items.filter((i) => ["error", "uncertain"].includes(i.status)).length };
    }));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const response = errorResponse(error);
    if (response.status === 401) response.headers.set("WWW-Authenticate", `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/api/mcp"`);
    return response;
  } finally {
    await server?.close();
  }
}
export async function GET(request: Request) {
  try {
    await requireOAuth(request);
    return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  } catch (error) {
    const response = errorResponse(error);
    if (response.status === 401) response.headers.set("WWW-Authenticate", `Bearer resource_metadata="${appOrigin()}/.well-known/oauth-protected-resource/api/mcp"`);
    return response;
  }
}
