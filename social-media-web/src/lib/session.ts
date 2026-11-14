import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import { auth, ADMIN_ROLE, type AppUser } from "@/lib/auth";

export type AdminSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/**
 * Thrown when the session lookup itself fails (database unreachable, connection
 * pool exhausted, adapter error) as opposed to a session being absent, expired,
 * or invalid. Better Auth returns `null` for those cases and only throws an
 * `APIError` (`FAILED_TO_GET_SESSION`) when the lookup cannot be completed.
 *
 * Callers must not treat this as "signed out": an infrastructure outage must
 * never silently sign a user out or render the dashboard as unauthenticated.
 */
export class SessionUnavailableError extends Error {
  readonly status = 503;
  readonly code = "SESSION_UNAVAILABLE";

  constructor() {
    super("Your session could not be verified because the authentication service is temporarily unavailable.");
    this.name = "SessionUnavailableError";
  }
}

// Log only non-sensitive identifying fields. The underlying database error can
// carry the bound session token in its query parameters, so the cause is never
// logged or forwarded to the client.
function logSessionLookupFailure(error: unknown): void {
  const details =
    error instanceof Error
      ? {
          name: error.name,
          message: error.message
            .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]")
            .slice(0, 300),
          code: (error as { body?: { code?: unknown } }).body?.code,
        }
      : { name: typeof error };
  console.error(JSON.stringify({ event: "session_lookup_failed", ...details }));
}

// Better Auth wraps every failed session lookup in an opaque `APIError`
// (FAILED_TO_GET_SESSION); the underlying database error is only logged, never
// attached as a cause, so transient connection failures cannot be recognized
// from the thrown error alone. Live diagnosis against the production database
// confirmed the failure mode: serverless instances on Vercel lose their pooled
// TCP sockets while frozen (Supabase/intermediaries close idle connections),
// and the next lookup fails with a connection-level error (ECONNRESET) before
// the pool establishes a replacement.
//
// Retry the lookup exactly once after a short delay. The second attempt
// re-runs the entire verification against the database - nothing is cached or
// assumed from the first attempt - so a retry can never fabricate a session.
// A persistent outage fails the retry too and still surfaces as
// `SessionUnavailableError`.
const SESSION_RETRY_DELAY_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupSession(): Promise<AdminSession | null> {
  const result = await auth.api.getSession({ headers: await headers() });
  return result ?? null;
}

export async function getSession(): Promise<AdminSession | null> {
  try {
    return await lookupSession();
  } catch (error) {
    // Never intercept Next.js control-flow errors (dynamic-usage from
    // `headers()`, redirect/notFound, prerender bailouts). They must reach the
    // framework; during `next build` they are how a route is marked dynamic.
    unstable_rethrow(error);
    logSessionLookupFailure(error);
    await delay(SESSION_RETRY_DELAY_MS);
    try {
      return await lookupSession();
    } catch (retryError) {
      unstable_rethrow(retryError);
      logSessionLookupFailure(retryError);
      throw new SessionUnavailableError();
    }
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "UnauthorizedError";
  }
}

export class ApprovalRequiredError extends Error {
  readonly status = 403;
  readonly code: "pending" | "rejected" | "suspended" | "deleted";

  constructor(code: ApprovalRequiredError["code"]) {
    const messages: Record<ApprovalRequiredError["code"], string> = {
      pending: "This account is awaiting administrator approval.",
      rejected: "This account was not approved. Contact the administrator if you believe this is a mistake.",
      suspended: "This account has been suspended. Contact the administrator if you believe this is a mistake.",
      deleted: "This account is no longer active.",
    };
    super(messages[code]);
    this.name = "ApprovalRequiredError";
    this.code = code;
  }
}

/** Outcome of the account-state check: either access or the deny reason. */
export type AccessDecision = "approved" | ApprovalRequiredError["code"];

export interface AccountState {
  role: string;
  isAdmin: boolean;
  approvalStatus: "pending" | "approved" | "rejected";
  banned: boolean;
  banActive: boolean;
  deleted: boolean;
}

// Better Auth returns the admin-plugin fields on the session user. Roles can
// be a comma-joined string or an array; parse defensively so authorization
// never depends on a specific plugin typing shape.
export function readAccountState(session: AdminSession | null): AccountState | null {
  if (!session) return null;
  const user = session.user as unknown as Record<string, unknown> & Pick<AppUser, "id">;
  const rawRole = user["role"];
  const roleParts = Array.isArray(rawRole)
    ? rawRole.map(String)
    : typeof rawRole === "string" ? rawRole.split(",").map((part) => part.trim()) : [];
  if (roleParts.length === 0) roleParts.push("user");
  const rawApproval = user["approvalStatus"];
  const approvalStatus = rawApproval === "approved" || rawApproval === "rejected" ? rawApproval : "pending";
  const banned = user["banned"] === true;
  const banExpiresAt = user["banExpires"] instanceof Date ? user["banExpires"] : null;
  const deletedAt = user["deletedAt"];
  return {
    role: roleParts[0]!,
    isAdmin: roleParts.includes(ADMIN_ROLE),
    approvalStatus,
    banned,
    banActive: banned && (banExpiresAt === null || banExpiresAt.getTime() > Date.now()),
    deleted: deletedAt instanceof Date && !Number.isNaN(deletedAt.getTime()),
  };
}

export function denyReason(state: AccountState): AccessDecision {
  if (state.deleted) return "deleted";
  if (state.banActive) return "suspended";
  if (state.approvalStatus !== "approved") return state.approvalStatus;
  // A banned flag with a stale expiry is treated as approved again.
  return "approved";
}

/** Verify that a valid authenticated session exists. */
export async function requireAuthenticatedUser(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}

/**
 * Verify the session user is an approved, unbanned, not soft-deleted account.
 * The Super Admin passes this check as well (admin accounts are approved).
 */
export async function requireApprovedUser(): Promise<AdminSession> {
  const session = await requireAuthenticatedUser();
  const state = readAccountState(session);
  if (!state) throw new UnauthorizedError();
  const reason = denyReason(state);
  if (reason !== "approved") throw new ApprovalRequiredError(reason);
  return session;
}

/**
 * Verify the session belongs to the single Super Admin. Regular users -
 * regardless of session validity - can never pass this check, and role
 * changes are only possible through admin-only endpoints backed by the
 * database-level single-admin unique index.
 */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await requireAuthenticatedUser();
  const state = readAccountState(session);
  if (!state) throw new UnauthorizedError();
  if (!state.isAdmin) throw new ApprovalRequiredError("rejected");
  const reason = denyReason(state);
  if (reason !== "approved") throw new ApprovalRequiredError(reason);
  return session;
}

/**
 * Ownership guard: the authenticated user id always comes from the verified
 * server-side session; a client-supplied user id is never trusted. Compare it
 * against the resource owner when a request could address another user's data.
 */
export function requireResourceOwnership(session: AdminSession, ownerUserId: string): void {
  if (session.user.id !== ownerUserId) throw new ApprovalRequiredError("rejected");
}
