import { fishApiKey, required } from "./config";
import { AppError } from "./errors";
import type { Voice, SynthesisSettings } from "./types";

export const INDEXTTS_MODEL = "indextts-2.5:c39ce5ba981572cb187443877ff559dfb246ce63:ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c:natural-v1";
export const REPLICATE_VERSION = "b219b0f22f95fd97cb2c8e3bbea6827a450a7fff05674c996d83171d70b3f685";
export const REPLICATE_MODEL = `replicate:lucataco/indextts-2:${REPLICATE_VERSION}:natural-v1`;
export function replicateToken() {
  const token = process.env.REPLICATE_API_KEY;
  if (!token || token === "[SENSITIVE]") throw new AppError("IndexTTS 2 尚未配置", 503, "PROVIDER_NOT_CONFIGURED");
  return token;
}
export function indexTtsConfig() {
  if (!["INDEXTTS_URL", "MODAL_PROXY_KEY", "MODAL_PROXY_SECRET"].every((key) => process.env[key] && process.env[key] !== "[SENSITIVE]")) {
    throw new AppError("IndexTTS 尚未配置，请先完成服务设置", 503, "PROVIDER_NOT_CONFIGURED");
  }
  const url = new URL(required("INDEXTTS_URL"));
  if (url.protocol !== "https:" || !url.hostname.endsWith(".modal.run") || url.username || url.password || url.search || url.hash) {
    throw new AppError("IndexTTS 服务地址无效", 503, "PROVIDER_NOT_CONFIGURED");
  }
  return { url: url.href.replace(/\/$/, ""), key: required("MODAL_PROXY_KEY"), secret: required("MODAL_PROXY_SECRET") };
}
export function providerReady(provider: Voice["provider"]) {
  if (provider === "fish") { fishApiKey(); return; }
  if (provider === "indextts") { indexTtsConfig(); return; }
  if (provider === "replicate") { replicateToken(); return; }
  throw new AppError("声音服务尚未接入", 503, "PROVIDER_NOT_CONFIGURED");
}
export function synthesisSettings(voice: Voice): SynthesisSettings {
  if (voice.provider === "replicate") {
    if (!voice.reference) throw new AppError("请先配置参考录音", 422, "REFERENCE_REQUIRED");
    return { provider: "replicate", model: REPLICATE_MODEL, providerVoiceId: voice.providerVoiceId,
      reference: voice.reference, language: voice.language };
  }
  if (voice.provider === "indextts") {
    if (!voice.reference) throw new AppError("请先上传 IndexTTS 参考录音", 422, "REFERENCE_REQUIRED");
    return { provider: "indextts", model: INDEXTTS_MODEL, providerVoiceId: voice.providerVoiceId,
      reference: voice.reference, language: voice.language };
  }
  return { provider: voice.provider, model: process.env.FISH_TTS_MODEL || "s2-pro", providerVoiceId: voice.providerVoiceId };
}
