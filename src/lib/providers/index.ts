import { AppError } from "@/lib/errors";
import { FishVoiceProvider } from "@/lib/providers/fish";
import type { VoiceProviderAdapter } from "@/lib/providers/types";
import type { VoiceProvider } from "@/lib/types";

export function getVoiceProvider(provider: VoiceProvider): VoiceProviderAdapter {
  if (provider === "fish") return new FishVoiceProvider();
  throw new AppError(
    `声音服务 ${provider} 尚未接入`,
    501,
    "PROVIDER_NOT_IMPLEMENTED",
  );
}
