import { get } from "@vercel/blob";
import { z } from "zod";
import { database, ownerLock } from "../db";
import { ownerPrefix, sha256 } from "../blob";
import { AppError } from "../errors";
import { REPLICATE_MODEL, REPLICATE_VERSION, replicateToken } from "../tts-config";
import { boundedBytes } from "./indextts";
import type { Generation } from "../jobs";

const prediction = z.object({ id: z.string().regex(/^[a-z0-9]+$/),
  status: z.enum(["starting", "processing", "succeeded", "failed", "canceled", "aborted"]),
  output: z.string().nullable().optional() });
type Attempt = { prediction_id: string | null; status: string; deadline: Date };
type Result = { status: "pending" | "error" | "uncertain" } | { status: "ready"; audio: ArrayBuffer };

async function request(path: string, init?: RequestInit) {
  return fetch(`https://api.replicate.com/v1${path}`, { ...init,
    headers: { Authorization: `Bearer ${replicateToken()}`, "Content-Type": "application/json",
      ...(init?.method === "POST" ? { "Cancel-After": "5m" } : {}) },
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
}

export class ReplicateProvider {
  async poll(claim: Generation): Promise<Result> {
    const db = database();
    let row = (await db.query<Attempt>("SELECT prediction_id,status,deadline FROM replicate_requests WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt])).rows[0];
    if (!row) {
      const settings = claim.job.synthesis;
      const ref = settings?.reference;
      if (!ref || settings?.model !== REPLICATE_MODEL || claim.job.speed !== 1) throw new AppError("IndexTTS 设置无效", 422);
      if (!ref.pathname.startsWith(`references/${ownerPrefix(claim.owner)}/`)) throw new AppError("参考录音不属于此用户", 403);
      const source = await get(ref.pathname, { access: "private" });
      if (!source?.stream) throw new AppError("参考录音不存在", 422);
      const raw = await boundedBytes(new Response(source.stream), 1_000_000);
      if (raw.length !== ref.size || sha256(raw) !== ref.hash || raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE") throw new AppError("参考录音校验失败", 422);
      const reserved = await db.transaction(async (tx) => {
        await ownerLock(tx, claim.owner);
        const existing = await tx.query("SELECT 1 FROM replicate_requests WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt]);
        if (existing.rows.length) return false;
        const count = await tx.query<{ count: string }>("SELECT count(*) FROM replicate_requests WHERE owner=$1", [claim.owner]);
        // Preview guard. The separate initial smoke prediction also counts toward the $5 budget.
        if (Number(count.rows[0].count) >= 6) throw new AppError("本轮生成额度已用完", 422);
        await tx.query("INSERT INTO replicate_requests(owner,attempt) VALUES($1,$2)", [claim.owner, claim.attempt]);
        return true;
      });
      if (!reserved) return { status: "pending" };
      // Commit reservation before submitting. Never repeat an ambiguous paid POST.
      try {
        const response = await request("/predictions", { method: "POST", body: JSON.stringify({ version: REPLICATE_VERSION,
          input: { text: claim.segment.text, speaker_audio: `data:audio/wav;base64,${raw.toString("base64")}` } }) });
        if (!response.ok) {
          const state = response.status >= 400 && response.status < 500 ? "error" : "uncertain";
          await db.query("UPDATE replicate_requests SET status=$3 WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt, state]);
          return { status: state };
        }
        const created = prediction.parse(await response.json());
        await db.query("UPDATE replicate_requests SET prediction_id=$3,status='polling' WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt, created.id]);
      } catch {
        // A lost database acknowledgement may still have saved the prediction ID.
        await db.query("UPDATE replicate_requests SET status='uncertain' WHERE owner=$1 AND attempt=$2 AND prediction_id IS NULL", [claim.owner, claim.attempt]);
      }
      row = (await db.query<Attempt>("SELECT prediction_id,status,deadline FROM replicate_requests WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt])).rows[0];
    }
    if (row.status === "error") return { status: "error" };
    if (!row.prediction_id || new Date(row.deadline).getTime() <= Date.now()) return { status: "uncertain" };
    if (!/^[a-z0-9]+$/.test(row.prediction_id)) throw new AppError("任务标识无效", 422);
    const response = await request(`/predictions/${row.prediction_id}`);
    if (!response.ok) throw new AppError("正在重新获取生成进度", 502);
    const current = prediction.parse(await response.json());
    if (["failed", "canceled", "aborted"].includes(current.status)) {
      await db.query("UPDATE replicate_requests SET status='error' WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt]);
      return { status: "error" };
    }
    if (current.status !== "succeeded") return { status: "pending" };
    const url = new URL(current.output || "");
    if (url.protocol !== "https:" || !(url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery")) || url.username || url.password) throw new AppError("音频地址无效", 422);
    const output = await fetch(url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!output.ok) throw new AppError("音频暂未取回", 502);
    const bytes = await boundedBytes(output, 32 * 1024 * 1024);
    const wav = bytes.length > 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
    const mp3 = bytes.length > 3 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 255 && (bytes[1] & 224) === 224));
    if (!wav && !mp3) throw new AppError("音频格式无效", 422);
    await db.query("UPDATE replicate_requests SET status='ready' WHERE owner=$1 AND attempt=$2", [claim.owner, claim.attempt]);
    return { status: "ready", audio: new Uint8Array(bytes).buffer };
  }
}
