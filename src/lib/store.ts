import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/lib/errors";
import type { ReaderDocument, StoreData, Voice } from "@/lib/types";

const dataRoot = process.env.VOICE_READER_DATA_DIR
  ? path.resolve(process.env.VOICE_READER_DATA_DIR)
  : path.join(process.cwd(), ".data");
const audioRoot = path.join(dataRoot, "audio");
const storePath = path.join(dataRoot, "store.json");

let mutationQueue: Promise<unknown> = Promise.resolve();

function defaultVoice(): Voice {
  return {
    id: "voice_fish_default",
    name: process.env.FISH_DEFAULT_VOICE_NAME || "Fish 默认声音",
    provider: "fish",
    providerVoiceId: process.env.FISH_DEFAULT_VOICE_ID || null,
    language: "zh",
    createdAt: new Date().toISOString(),
    source: process.env.FISH_DEFAULT_VOICE_ID ? "linked" : "default",
  };
}

async function ensureStore(): Promise<void> {
  await mkdir(audioRoot, { recursive: true });
  try {
    await stat(storePath);
  } catch {
    const initial: StoreData = {
      voices: [defaultVoice()],
      documents: [],
      audioCache: {},
    };
    await writeFile(storePath, JSON.stringify(initial, null, 2), "utf8");
  }
}

export async function readStore(): Promise<StoreData> {
  await ensureStore();
  return JSON.parse(await readFile(storePath, "utf8")) as StoreData;
}

export async function mutateStore<T>(
  update: (data: StoreData) => T | Promise<T>,
): Promise<T> {
  const operation = mutationQueue.then(async () => {
    const data = await readStore();
    const result = await update(data);
    const tempPath = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempPath, storePath);
    return result;
  });

  mutationQueue = operation.catch(() => undefined);
  return operation;
}

export async function findVoice(id: string): Promise<Voice> {
  const voice = (await readStore()).voices.find((item) => item.id === id);
  if (!voice) throw new AppError("找不到这个声音", 404, "VOICE_NOT_FOUND");
  return voice;
}

export async function findSegment(segmentId: string) {
  for (const document of (await readStore()).documents) {
    const segment = document.segments.find((item) => item.id === segmentId);
    if (segment) return { document, segment };
  }
  throw new AppError("找不到这个朗读段落", 404, "SEGMENT_NOT_FOUND");
}

export async function addVoice(voice: Voice): Promise<Voice> {
  return mutateStore((data) => {
    data.voices.push(voice);
    return voice;
  });
}

export async function addDocument(
  document: ReaderDocument,
): Promise<ReaderDocument> {
  return mutateStore((data) => {
    data.documents.unshift(document);
    data.documents = data.documents.slice(0, 100);
    return document;
  });
}

export function getAudioPath(hash: string): string {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new AppError("无效的音频标识", 400, "INVALID_AUDIO_HASH");
  }
  return path.join(audioRoot, `${hash}.mp3`);
}

export async function persistAudio(hash: string, audio: ArrayBuffer) {
  await ensureStore();
  const finalPath = getAudioPath(hash);
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;
  await writeFile(tempPath, Buffer.from(audio));
  await rename(tempPath, finalPath);
}

export async function audioExists(hash: string): Promise<boolean> {
  try {
    await stat(getAudioPath(hash));
    return true;
  } catch {
    return false;
  }
}
