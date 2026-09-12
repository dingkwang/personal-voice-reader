import { database } from "./db";
import { listVoices, findVoice } from "./store";
import { AppError } from "./errors";
import { providerReady } from "./tts-config";

export async function webVoices(owner: string) {
  const voices = await listVoices(owner);
  const { rows } = await database().query<{ web_voice_id: string }>("SELECT web_voice_id FROM reader_preferences WHERE owner=$1", [owner]);
  const defaultVoiceId = rows[0]?.web_voice_id || process.env.DEFAULT_VOICE_ID || null;
  return { defaultVoiceId, voices: voices.map((voice) => {
    // The private reference location stays on the server.
    const { reference: _reference, ...publicVoice } = voice;
    void _reference;
    let available = true;
    try { providerReady(voice.provider); } catch { available = false; }
    return { ...publicVoice, available };
  }) };
}
export async function setWebVoice(owner: string, voiceId: string) {
  const voice = await findVoice(voiceId, owner);
  providerReady(voice.provider);
  if (["indextts", "replicate"].includes(voice.provider) && !voice.reference) throw new AppError("请先上传参考录音", 422);
  await database().query(`INSERT INTO reader_preferences(owner,web_voice_id) VALUES($1,$2)
    ON CONFLICT(owner) DO UPDATE SET web_voice_id=excluded.web_voice_id`, [owner, voiceId]);
}
