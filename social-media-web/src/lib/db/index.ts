import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "@/lib/backend";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as { scheduledMediaDbPool?: Pool };

function connectionString(): string {
  return (process.env.DATABASE_URL?.trim() || config.databaseUrl || "").trim();
}

const pool = globalForDb.scheduledMediaDbPool ?? new Pool({
  connectionString: connectionString(),
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

// `pg` emits `error` on the pool when an idle client's connection dies (for
// example Supabase closing an idle TCP connection with ECONNRESET). Without a
// listener that becomes an uncaughtException and takes down the server process
// / serverless invocation. Log it and let the pool establish a replacement,
// matching the backend pool in social-media-mcp/src/database.ts.
pool.on("error", (error: Error & { code?: string }) => {
  console.error(
    JSON.stringify({
      event: "database_pool_error",
      code: error.code ?? "UNKNOWN",
      message:
        "An idle PostgreSQL connection failed; the pool will establish a replacement as needed.",
    }),
  );
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.scheduledMediaDbPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
