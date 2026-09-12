import { fishApiKey } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type {
  CloneVoiceInput,
  SynthesisInput,
  VoiceProviderAdapter,
} from "@/lib/providers/types";

const FISH_API_ROOT = "https://api.fish.audio";

async function fishError(response: Response): Promise<AppError> {
  await response.body?.cancel();
  return new AppError(
    `Fish Audio 请求失败 (${response.status})`,
    502,
    "FISH_API_ERROR",
  );
}

export class FishVoiceProvider implements VoiceProviderAdapter {
  async synthesize(input: SynthesisInput): Promise<ArrayBuffer> {
    const response = await fetch(`${FISH_API_ROOT}/v1/tts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fishApiKey()}`,
        "Content-Type": "application/json",
        model: input.model,
      },
      body: JSON.stringify({
        text: input.text,
        ...(input.providerVoiceId
          ? { reference_id: input.providerVoiceId }
          : {}),
        format: "mp3",
        mp3_bitrate: 128,
        sample_rate: 44100,
        normalize: true,
        latency: "normal",
        prosody: {
          speed: input.speed,
          volume: 0,
          normalize_loudness: true,
        },
      }),
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });

    if (!response.ok) throw await fishError(response);
    return response.arrayBuffer();
  }

  async cloneVoice(input: CloneVoiceInput) {
    const body = new FormData();
    body.append("type", "tts");
    body.append("title", input.name);
    body.append("train_mode", "fast");
    body.append("visibility", "private");
    body.append("enhance_audio_quality", "true");
    body.append("generate_sample", "false");
    for (const audio of input.audio) {
      body.append("voices", audio, audio.name || "voice-recording");
    }
    if (input.transcript) body.append("texts", input.transcript);

    const response = await fetch(`${FISH_API_ROOT}/model`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fishApiKey()}` },
      body,
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });

    if (!response.ok) throw await fishError(response);
    const result = (await response.json()) as { _id?: string };
    if (!result._id) {
      throw new AppError("Fish Audio 没有返回声音 ID", 502, "INVALID_PROVIDER_RESPONSE");
    }
    return { providerVoiceId: result._id };
  }
}
