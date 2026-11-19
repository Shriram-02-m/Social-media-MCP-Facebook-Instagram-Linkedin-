/**
 * PostgreSQL connection string resolution with a production safety gate.
 *
 * `pg` treats an empty `connectionString` as "not configured" and silently
 * falls back to its own defaults (host 127.0.0.1, port 5432). Previously the
 * web app passed `""` whenever DATABASE_URL was unset, so a Vercel deployment
 * with a missing variable looked healthy until the first query failed with
 * ECONNREFUSED 127.0.0.1:5432. Production now fails early with an actionable,
 * credential-free error instead.
 *
 * Local development keeps the historical behavior: an unset URL is returned
 * as an empty string so `pg` can use a locally running PostgreSQL instance.
 */

export interface DatabaseEnv {
  DATABASE_URL?: string | undefined;
  NODE_ENV?: string | undefined;
  /** Next.js sets this during `next build`; runtime validation must not break builds. */
  NEXT_PHASE?: string | undefined;
}

export const MISSING_PRODUCTION_DATABASE_URL
  = "DATABASE_URL is required in production. Set it in the Vercel project environment to the remote PostgreSQL connection string; localhost is not supported.";
export const INVALID_PRODUCTION_DATABASE_URL
  = "DATABASE_URL must be a valid PostgreSQL connection string in production. Check the Vercel project environment variable.";
export const LOOPBACK_PRODUCTION_DATABASE_URL
  = "DATABASE_URL must point to a remote PostgreSQL host in production. Loopback addresses (localhost, 127.0.0.0/8, ::1) are not allowed.";

function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "::1"
    || host === "::"
    || host === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Resolve the connection string used to create the Drizzle/pg pool.
 *
 * Production (outside the Next.js build phase) requires a well-formed
 * PostgreSQL URL with a non-loopback host. Nothing derived from the URL is
 * ever included in an error message, so credentials cannot leak into logs.
 */
export function resolveDatabaseUrl(
  env: DatabaseEnv = process.env,
  fallbackUrl = "",
): string {
  const raw = (env.DATABASE_URL?.trim() || fallbackUrl || "").trim();
  const requiresRemoteDatabase
    = env.NODE_ENV === "production"
      && env.NEXT_PHASE !== "phase-production-build";

  if (!raw) {
    if (requiresRemoteDatabase) throw new Error(MISSING_PRODUCTION_DATABASE_URL);
    return "";
  }

  // Preserve local development behavior for an intentionally local/malformed
  // value; only a real production runtime enforces the remote requirement.
  if (!requiresRemoteDatabase) return raw;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(INVALID_PRODUCTION_DATABASE_URL);
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(INVALID_PRODUCTION_DATABASE_URL);
  }
  if (!parsed.hostname || isLoopbackHost(parsed.hostname)) {
    throw new Error(LOOPBACK_PRODUCTION_DATABASE_URL);
  }
  return raw;
}
