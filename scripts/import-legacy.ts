import { readFile } from "node:fs/promises";
import path from "node:path";
import { get } from "@vercel/blob";
import { importLegacy } from "../src/lib/migration";
import { ownerSubject, required } from "../src/lib/config";
import { sha256, putAudio } from "../src/lib/blob";
import { loadCloudEnv, verifyIdentity, verifyOwnerProtection } from "./cloud-env";

async function main() {
  loadCloudEnv();
  if (required("APP_ENV") !== "production") throw new Error("Personal data can only be imported into verified production");
  await verifyIdentity();
  await verifyOwnerProtection();
  const source = path.resolve(required("LEGACY_BACKUP_DIR"));
  const backupRoot = path.resolve(".backups") + path.sep;
  if (!source.startsWith(backupRoot) || path.basename(source) !== "data") throw new Error("Use a verified restricted backup");
  const manifest = JSON.parse(await readFile(path.join(source, "..", "manifest.json"), "utf8")) as { path: string; sha256: string }[];
  async function verifySource() {
    for (const file of manifest) {
      const name = path.resolve(source, file.path);
      if (!name.startsWith(source + path.sep) || sha256(await readFile(name)) !== file.sha256) throw new Error("Backup checksum failed");
    }
  }
  await verifySource();
  const expectedStore = required("EXPECTED_BLOB_STORE_ID").replace(/^store_/, "");
  const report = await importLegacy(JSON.parse(await readFile(path.join(source, "store.json"), "utf8")), ownerSubject(), async (key) => {
    const file = await readFile(path.join(source, "audio", `${key}.mp3`));
    return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  }, async (owner, bytes) => {
    // A synthetic preflight must have verified the same Blob store before import.
    const probe = await get(`migration-check/${required("MIGRATION_PROBE_ID")}`, { access: "private", useCache: false });
    if (!probe?.stream || new URL(probe.blob.url).hostname !== `${expectedStore}.private.blob.vercel-storage.com`) throw new Error("Wrong private Blob store");
    await probe.stream.cancel();
    const audio = await putAudio(owner, bytes);
    const downloaded = await get(audio.pathname, { access: "private", useCache: false });
    if (!downloaded?.stream || sha256(new Uint8Array(await new Response(downloaded.stream).arrayBuffer())) !== audio.objectHash) throw new Error("Cloud audio checksum failed");
    return audio;
  });
  await verifySource();
  console.log(JSON.stringify(report));
}
main().then(() => process.exit(0)).catch(() => { console.error("Import blocked or incomplete. Original data is untouched. Check target/owner proof and checksums; rerun safely after resolving the blocker."); process.exit(1); });
