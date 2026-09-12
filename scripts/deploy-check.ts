import { loadEnvConfig } from "@next/env";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { indexTtsConfig } from "../src/lib/tts-config";
import { validateCloudEnvironment } from "../src/lib/config";
const names = ["APP_BASE_URL", "APP_ENV", "RESOURCE_ENV", "DATABASE_URL", "EXPECTED_DATABASE_HOST",
  "BLOB_READ_WRITE_TOKEN", "EXPECTED_BLOB_STORE_ID", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET", "AUTH0_OWNER_SUB", "AUTH0_AUDIENCE", "AUTH0_MCP_CLIENT_ID", "DEFAULT_VOICE_ID", "CRON_SECRET"];
const envFileIndex = process.argv.indexOf("--env-file");
if (envFileIndex !== -1) {
  const path = process.argv[envFileIndex + 1];
  if (!path || path.startsWith("--")) throw new Error("--env-file requires a path");
  const snapshot = parseEnv(readFileSync(path, "utf8"));
  // A cloud snapshot must not inherit a local provider key or test flags.
  for (const name of [...names, "FISH_API_KEY", "FISH_AUDIO_API_KEY", "VERCEL", "VERCEL_ENV", "TEST_MODE", "INDEXTTS_URL", "MODAL_PROXY_KEY", "MODAL_PROXY_SECRET"]) delete process.env[name];
  Object.assign(process.env, snapshot);
} else {
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
}
const missing = names.filter((name) => !process.env[name]);
let ready = !missing.length;
try { validateCloudEnvironment(); } catch { ready = false; process.exitCode = 1; }
let indexTtsConfigured = false;
try { indexTtsConfig(); indexTtsConfigured = true; } catch {}
console.log(JSON.stringify({ ready, missing, indexTtsConfigured, fishConfigured: Boolean(process.env.FISH_API_KEY || process.env.FISH_AUDIO_API_KEY) }, null, 2));
