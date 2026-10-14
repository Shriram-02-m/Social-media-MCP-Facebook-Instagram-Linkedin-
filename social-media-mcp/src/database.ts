import { Pool } from "pg";
import { config } from "./config/env.js";

let pool: Pool | undefined;

export function databasePool(): Pool {
  if (!config.databaseUrl) throw new Error("Set DATABASE_URL to a PostgreSQL connection string to use scheduled posts.");
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      keepAlive: true,
    });
    pool.on("error", (error: Error & { code?: string }) => {
      console.error(JSON.stringify({
        event: "database_pool_error",
        code: error.code ?? "UNKNOWN",
        message: "An idle PostgreSQL connection failed; the pool will establish a replacement as needed.",
      }));
    });
  }
  return pool;
}

export async function closeDatabasePool(): Promise<void> {
  if (!pool) return;
  const currentPool = pool;
  pool = undefined;
  await currentPool.end();
}
