import { createHash } from "node:crypto";
import { getVoiceProvider } from "@/lib/providers";
import {
  audioExists,
  findSegment,
  findVoice,
  mutateStore,
  persistAudio,
  readStore,
} from "@/lib/store";
import type { Segment } from "@/lib/types";

const activeGenerations = new Map<string, Promise<void>>();

function audioKey(input: {
  provider: string;
  providerVoiceId: string | null;
  text: string;
  model: string;
  speed: number;
}) {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, ...input }))
    .digest("hex");
}

async function attachAudio(
  segmentId: string,
  voiceId: string,
  speed: number,
  hash: string,
): Promise<Segment> {
  return mutateStore((data) => {
    for (const document of data.documents) {
      const segment = document.segments.find((item) => item.id === segmentId);
      if (!segment) continue;
      segment.status = "ready";
      segment.audioHash = hash;
      segment.audioUrl = `/api/audio/${segment.id}?v=${hash.slice(0, 12)}`;
      segment.voiceId = voiceId;
      segment.speed = speed;
      data.audioCache[hash] = hash;
      return { ...segment };
    }
    throw new Error("Segment disappeared while generating audio");
  });
}

export async function generateSegmentAudio(input: {
  segmentId: string;
  voiceId: string;
  speed: number;
  model?: string;
}): Promise<{ segment: Segment; cached: boolean }> {
  const model = input.model || process.env.FISH_TTS_MODEL || "s2-pro";
  const [{ segment }, voice] = await Promise.all([
    findSegment(input.segmentId),
    findVoice(input.voiceId),
  ]);
  const hash = audioKey({
    provider: voice.provider,
    providerVoiceId: voice.providerVoiceId,
    text: segment.text,
    model,
    speed: input.speed,
  });

  const store = await readStore();
  if (store.audioCache[hash] && (await audioExists(hash))) {
    return {
      segment: await attachAudio(segment.id, voice.id, input.speed, hash),
      cached: true,
    };
  }

  const existing = activeGenerations.get(hash);
  if (existing) {
    await existing;
    return {
      segment: await attachAudio(segment.id, voice.id, input.speed, hash),
      cached: true,
    };
  }

  const generation = (async () => {
    const provider = getVoiceProvider(voice.provider);
    const audio = await provider.synthesize({
      text: segment.text,
      providerVoiceId: voice.providerVoiceId,
      speed: input.speed,
      model,
    });
    await persistAudio(hash, audio);
  })();

  activeGenerations.set(hash, generation);
  try {
    await generation;
    return {
      segment: await attachAudio(segment.id, voice.id, input.speed, hash),
      cached: false,
    };
  } finally {
    activeGenerations.delete(hash);
  }
}
