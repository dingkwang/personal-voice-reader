import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { setTestDatabase, type Database } from "@/lib/db";

export const TEST_OWNER = "auth0|synthetic-owner";
export async function testDatabase() {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL("../../migrations/001_cloud.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../../migrations/002_indextts.sql", import.meta.url), "utf8"));
  const adapt = (engine: Pick<PGlite, "query">): Database => ({
    query: (sql, params) => engine.query(sql, params),
    transaction: (run) => pg.transaction((tx) => run(adapt(tx))),
  });
  const db = adapt(pg);
  setTestDatabase(db);
  await db.query("INSERT INTO owners(id) VALUES($1)", [TEST_OWNER]);
  await db.query("INSERT INTO voices(owner,id,data) VALUES($1,$2,$3)", [TEST_OWNER, "voice_test", {
    id: "voice_test", name: "Synthetic test voice", provider: "fish", providerVoiceId: "test-reference",
    language: "zh", createdAt: "2026-09-06T00:00:00Z", source: "linked",
  }]);
  return { db, close: () => pg.close() };
}
