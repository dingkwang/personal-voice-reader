import type { JobStatus, VoiceProvider } from "@/lib/types";

const providers: Record<VoiceProvider, string> = {
  fish: "Fish Audio", indextts: "IndexTTS-2.5", replicate: "Replicate · IndexTTS 2",
  elevenlabs: "ElevenLabs", minimax: "MiniMax", local: "本地服务",
};

export function generationDisabledReason({
  regenerating, pendingRegeneration, unfinishedRequest, isPreparing, savedJob, provider,
}: {
  regenerating: boolean; pendingRegeneration: boolean; unfinishedRequest: boolean; isPreparing: boolean;
  savedJob: JobStatus | null; provider?: VoiceProvider;
}): string {
  if (regenerating) return "正在提交重新生成请求，请等待提交完成";
  if (pendingRegeneration) return "上次重新生成提交结果未确认，请恢复原请求，避免重复计费";
  if (unfinishedRequest) return "朗读请求正在提交或尚未确认收到结果，请先处理原请求，避免重复计费";
  const background = savedJob?.status === "queued" || savedJob?.status === "running" ||
    savedJob?.items.some((item) => item.status === "working" || item.status === "queued");
  const uncertain = savedJob?.items.some((item) => item.status === "uncertain");
  const reasons: string[] = [];
  if (background) {
    const name = provider ? providers[provider] : undefined;
    const progress = savedJob?.items.length ? ` · 已就绪 ${savedJob.items.filter((item) => item.status === "ready").length}/${savedJob.items.length}` : "";
    reasons.push(`后台生成中${name ? `（${name}${progress}）` : progress}，请等待当前任务完成`);
  }
  if (uncertain) reasons.push("部分段落生成结果不确定，可能已计费，请先处理原任务");
  if (reasons.length) return reasons.join("；");
  return isPreparing ? "正在准备播放音频，请等待播放准备完成" : "";
}
