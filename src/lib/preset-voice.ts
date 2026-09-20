import { database, type Database } from "./db";
import type { Voice } from "./types";

export const PRESET_VOICE_ID = "voice_fish_6ce7ea8ada884bf3889fa7c7fb206691";

export const PRESET_VOICE: Voice = {
  id: PRESET_VOICE_ID,
  name: "御女茉莉",
  provider: "fish",
  providerVoiceId: "6ce7ea8ada884bf3889fa7c7fb206691",
  language: "zh",
  createdAt: "2026-09-19T00:00:00.000Z",
  source: "default",
};

export async function ensurePresetVoice(owner: string, db: Database = database()): Promise<Voice> {
  await db.query("INSERT INTO owners(id) VALUES ($1) ON CONFLICT DO NOTHING", [owner]);
  await db.query(
    "INSERT INTO voices(owner,id,data) VALUES ($1,$2,$3) ON CONFLICT (owner,id) DO NOTHING",
    [owner, PRESET_VOICE.id, PRESET_VOICE]
  );
  return PRESET_VOICE;
}
