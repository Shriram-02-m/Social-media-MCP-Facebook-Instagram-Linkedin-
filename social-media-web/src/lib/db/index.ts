import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { config } from "@/lib/backend";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as { scheduledMediaDbPool?: Pool };

function connectionString(): string {
  return (process.env.DATABASE_URL?.trim() || config.databaseUrl || "").trim();
}

// `pg` enables TLS only when the connection string itself carries an `sslmode`
// parameter; without one it connects in cleartext. Supabase does not currently
// reject unencrypted sessions, so a DATABASE_URL without `?sslmode=require`
// silently degrades to plaintext. Enforce encryption for Supabase hosts unless
// the URL explicitly configures TLS itself. `rejectUnauthorized: false` matches
// `sslmode=require` semantics (encryption required, no CA verification) so no
// CA bundle has to be shipped with the deployment.
function sslOverride(connectionUrl: string): PoolConfig["ssl"] {
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
  if (parsed.searchParams.has("sslmode")) return undefined;
  if (!/\.supabase\.(co|com)$/.test(parsed.hostname)) return undefined;
  return { rejectUnauthorized: false };
}

const connectionUrl = connectionString();

const pool = globalForDb.scheduledMediaDbPool ?? new Pool({
  connectionString: connectionUrl,
  ssl: sslOverride(connectionUrl),
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
