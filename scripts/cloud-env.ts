import { loadEnvConfig } from "@next/env";
import { appOrigin, required, validateCloudEnvironment } from "../src/lib/config";
import { database } from "../src/lib/db";

export function loadCloudEnv() {
  loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
  validateCloudEnvironment();
  const host = new URL(required("DATABASE_URL")).hostname;
  if (host !== required("EXPECTED_DATABASE_HOST") || !host.endsWith(".neon.tech") ||
    required("MIGRATION_PROJECT_SLUG") !== "personal-voice-reader") throw new Error("Wrong database/project target");
}
export async function verifyIdentity() {
  const { rows } = await database().query<{ project: string; environment: string }>("SELECT * FROM deployment_identity");
  if (rows.length !== 1 || rows[0].project !== "personal-voice-reader" || rows[0].environment !== required("APP_ENV")) throw new Error("Wrong database identity");
}
export async function verifyOwnerProtection() {
  if (required("OWNER_VERIFIED_BASE_URL") !== appOrigin()) throw new Error("Owner verification target mismatch");
  for (const route of ["/api/documents", "/api/voices", "/api/audio/unknown", "/api/jobs/unknown", "/api/mcp"]) {
    const response = await fetch(`${appOrigin()}${route}`, { redirect: "manual" });
    if (response.status !== 401 && response.status !== 403) throw new Error("Private route does not reject anonymous access");
  }
  // Token is supplied via the environment, never a CLI argument or output.
  const response = await fetch(`${appOrigin()}/api/mcp`, { method: "POST", headers: {
    Authorization: `Bearer ${required("MIGRATION_OWNER_ACCESS_TOKEN")}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_voices", arguments: {} } }) });
  const body = await response.json();
  if (!response.ok || body.error || body.result?.isError || !Array.isArray(body.result?.structuredContent?.voices)) throw new Error("Owner OAuth verification failed");
}
