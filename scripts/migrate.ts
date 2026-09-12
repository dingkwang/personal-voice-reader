import { parseEnv } from "node:util";
import { readFile } from "node:fs/promises";
import { database } from "../src/lib/db";
import { required, ownerSubject } from "../src/lib/config";
import { loadCloudEnv } from "./cloud-env";

async function main() {
  const envFileIndex = process.argv.indexOf("--env-file");
  if (envFileIndex !== -1) {
    const file = process.argv[envFileIndex + 1];
    if (!file || file.startsWith("--")) throw new Error("Missing environment file");
    Object.assign(process.env, parseEnv(await readFile(file, "utf8")));
  }
  loadCloudEnv();
  const sql = (await Promise.all(["001_cloud.sql", "002_indextts.sql"].map((file) => readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")))).join("\n");
  await database().transaction(async (db) => {
    const tables = await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if (tables.rows.length && !tables.rows.some((t) => t.tablename === "deployment_identity")) throw new Error("Refusing nonempty unrelated database");
    if (tables.rows.length) {
      const { rows } = await db.query<{ environment: string; project: string }>("SELECT * FROM deployment_identity");
      if (rows.length !== 1 || rows[0].project !== "personal-voice-reader" || rows[0].environment !== required("APP_ENV")) throw new Error("Database target mismatch");
    }
    await db.query(sql);
    await db.query("INSERT INTO deployment_identity(environment,project) VALUES($1,'personal-voice-reader') ON CONFLICT DO NOTHING", [required("APP_ENV")]);
    await db.query("INSERT INTO owners(id) VALUES($1) ON CONFLICT DO NOTHING", [ownerSubject()]);
  });
  console.log("Schemas 001–002 verified; owner initialized. No personal data imported.");
}
main().then(() => process.exit(0)).catch(() => { console.error("Migration blocked. Check target identity, environment, database access, and runbook prerequisites. No credentials logged."); process.exit(1); });
