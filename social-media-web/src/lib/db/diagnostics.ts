import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export type DatabaseErrorCategory = "capacity" | "connection" | "query" | "unknown";

export interface DatabaseDiagnosticState {
  correlationId: string;
  operation: string;
  attempt: number;
  /**
   * Set by Better Auth's logger when the dependency sees the real database
   * error. Better Auth otherwise replaces it with an opaque APIError, so this
   * is the only reliable way to tell a transient connection failure from a
   * permanent query/session failure without changing the auth architecture.
   */
  lastError?: unknown;
}

const diagnosticStorage = new AsyncLocalStorage<DatabaseDiagnosticState>();

export function newDatabaseCorrelationId(): string {
  return randomUUID();
}

export function createDatabaseDiagnosticState(input: {
  correlationId?: string;
  operation: string;
  attempt: number;
}): DatabaseDiagnosticState {
  return {
    correlationId: input.correlationId ?? newDatabaseCorrelationId(),
    operation: input.operation,
    attempt: input.attempt,
  };
}

export function runWithDatabaseDiagnostics<T>(
  state: DatabaseDiagnosticState,
  operation: () => Promise<T>,
): Promise<T> {
  return diagnosticStorage.run(state, operation);
}

export function getDatabaseDiagnosticState(): DatabaseDiagnosticState | undefined {
  return diagnosticStorage.getStore();
}

export function recordDatabaseError(error: unknown): void {
  const state = diagnosticStorage.getStore();
  if (state) state.lastError = error;
}

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
  // admin_shutdown / crash_shutdown / cannot_connect_now
  "57P01",
  "57P02",
  "57P03",
  "53400",
]);

// Pool/capacity limits are a different failure class from a broken socket.
// Retrying them cannot create a free slot and only adds more client sessions to
// an already saturated pooler, so they must never enter the recovery loop.
// EMAXCONNSESSION/EMAXCONN are Supavisor codes; 53300 is PostgreSQL
// too_many_connections.
const CAPACITY_ERROR_CODES = new Set(["EMAXCONNSESSION", "EMAXCONN", "53300"]);

const CAPACITY_ERROR_PATTERN =
  /max clients reached|max client connections reached|too many clients|limited to pool_size|pool_size:/i;

const CONNECTION_ERROR_PATTERN =
  /connection (terminated|refused|reset|timed out|ended)|timeout exceeded when trying to connect|timed out while waiting for a connection|terminating connection|server closed the connection|socket (connection )?closed/i;

/** Walk `cause` chains; Drizzle and pg wrap the original SQLSTATE error. */
export function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

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

export function isCapacityError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && CAPACITY_ERROR_CODES.has(code)) return true;
    if (CAPACITY_ERROR_PATTERN.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function databaseErrorCategory(error: unknown): DatabaseErrorCategory {
  // Capacity must win over connection: a saturated pooler can also surface as
  // SQLSTATE 53300, and it must never be routed through the retry path.
  if (isCapacityError(error)) return "capacity";
  if (isConnectionError(error)) return "connection";
  if (error instanceof Error) return "query";
  return "unknown";
}

export function redactDatabaseError(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]")
    .slice(0, 300);
}

export const RETRY_BASE_DELAY_MS = 80;
export const RETRY_MAX_DELAY_MS = 400;

/** Exponential backoff with symmetric +/-25% jitter. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    RETRY_MAX_DELAY_MS,
  );
  const jittered = exponential * (0.75 + random() * 0.5);
  return Math.round(jittered);
}
