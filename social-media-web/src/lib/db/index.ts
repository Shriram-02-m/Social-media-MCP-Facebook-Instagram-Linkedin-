import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient, type PoolConfig } from "pg";

import { config, setDatabasePool } from "@/lib/backend";
import { resolveDatabaseUrl } from "@/lib/db/connection-url";
import {
  createDatabaseDiagnosticState,
  databaseErrorCategory,
  databaseErrorCode,
  isCapacityError,
  isConnectionError,
  newDatabaseCorrelationId,
  retryDelayMs,
  runWithDatabaseDiagnostics,
} from "@/lib/db/diagnostics";

import * as schema from "./schema";

export { isCapacityError, isConnectionError } from "@/lib/db/diagnostics";

const globalForDb = globalThis as unknown as { scheduledMediaDbPool?: Pool };

// Supabase's serverless guidance is one pooled connection per compute
// instance with the Transaction Pooler (port 6543): the pooler multiplexes
// backend connections and a larger per-isolate pool only multiplies client
// sessions. With the session-mode URL this value also caps how many sessions a
// single warm Vercel instance can hold while the deployment URL is corrected.
export const POOL_MAX = 1;

function connectionString(): string {
  // Production requires an explicit remote DATABASE_URL. An empty string must
  // never reach pg: pg would silently use localhost:5432 instead.
  return resolveDatabaseUrl(process.env, config.databaseUrl);
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

const cachedPool = globalForDb.scheduledMediaDbPool;
const pool = cachedPool ?? new Pool({
  connectionString: connectionUrl,
  ssl: sslOverride(connectionUrl),
  max: POOL_MAX,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

function attachPoolDiagnostics(activePool: Pool): void {
  // `pg` emits `error` on the pool when an idle client's connection dies (for
  // example Supabase closing an idle TCP connection with ECONNRESET). Without a
  // listener that becomes an uncaughtException and takes down the server
  // process / serverless invocation. Log it and let the pool establish a
  // replacement, matching the backend pool in social-media-mcp/src/database.ts.
  activePool.on("error", (error: Error & { code?: string }) => {
    console.error(
      JSON.stringify({
        event: "database_pool_error",
        code: error.code ?? "UNKNOWN",
        message:
          "An idle PostgreSQL connection failed; the pool will establish a replacement as needed.",
      }),
    );
  });

  // A client that errors while CHECKED OUT of the pool (between `connect()`
  // and `release()`, for example inside a Drizzle transaction when the server
  // terminates the connection) has no pg-internal error listener: an
  // EventEmitter `error` event with no listener throws an uncaughtException and
  // kills the serverless invocation. Attach a permanent safety listener to
  // every client; pg-pool's own idle/checkout handlers still run alongside it.
  activePool.on("connect", (client: PoolClient) => {
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
}

// Only attach once per actual Pool instance. In development the cached pool is
// reused across HMR module evaluations; re-attaching there would accumulate
// duplicate listeners on the same EventEmitter.
if (!cachedPool) attachPoolDiagnostics(pool);

// The web process imports compiled backend modules (scheduler, token store,
// OAuth) that use `databasePool()`. Inject this single pool so one Vercel
// instance never opens both a Drizzle pool and a second backend pool against
// the same Supabase connection string. The standalone Render worker does not
// call this and keeps its own long-lived pool.
setDatabasePool(pool);

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/** Safe-to-log pool counters; no connection strings or query parameters. */
export function poolStats(): PoolStats {
  try {
    return {
      total: pool.totalCount ?? 0,
      idle: pool.idleCount ?? 0,
      waiting: pool.waitingCount ?? 0,
    };
  } catch {
    return { total: 0, idle: 0, waiting: 0 };
  }
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

export interface DatabaseRecoveryContext {
  correlationId?: string;
  operation?: string;
  attempt?: number;
}

export async function ensureDatabaseConnection(
  context: DatabaseRecoveryContext = {},
): Promise<boolean> {
  const correlationId = context.correlationId ?? newDatabaseCorrelationId();
  const operation = context.operation ?? "database.ensure_connection";
  const attempt = context.attempt ?? 1;
  const startedAt = Date.now();
  const deadline = startedAt + DRAIN_DEADLINE_MS;
  let probes = 0;

  for (let probe = 0; probe <= POOL_MAX && Date.now() < deadline; probe += 1) {
    probes = probe + 1;
    const probeStartedAt = Date.now();
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      // No connection could be obtained at all (connect timeout, pooler
      // capacity cap or outage) - a real infrastructure failure, not a stale
      // socket. A capacity rejection means more retries would only add more
      // client sessions, so it gets its own event and never enters recovery.
      if (isCapacityError(error)) {
        console.error(JSON.stringify({
          event: "database_pool_capacity_exhausted",
          correlationId,
          operation,
          attempt,
          probe: probes,
          durationMs: Date.now() - probeStartedAt,
          code: databaseErrorCode(error),
          pool: poolStats(),
        }));
      }
      console.error(JSON.stringify({
        event: "database_connection_probe",
        correlationId,
        operation,
        attempt,
        probe: probes,
        durationMs: Date.now() - probeStartedAt,
        healthy: false,
        category: databaseErrorCategory(error),
        code: databaseErrorCode(error),
        pool: poolStats(),
      }));
      break;
    }

    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      client.query("SELECT 1").then(
        () => true as const,
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
      console.error(JSON.stringify({
        event: "database_connection_probe",
        correlationId,
        operation,
        attempt,
        probe: probes,
        durationMs: Date.now() - probeStartedAt,
        healthy: true,
        pool: poolStats(),
      }));
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

    console.error(JSON.stringify({
      event: "database_connection_probe",
      correlationId,
      operation,
      attempt,
      probe: probes,
      durationMs: Date.now() - probeStartedAt,
      healthy: false,
      category: outcome === "timeout" ? "connection" : databaseErrorCategory(outcome),
      code: outcome === "timeout" ? "PROBE_TIMEOUT" : databaseErrorCode(outcome),
      pool: poolStats(),
    }));

    if (outcome === "timeout" || (isConnectionError(outcome) && !isCapacityError(outcome))) continue;
    break;
  }

  console.error(JSON.stringify({
    event: "database_recovery",
    correlationId,
    operation,
    attempt,
    recovered: false,
    probes,
    durationMs: Date.now() - startedAt,
    pool: poolStats(),
  }));
  return false;
}

export interface DatabaseRecoveryOptions {
  operation: string;
  correlationId?: string;
  maxAttempts?: number;
  /**
   * Test/debug seam. Production uses the shared pool drain above; injecting a
   * recovery function keeps unit tests deterministic without a live database.
   */
  recover?: (context: DatabaseRecoveryContext) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** Return false for framework/control-flow errors that must bypass recovery. */
  shouldHandleError?: (error: unknown) => boolean;
}

/**
 * Run a database-backed operation with one bounded retry for *connection*
 * failures only. The real error is captured in the async diagnostic state by
 * Better Auth's logger, so a permanent query/session failure is never retried.
 */
export async function withDatabaseRecovery<T>(
  operation: () => Promise<T>,
  options: DatabaseRecoveryOptions,
): Promise<T> {
  const correlationId = options.correlationId ?? newDatabaseCorrelationId();
  const maxAttempts = options.maxAttempts ?? 2;
  const recover = options.recover ?? ((context: DatabaseRecoveryContext) => ensureDatabaseConnection(context));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = createDatabaseDiagnosticState({
      correlationId,
      operation: options.operation,
      attempt,
    });
    const startedAt = Date.now();
    try {
      return await runWithDatabaseDiagnostics(state, operation);
    } catch (error) {
      if (options.shouldHandleError && !options.shouldHandleError(error)) throw error;

      const rawError = state.lastError ?? error;
      // An opaque error with no captured DB error is not evidence of a query
      // failure; it is simply unclassified and must not be retried.
      const category = state.lastError ? databaseErrorCategory(rawError) : "unknown";
      const retryable = category === "connection" && attempt < maxAttempts;
      console.error(JSON.stringify({
        event: "database_operation_failed",
        correlationId,
        operation: options.operation,
        attempt,
        maxAttempts,
        durationMs: Date.now() - startedAt,
        category,
        code: databaseErrorCode(rawError),
        retryable,
        pool: poolStats(),
      }));

      if (isCapacityError(rawError)) {
        console.error(JSON.stringify({
          event: "database_capacity_exhausted",
          correlationId,
          operation: options.operation,
          attempt,
          code: databaseErrorCode(rawError),
          pool: poolStats(),
        }));
      }

      if (!retryable) throw error;

      const recoveryStartedAt = Date.now();
      const recovered = await recover({ correlationId, operation: options.operation, attempt });
      console.error(JSON.stringify({
        event: "database_recovery_attempt",
        correlationId,
        operation: options.operation,
        attempt,
        recovered,
        durationMs: Date.now() - recoveryStartedAt,
        pool: poolStats(),
      }));
      if (!recovered) throw error;

      await sleep(retryDelayMs(attempt));
    }
  }

  // Unreachable with maxAttempts >= 1, but keeps the return type total.
  throw new Error("Database operation exhausted all retry attempts.");
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.scheduledMediaDbPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
