// Isolated PostgreSQL socket for Python service tests. No cloud/GPU access.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const db = await PGlite.create();
for (const file of ["001_cloud.sql", "002_indextts.sql"]) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
await db.query("INSERT INTO deployment_identity(environment,project) VALUES('development','personal-voice-reader')");
const socket = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 8 });
await socket.start();
try {
  const proc = spawn("uv", ["run", "--project", "services/indextts", "pytest", "services/indextts/tests", "-q"], {
    stdio: "inherit", env: { PATH: process.env.PATH, HOME: process.env.HOME,
      INDEXTTS_ENV: "development", INDEXTTS_DATABASE_URL: `postgresql://postgres:postgres@${socket.getServerConn()}/postgres`,
    },
  });
  process.exitCode = await new Promise((resolve, reject) => { proc.on("exit", resolve); proc.on("error", reject); });
} finally { await socket.stop(); await db.close(); }
