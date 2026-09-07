import { Pool } from "pg";
import { required } from "./config";

export interface Database {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(run: (db: Database) => Promise<T>): Promise<T>;
}

let pool: Pool | undefined;
let testDatabase: Database | undefined;

// Only test harnesses can inject an in-memory PostgreSQL engine. Never JSON.
export function setTestDatabase(db: Database) {
  if (process.env.NODE_ENV !== "test" || process.env.VERCEL) throw new Error("Test database unavailable");
  testDatabase = db;
}

export function database(): Database {
  if (testDatabase && process.env.NODE_ENV === "test" && !process.env.VERCEL) return testDatabase;
  pool ??= new Pool({ connectionString: required("DATABASE_URL"), max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 });
  const current = pool;
  return {
    async query<T>(sql: string, values: unknown[] = []) {
      const result = await current.query(sql, values);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(run: (db: Database) => Promise<T>) {
      const client = await current.connect();
      const tx: Database = {
        async query<R>(sql: string, values: unknown[] = []) {
          const result = await client.query(sql, values);
          return { rows: result.rows as R[] };
        },
        transaction: (fn) => fn(tx),
      };
      try {
        await client.query("BEGIN");
        const value = await run(tx);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function ownerLock(db: Database, owner: string) {
  await db.query("INSERT INTO owners(id) VALUES ($1) ON CONFLICT DO NOTHING", [owner]);
  await db.query("SELECT id FROM owners WHERE id=$1 FOR UPDATE", [owner]);
}
