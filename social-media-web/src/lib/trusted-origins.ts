/**
 * Exact origin allowlist for Better Auth's CSRF/origin check.
 *
 * Better Auth rejects a request when the `Origin` header does not match one of
 * its trusted origins. A plain origin string is matched exactly, so every
 * entry here must be a complete `https://` (or, in development, `http://`)
 * origin. Wildcards, paths, query strings, userinfo and custom schemes are
 * rejected so a misconfigured environment variable can never widen the CSRF
 * boundary.
 */

/** Stable production origin, always trusted regardless of deployment URL. */
export const CANONICAL_PRODUCTION_ORIGIN
  = "https://social-media-web-brown.vercel.app";

/** Local Next.js development origin. Only trusted when NODE_ENV=development. */
export const LOCAL_DEVELOPMENT_ORIGIN = "http://localhost:3000";

export interface TrustedOriginEnv {
  BETTER_AUTH_URL?: string | undefined;
  /** Comma/whitespace separated list of additional explicitly approved origins. */
  BETTER_AUTH_TRUSTED_ORIGINS?: string | undefined;
  /** Set automatically by Vercel to the current deployment host (no scheme). */
  VERCEL_URL?: string | undefined;
  /** Set automatically by Vercel to the branch-specific host (no scheme). */
  VERCEL_BRANCH_URL?: string | undefined;
  NODE_ENV?: string | undefined;
}

const WILDCARD_PATTERN = /[*?]/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

function normalizeOrigin(value: string, allowInsecureHttp: boolean): string | null {
  const candidate = value.trim();
  if (
    !candidate
    || WILDCARD_PATTERN.test(candidate)
    || CONTROL_CHARACTER_PATTERN.test(candidate)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.protocol === "http:" && !allowInsecureHttp) return null;
  // An origin must be scheme + host only: no credentials, path, query or hash.
  if (parsed.username || parsed.password) return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;
  if (parsed.search || parsed.hash) return null;

  // URL.origin lowercases the host and removes default ports.
  return parsed.origin;
}

// Vercel exposes deployment hosts without a scheme (e.g.
// "my-app-git-main-team.vercel.app"). Accept only a bare host so a malformed
// value cannot inject a scheme, path or wildcard.
function normalizePlatformHost(value: string | undefined): string | null {
  const host = value?.trim();
  if (!host || host.includes("://") || host.includes("/")) return null;
  return normalizeOrigin(`https://${host}`, false);
}

/**
 * Resolve the complete, exact allowlist used by `betterAuth({ trustedOrigins })`.
 *
 * Sources, in order:
 * 1. Canonical production origin (always).
 * 2. `BETTER_AUTH_URL` - the app's own configured base URL.
 * 3. `VERCEL_URL` / `VERCEL_BRANCH_URL` - the current Vercel deployment hosts.
 * 4. `BETTER_AUTH_TRUSTED_ORIGINS` - explicitly approved extra origins.
 * 5. Localhost - only in development.
 */
export function resolveTrustedOrigins(env: TrustedOriginEnv = process.env): string[] {
  const isDevelopment = env.NODE_ENV === "development";
  const origins: string[] = [CANONICAL_PRODUCTION_ORIGIN];

  if (env.BETTER_AUTH_URL) {
    const origin = normalizeOrigin(env.BETTER_AUTH_URL, isDevelopment);
    if (origin) origins.push(origin);
  }

  for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL]) {
    const origin = normalizePlatformHost(host);
    if (origin) origins.push(origin);
  }

  const explicit = env.BETTER_AUTH_TRUSTED_ORIGINS ?? "";
  for (const value of explicit.split(/[\s,]+/)) {
    const origin = normalizeOrigin(value, isDevelopment);
    if (origin) origins.push(origin);
  }

  if (isDevelopment) origins.push(LOCAL_DEVELOPMENT_ORIGIN);

  return [...new Set(origins)];
}

/**
 * Resolve the Better Auth `baseURL` without ever producing a protocol mismatch
 * in production. An explicitly configured HTTPS origin wins; a missing or
 * invalid value falls back to the canonical production origin instead of
 * localhost. Development keeps the local default.
 */
export function resolveAuthBaseURL(env: TrustedOriginEnv = process.env): string {
  const configured = env.BETTER_AUTH_URL?.trim();
  if (env.NODE_ENV === "production") {
    return (configured ? normalizeOrigin(configured, false) : null)
      ?? CANONICAL_PRODUCTION_ORIGIN;
  }
  return configured || LOCAL_DEVELOPMENT_ORIGIN;
}

/**
 * Exact allowlist check, mirroring Better Auth's matching for plain origins.
 * Exported for tests and callers that need to reason about the same boundary.
 */
export function isTrustedOrigin(
  origin: string,
  trustedOrigins: readonly string[],
): boolean {
  const normalized = normalizeOrigin(origin, true);
  return normalized !== null && trustedOrigins.includes(normalized);
}
