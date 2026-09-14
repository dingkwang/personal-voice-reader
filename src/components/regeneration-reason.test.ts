import { expect, it } from "vitest";
import type { JobStatus } from "@/lib/types";
import { generationDisabledReason } from "./regeneration-reason";

const state = { regenerating: false, pendingRegeneration: false, unfinishedRequest: false, isPreparing: false, savedJob: null };
function job(status: JobStatus["status"], statuses: JobStatus["items"][number]["status"][]): JobStatus {
  return { id: "job_test", document_id: "doc_test", voice_id: "voice_test", speed: 1, model: "synthetic",
    status, run_id: null, url: "/sessions/doc_test",
    items: statuses.map((status, index) => ({ segment_id: `seg_${index}`, status, error: null, audioUrl: null })) };
}

it.each(["queued", "running"] as const)("describes %s as background generation, never uncertainty", (status) => {
  const copy = generationDisabledReason({ ...state, savedJob: job(status, ["ready", "working", "queued"]), provider: "replicate" });
  expect(copy).toContain("后台生成中（Replicate · IndexTTS 2 · 已就绪 1/3）");
  expect(copy).not.toContain("不确定");
});

it("handles missing provider/progress and queued items even in an attention job", () => {
  expect(generationDisabledReason({ ...state, savedJob: job("running", []) })).toBe("后台生成中，请等待当前任务完成");
  expect(generationDisabledReason({ ...state, savedJob: job("attention", ["queued"]) })).toContain("已就绪 0/1");
  expect(generationDisabledReason({ ...state, savedJob: job("running", []), provider: "fish" })).toContain("Fish Audio");
});

it("reserves uncertain copy for uncertain items, including mixed jobs", () => {
  const copy = generationDisabledReason({ ...state, savedJob: job("attention", ["ready", "uncertain"]) });
  expect(copy).toContain("部分段落生成结果不确定，可能已计费");
  expect(copy).not.toContain("后台生成");
  const mixed = generationDisabledReason({ ...state, savedJob: job("running", ["queued", "uncertain"]) });
  expect(mixed).toContain("后台生成中");
  expect(mixed).toContain("部分段落生成结果不确定");
});

it("distinguishes POST submission, lost response recovery and playback preparation", () => {
  expect(generationDisabledReason({ ...state, regenerating: true, pendingRegeneration: true })).toContain("正在提交重新生成请求");
  expect(generationDisabledReason({ ...state, pendingRegeneration: true })).toContain("请恢复原请求");
  const post = generationDisabledReason({ ...state, unfinishedRequest: true, isPreparing: true });
  expect(post).toContain("朗读请求正在提交或尚未确认收到结果");
  expect(post).not.toContain("生成结果不确定");
  expect(generationDisabledReason({ ...state, isPreparing: true })).toBe("正在准备播放音频，请等待播放准备完成");
  expect(generationDisabledReason({ ...state, isPreparing: true, savedJob: job("queued", ["queued"]) })).toContain("后台生成中");
});

it("unblocks completed jobs but preserves every original active-job guard", () => {
  expect(generationDisabledReason({ ...state, savedJob: job("completed", ["ready"]) })).toBe("");
  for (const status of ["queued", "running", "attention", "completed"] as const) {
    for (const item of ["idle", "queued", "working", "ready", "error", "uncertain"] as const) {
      const guarded = status === "queued" || status === "running" || ["queued", "working", "uncertain"].includes(item);
      expect(Boolean(generationDisabledReason({ ...state, savedJob: job(status, [item]) }))).toBe(guarded);
    }
  }
});
