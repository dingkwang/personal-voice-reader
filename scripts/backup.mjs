import { cp, mkdir, readdir, readFile, chmod, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function checksums(directory, prefix = "") {
  const entries = [];
  for (const item of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = path.join(prefix, item.name);
    if (item.isSymbolicLink()) throw new Error("Symlinks are not allowed in backup input");
    if (item.isDirectory()) entries.push(...await checksums(directory, name));
    else entries.push({ path: name, sha256: createHash("sha256").update(await readFile(path.join(directory, name))).digest("hex") });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export async function backup(source = path.join(root, ".data")) {
  process.umask(0o077);
  const destination = path.join(root, ".backups", `legacy-${Date.now()}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const before = await checksums(source);
  await cp(source, path.join(destination, "data"), { recursive: true, errorOnExist: true, force: false });
  const after = await checksums(path.join(destination, "data"));
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(await checksums(source))) {
    throw new Error("Source changed during backup; do not migrate this snapshot");
  }
  async function restrict(dir) {
    await chmod(dir, 0o700);
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await restrict(file);
      else await chmod(file, 0o600);
    }
  }
  await restrict(destination);
  await writeFile(path.join(destination, "manifest.json"), JSON.stringify(before, null, 2), { mode: 0o600 });
  return { destination, files: before.length, verified: true };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await backup()));
}
