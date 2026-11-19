import { Pool } from "pg";
import { config } from "./config/env.js";

let pool: Pool | undefined;
// When a long-lived host (the Vercel web app) injects its already-sized pool,
// this module borrows it instead of opening a second independent set of
// PostgreSQL sessions against the same connection string.
let externallyOwned = false;

/**
 * Share an existing pool with the backend modules.
 *
 * Serverless hosts must call this before any scheduler/token/OAuth function
 * runs. The pool keeps its own lifecycle: closeDatabasePool() clears the
 * reference but never ends a pool it does not own.
 */
export function setDatabasePool(sharedPool: Pool): void {
  pool = sharedPool;
  externallyOwned = true;
}

export function databasePool(): Pool {
  if (!config.databaseUrl && !pool) throw new Error("Set DATABASE_URL to a PostgreSQL connection string to use scheduled posts.");
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      keepAlive: true,
    });
    externallyOwned = false;
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
  const owned = !externallyOwned;
  pool = undefined;
  externallyOwned = false;
  if (owned) await currentPool.end();
}
