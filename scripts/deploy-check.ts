import { loadEnvConfig } from "@next/env";
import { validateCloudEnvironment } from "../src/lib/config";
loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const names = ["APP_BASE_URL", "APP_ENV", "RESOURCE_ENV", "DATABASE_URL", "EXPECTED_DATABASE_HOST",
  "BLOB_READ_WRITE_TOKEN", "EXPECTED_BLOB_STORE_ID", "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET",
  "AUTH0_SECRET", "AUTH0_OWNER_SUB", "AUTH0_AUDIENCE", "AUTH0_MCP_CLIENT_ID", "DEFAULT_VOICE_ID", "CRON_SECRET"];
const missing = names.filter((name) => !process.env[name]);
console.log(JSON.stringify({ ready: !missing.length, missing, fishConfigured: Boolean(process.env.FISH_API_KEY || process.env.FISH_AUDIO_API_KEY) }, null, 2));
try { validateCloudEnvironment(); } catch { process.exitCode = 1; }
