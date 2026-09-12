import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.umask(0o077);
const evidence = path.join(root, ".evidence", "browser");
await mkdir(evidence, { recursive: true, mode: 0o700 });
const audio = path.join(evidence, `synthetic-${Date.now()}.mp3`);
execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-filter:a", "volume=0.02", "-codec:a", "libmp3lame", audio]);
const db = await PGlite.create();
await db.exec(await readFile(path.join(root, "migrations/001_cloud.sql"), "utf8"));
await db.exec(await readFile(path.join(root, "migrations/002_indextts.sql"), "utf8"));
await db.query("INSERT INTO deployment_identity(environment,project) VALUES('development','personal-voice-reader')");
await db.query("INSERT INTO owners(id) VALUES('auth0|synthetic-browser')");
await db.query("INSERT INTO voices(owner,id,data) VALUES('auth0|synthetic-browser','voice_browser',$1)", [{
  id: "voice_browser", name: "合成验收声音", provider: "fish", providerVoiceId: "synthetic-reference",
  language: "zh", source: "linked", createdAt: "2026-09-06T00:00:00Z",
}]);
const reference = Buffer.from("RIFF0000WAVEsynthetic-reference");
const referenceHash = createHash("sha256").update(reference).digest("hex");
const ownerHash = createHash("sha256").update("auth0|synthetic-browser").digest("hex").slice(0, 32);
await db.query("INSERT INTO voices(owner,id,data) VALUES('auth0|synthetic-browser','voice_index_browser',$1)", [{
  id: "voice_index_browser", name: "Index 合成验收声音", provider: "indextts", providerVoiceId: referenceHash,
  language: "zh", source: "cloned", createdAt: "2026-09-12T00:00:00Z",
  reference: { pathname: `references/${ownerHash}/${referenceHash}.wav`, hash: referenceHash, size: reference.length, seconds: 12 },
}]);
const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 8 });
await socket.start();
const secret = randomBytes(32).toString("hex");
await writeFile(path.join(evidence, "test-secret"), secret, { mode: 0o600 });
const server = spawn(process.execPath, ["--import", path.join(root, "scripts/browser-runtime.mjs"),
  path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3108"], {
  cwd: root,
  env: {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production",
    DATABASE_URL: `postgresql://postgres:postgres@${socket.getServerConn()}/postgres`, APP_ENV: "development", RESOURCE_ENV: "development", APP_BASE_URL: "http://127.0.0.1:3108",
    AUTH0_DOMAIN: "synthetic.auth0.com", AUTH0_CLIENT_ID: "synthetic-web", AUTH0_CLIENT_SECRET: "synthetic-client-secret",
    AUTH0_SECRET: secret, AUTH0_OWNER_SUB: "auth0|synthetic-browser", AUTH0_AUDIENCE: "http://127.0.0.1:3108/api/mcp",
    AUTH0_MCP_CLIENT_ID: "synthetic-mcp", BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_synthetic_notreal",
    INDEXTTS_URL: "https://synthetic.modal.run", MODAL_PROXY_KEY: "synthetic-key", MODAL_PROXY_SECRET: "synthetic-secret",
    DEFAULT_VOICE_ID: "voice_browser", CRON_SECRET: "synthetic-cron", FISH_API_KEY: "synthetic-not-real",
    WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:3108", WORKFLOW_LOCAL_DATA_DIR: path.join(evidence, "workflow"),
    BROWSER_TEST_AUDIO: audio, BROWSER_TEST_LOG: path.join(evidence, "provider-mock.log"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const log = createWriteStream(path.join(evidence, "server.log"), { mode: 0o600 });
server.stdout.pipe(log);
server.stderr.pipe(log);
async function stop() {
  server.kill("SIGTERM");
  await socket.stop();
  await db.close();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", (code) => { if (code) void stop(); });
console.log("Isolated browser server starting on 127.0.0.1:3108. All provider calls mocked.");
