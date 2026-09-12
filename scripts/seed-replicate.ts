import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { get, put } from "@vercel/blob";
import { database, ownerLock } from "../src/lib/db";
import { ownerSubject, required } from "../src/lib/config";
import { ownerPrefix, sha256 } from "../src/lib/blob";
import { boundedBytes } from "../src/lib/providers/indextts";
import { loadCloudEnv, verifyIdentity } from "./cloud-env";
import type { Voice } from "../src/lib/types";

async function main() {
  const [envFile, wavFile] = process.argv.slice(2);
  if (!envFile || !wavFile) throw new Error("Usage: seed-replicate <preview-env> <20-second-wav>");
  Object.assign(process.env, parseEnv(await readFile(envFile, "utf8")));
  loadCloudEnv();
  if (required("APP_ENV") !== "preview") throw new Error("Preview only");
  await verifyIdentity();
  const bytes = await readFile(wavFile);
  if (bytes.length > 1_000_000 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Use the normalized WAV");
  let rate = 0, dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error("Invalid WAV");
    const tag = bytes.toString("ascii", offset, offset + 4);
    if (tag === "fmt ") {
      if (size < 16 || bytes.readUInt16LE(offset + 8) !== 1 || bytes.readUInt16LE(offset + 10) !== 1 || bytes.readUInt32LE(offset + 12) !== 24000 || bytes.readUInt16LE(offset + 22) !== 16) throw new Error("Use mono 24 kHz PCM16");
      rate = bytes.readUInt32LE(offset + 16);
    }
    if (tag === "data") dataSize = size;
    offset += 8 + size + (size % 2);
  }
  const seconds = dataSize / rate;
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 20) throw new Error("Use 10–20 seconds");
  const owner = ownerSubject(), hash = sha256(bytes);
  const pathname = `references/${ownerPrefix(owner)}/${hash}.wav`;
  try { await put(pathname, bytes, { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "audio/wav" }); }
  catch (error) {
    const existing = await get(pathname, { access: "private" }).catch(() => null);
    if (!existing?.stream || sha256(await boundedBytes(new Response(existing.stream), 1_000_000)) !== hash) throw error;
  }
  const id = `voice_replicate_${hash.slice(0, 24)}`;
  const voice: Voice = { id, name: "我的声音", provider: "replicate", providerVoiceId: hash,
    reference: { pathname, hash, size: bytes.length, seconds }, language: "zh", source: "cloned", createdAt: new Date().toISOString() };
  await database().transaction(async (db) => {
    await ownerLock(db, owner);
    await db.query("INSERT INTO voices(owner,id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [owner, id, voice]);
    const saved = await db.query<{ data: Voice }>("SELECT data FROM voices WHERE owner=$1 AND id=$2", [owner, id]);
    if (saved.rows[0].data.provider !== "replicate" || saved.rows[0].data.reference?.hash !== hash) throw new Error("Voice conflict");
    await db.query("INSERT INTO reader_preferences(owner,web_voice_id) VALUES($1,$2) ON CONFLICT(owner) DO UPDATE SET web_voice_id=excluded.web_voice_id", [owner, id]);
  });
  console.log("Private reference verified; Preview web default set to IndexTTS 2.");
}
main().then(() => process.exit(0)).catch(() => { console.error("Reference setup failed. No secrets logged."); process.exit(1); });
