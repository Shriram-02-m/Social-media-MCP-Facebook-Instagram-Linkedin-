import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { config } from "@/lib/backend";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as { scheduledMediaDbPool?: Pool };

const POOL_MAX = 5;

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
  max: POOL_MAX,
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

// A client that errors while CHECKED OUT of the pool (between `connect()` and
// `release()`, for example inside a Drizzle transaction when the server
// terminates the connection) has no pg-internal error listener: an
// EventEmitter `error` event with no listener throws an uncaughtException and
// kills the serverless invocation. Attach a permanent safety listener to every
// client; pg-pool's own idle/checkout handlers still run alongside it, and the
// dead client is removed from the pool on its eventual release because
// `client._queryable` is false after a connection error.
pool.on("connect", (client: PoolClient) => {
  client.on("error", (error: Error & { code?: string }) => {
    console.error(
      JSON.stringify({
        event: "database_client_error",
        code: error.code ?? "UNKNOWN",
        message: "A pooled PostgreSQL connection failed; it will be removed from the pool.",
      }),
    );
  });
});

// Transport-level failures: Node socket errors and PostgreSQL connection-state
// / resource-limit SQLSTATEs. Anything else (a failed query, an adapter bug)
// is not a connection problem and must not trigger pool recovery.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  // connection_does_not_exist / sqlclient_unable_to_establish / etc.
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  // too_many_connections / admin_shutdown / crash_shutdown / cannot_connect_now
  "53300",
  "57P01",
  "57P02",
  "57P03",
  "53400",
]);
const CONNECTION_ERROR_PATTERN =
  /connection (terminated|refused|reset|timed out|ended)|too many clients|terminating connection|server closed the connection|socket (connection )?closed/i;

export function isConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
    if (CONNECTION_ERROR_PATTERN.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Serverless instances freeze between requests and providers (Supabase /
// Supavisor) close idle TCP connections while they are frozen. On the next
// request the pool hands out those dead clients one query at a time: the first
// query after a thaw can fail on up to `POOL_MAX` consecutive dead clients
// before reaching a healthy one, which is more than a single blind retry can
// recover from. Each failed probe removes exactly one dead client from the
// pool (`client.release(error)`), so this bounded loop deterministically ends
// with either a verified-healthy pooled connection or a genuine outage.
const PROBE_TIMEOUT_MS = 3000;
const DRAIN_DEADLINE_MS = 9000;

export async function ensureDatabaseConnection(): Promise<boolean> {
  const deadline = Date.now() + DRAIN_DEADLINE_MS;
  for (let attempt = 0; attempt <= POOL_MAX && Date.now() < deadline; attempt += 1) {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      // No connection could be obtained at all (connect timeout, connection
      // cap, pooler outage) - a real infrastructure failure, not a stale
      // socket.
      return false;
    }

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      client.query("SELECT 1").then(
        () => true,
        (error: unknown) => error,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(
          () => resolve("timeout"),
          Math.max(1000, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())),
        );
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (outcome === true) {
      client.release();
      return true;
    }

    // Remove the unhealthy client from the pool and force-close its socket;
    // the abandoned query, if any, rejects into the race result above and any
    // late client error is absorbed by the pool `error` listener.
    client.release(new Error("database client probe failed"));
    try {
      // `pg`'s `end()` returns void or a Promise depending on overload.
      void Promise.resolve(client.end()).catch(() => {});
    } catch {
      // Already closed.
    }

    if (outcome === "timeout" || isConnectionError(outcome)) continue;
    return false;
  }
  return false;
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.scheduledMediaDbPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
