// UI-only regression server. No app credentials, database, migrations or providers.
import { cp, mkdir, mkdtemp, writeFile, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = await mkdtemp(path.join(tmpdir(), "voice-note-reader-"));
for (const dir of ["components", "lib", "workflows"]) {
  await cp(path.join(root, "src", dir), path.join(fixture, "src", dir), { recursive: true });
}
for (const file of ["package.json", "tsconfig.json", "next-env.d.ts", "postcss.config.mjs"]) {
  await cp(path.join(root, file), path.join(fixture, file));
}
await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"), "dir");
// Match production effect mounting, without touching the app's Next config.
await writeFile(path.join(fixture, "next.config.mjs"), "export default { reactStrictMode: false, devIndicators: false };");
await mkdir(path.join(fixture, "src/app/[[...path]]"), { recursive: true });
await cp(path.join(root, "src/app/globals.css"), path.join(fixture, "src/app/globals.css"));
await writeFile(path.join(fixture, "src/app/layout.tsx"), `
import "./globals.css";
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}`);
await writeFile(path.join(fixture, "src/app/[[...path]]/page.tsx"), `
import { ReaderApp } from "@/components/reader-app";
export default async function Page({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return <ReaderApp storageScope="synthetic-reader" initialSessionId={path?.[0] === "sessions" ? path[1] : undefined} />;
}`);
const server = spawn(process.execPath, [
  path.join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack",
  "--hostname", "127.0.0.1", "--port", "3118",
], {
  cwd: fixture,
  env: {
    PATH: process.env.PATH, HOME: fixture, TMPDIR: tmpdir(),
    NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code || 0));
