import { createHash } from "node:crypto";
import { databasePool } from "../database.js";
import { ensureDatabaseMigrations } from "../database-migrations.js";
import type { Platform } from "../platforms/types.js";

// Authorization sessions exist for the brief window between starting a provider
// OAuth flow and receiving the browser callback. In local mode they live in
// process memory (mirroring the original behavior); in cloud mode they are
// persisted in PostgreSQL so any Render instance can complete the callback.
export type OAuthSessionStatus = "pending" | "connected" | "cancelled" | "failed" | "expired";
// `processing` is an internal claim marker written atomically before the token
// exchange runs. The frontend still sees it as `pending`.
export type OAuthStoredStatus = OAuthSessionStatus | "processing";

export interface AuthorizationSessionStatus {
  sessionId: string;
  platform: Platform;
  status: OAuthSessionStatus;
  expiresAt: number;
  error?: string;
}

export interface CreateOAuthSessionInput {
  sessionId: string;
  state: string;
  userId: string;
  platform: Platform;
  redirectUri: string;
  expiresAt: number;
  // Fingerprint of the Developer App credentials used to build the consent URL.
  // Optional so sessions created before the feature keep working.
  appCredentialFingerprint?: string;
}

export interface ClaimedOAuthSession {
  sessionId: string;
  userId: string;
  platform: Platform;
  redirectUri: string;
  expiresAt: number;
  appCredentialFingerprint?: string;
}

export type OAuthClaimFailure = "unknown" | "expired" | "used" | "wrong_platform";
export type OAuthClaimResult =
  | { claimed: true; session: ClaimedOAuthSession }
  | { claimed: false; reason: OAuthClaimFailure };

export interface OAuthSessionStore {
  create(input: CreateOAuthSessionInput): Promise<void>;
  claim(state: string, expectedPlatforms: readonly Platform[]): Promise<OAuthClaimResult>;
  getStatus(sessionId: string, userId: string): Promise<AuthorizationSessionStatus>;
  updateStatus(sessionId: string, status: OAuthSessionStatus, error?: string): Promise<void>;
  waitForStatus(sessionId: string, userId: string, timeoutSeconds: number): Promise<AuthorizationSessionStatus>;
}

export const authorizationLifetimeMs = 15 * 60 * 1000;
const sessionRetentionMs = 24 * 60 * 60 * 1000;
const sessionMissingMessage = "Authorization session not found or expired. Start a new authorization request.";

// The raw state value is a bearer-style secret: whoever holds it can complete a
// pending authorization. Cloud persistence therefore stores only its SHA-256
// digest, which is enough for an exact-match lookup and never exposes the value.
export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function expectedPlatformsForCallbackPath(pathname: string): readonly Platform[] | null {
  if (pathname === "/oauth/meta/callback") return ["facebook", "instagram"];
  if (pathname === "/oauth/linkedin/callback") return ["linkedin"];
  return null;
}

export function isOAuthCallbackPath(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://localhost").pathname;
  } catch {
    return false;
  }
  return expectedPlatformsForCallbackPath(pathname) !== null;
}

export type OAuthRedirectResult = "connected" | "cancelled" | "failed" | "expired";

// Builds the only browser redirect this app ever emits after a provider
// callback: a fixed `/accounts` path on the configured frontend origin. Because
// the origin comes from configuration (never the request) and the path is
// constant, there is no way for a caller to turn this into an open redirect.
export function buildFrontendRedirectUrl(
  frontendBaseUrl: string,
  result: OAuthRedirectResult,
  platform?: Platform,
): string | null {
  const base = frontendBaseUrl.trim();
  if (!base) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  const redirect = new URL("/accounts", parsed);
  redirect.searchParams.set("oauth", result);
  if (platform) redirect.searchParams.set("platform", platform);
  return redirect.toString();
}

function redirectResultForClaimFailure(reason: OAuthClaimFailure): OAuthRedirectResult {
  return reason === "expired" ? "expired" : "failed";
}

export function claimFailureResult(reason: OAuthClaimFailure): "failed" | "expired" {
  return redirectResultForClaimFailure(reason) === "expired" ? "expired" : "failed";
}

interface MemoryRecord {
  sessionId: string;
  state: string;
  userId: string;
  platform: Platform;
  redirectUri: string;
  status: OAuthStoredStatus;
  error?: string;
  createdAt: number;
  expiresAt: number;
  completedAt?: number;
  appCredentialFingerprint?: string;
}

function isTerminal(status: OAuthStoredStatus): boolean {
  return status === "connected" || status === "cancelled" || status === "failed" || status === "expired";
}

function statusView(record: MemoryRecord): AuthorizationSessionStatus {
  const expiredByTime = record.expiresAt <= Date.now();
  const status: OAuthSessionStatus = record.status === "processing"
    ? "pending"
    : record.status;
  const resolved: OAuthSessionStatus = expiredByTime && status === "pending" ? "expired" : status;
  return {
    sessionId: record.sessionId,
    platform: record.platform,
    status: resolved,
    expiresAt: record.expiresAt,
    ...(record.error ? { error: record.error } : {}),
  };
}

export class InMemoryOAuthSessionStore implements OAuthSessionStore {
  private readonly byState = new Map<string, MemoryRecord>();
  private readonly byId = new Map<string, MemoryRecord>();
  private readonly waiters = new Map<string, Set<(status: AuthorizationSessionStatus) => void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  async create(input: CreateOAuthSessionInput): Promise<void> {
    this.prune();
    const record: MemoryRecord = {
      sessionId: input.sessionId,
      state: input.state,
      userId: input.userId,
      platform: input.platform,
      redirectUri: input.redirectUri,
      status: "pending",
      createdAt: Date.now(),
      expiresAt: input.expiresAt,
      ...(input.appCredentialFingerprint ? { appCredentialFingerprint: input.appCredentialFingerprint } : {}),
    };
    this.byState.set(record.state, record);
    this.byId.set(record.sessionId, record);
    const delay = Math.max(0, record.expiresAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(record.sessionId);
      if (!isTerminal(record.status)) {
        this.applyStatus(record, "expired", "The authorization request expired before the provider callback arrived.");
      }
    }, delay);
    timer.unref();
    this.timers.set(record.sessionId, timer);
  }

  async claim(state: string, expectedPlatforms: readonly Platform[]): Promise<OAuthClaimResult> {
    const record = this.byState.get(state);
    if (!record) return { claimed: false, reason: "unknown" };
    // Reject a state presented on the wrong callback route before consuming it
    // so a legitimate callback on the correct route can still succeed.
    if (!expectedPlatforms.includes(record.platform)) return { claimed: false, reason: "wrong_platform" };
    if (record.expiresAt <= Date.now()) {
      if (!isTerminal(record.status)) {
        this.applyStatus(record, "expired", "The authorization request expired before the provider callback arrived.");
      }
      return { claimed: false, reason: "expired" };
    }
    if (record.status !== "pending") return { claimed: false, reason: "used" };
    record.status = "processing";
    return {
      claimed: true,
      session: {
        sessionId: record.sessionId,
        userId: record.userId,
        platform: record.platform,
        redirectUri: record.redirectUri,
        expiresAt: record.expiresAt,
        ...(record.appCredentialFingerprint ? { appCredentialFingerprint: record.appCredentialFingerprint } : {}),
      },
    };
  }

  async getStatus(sessionId: string, userId: string): Promise<AuthorizationSessionStatus> {
    const record = this.requireOwned(sessionId, userId);
    this.expireIfNeeded(record);
    return statusView(record);
  }

  async updateStatus(sessionId: string, status: OAuthSessionStatus, error?: string): Promise<void> {
    const record = this.byId.get(sessionId);
    if (!record) return;
    this.applyStatus(record, status, error);
  }

  async waitForStatus(sessionId: string, userId: string, timeoutSeconds: number): Promise<AuthorizationSessionStatus> {
    const record = this.requireOwned(sessionId, userId);
    this.expireIfNeeded(record);
    if (record.status !== "pending" || timeoutSeconds === 0) return statusView(record);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(sessionId) ?? new Set<(status: AuthorizationSessionStatus) => void>();
      let timer: NodeJS.Timeout;
      const finish = (status: AuthorizationSessionStatus) => {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve(status);
      };
      timer = setTimeout(() => finish(statusView(record)), timeoutSeconds * 1000);
      timer.unref();
      waiters.add(finish);
      this.waiters.set(sessionId, waiters);
    });
  }

  private requireOwned(sessionId: string, userId: string): MemoryRecord {
    const record = this.byId.get(sessionId);
    if (!record || record.userId !== userId) throw new Error(sessionMissingMessage);
    return record;
  }

  private expireIfNeeded(record: MemoryRecord): void {
    if (record.expiresAt <= Date.now() && !isTerminal(record.status)) {
      const timer = this.timers.get(record.sessionId);
      if (timer) this.timers.delete(record.sessionId);
      this.applyStatus(record, "expired", "The authorization request expired before the provider callback arrived.");
    }
  }

  private applyStatus(record: MemoryRecord, status: OAuthSessionStatus, error?: string): void {
    record.status = status;
    if (error) record.error = error;
    else delete record.error;
    record.completedAt = Date.now();
    const view = statusView(record);
    const waiters = this.waiters.get(record.sessionId);
    if (waiters) {
      for (const resolve of waiters) resolve(view);
      waiters.clear();
    }
    const timer = this.timers.get(record.sessionId);
    if (timer && isTerminal(status)) {
      clearTimeout(timer);
      this.timers.delete(record.sessionId);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - sessionRetentionMs;
    for (const [sessionId, record] of this.byId) {
      if (record.completedAt === undefined || record.completedAt >= cutoff) continue;
      this.byId.delete(sessionId);
      this.byState.delete(record.state);
      const timer = this.timers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(sessionId);
      }
      this.waiters.delete(sessionId);
    }
  }
}

interface PostgresSessionRow {
  session_id: string;
  platform: Platform;
  status: OAuthStoredStatus;
  expires_at: Date;
  error: string | null;
}

function postgresStatus(row: { status: OAuthStoredStatus; expires_at: Date }): OAuthSessionStatus {
  const status: OAuthSessionStatus = row.status === "processing" ? "pending" : row.status;
  return row.expires_at.getTime() <= Date.now() && status === "pending" ? "expired" : status;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export class PostgresOAuthSessionStore implements OAuthSessionStore {
  async create(input: CreateOAuthSessionInput): Promise<void> {
    // Ensure migration 009 (which adds app_credential_fingerprint) has run before
    // writing the session. The runner is idempotent and memoized, so this adds a
    // single check on the first session after a deploy.
    await ensureDatabaseMigrations();
    await databasePool().query(
      `INSERT INTO public.oauth_authorization_sessions
         (session_id, state_hash, user_id, platform, redirect_uri, status, expires_at, app_credential_fingerprint)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)`,
      [
        input.sessionId,
        hashOAuthState(input.state),
        input.userId,
        input.platform,
        input.redirectUri,
        new Date(input.expiresAt),
        input.appCredentialFingerprint ?? null,
      ],
    );
  }

  async claim(state: string, expectedPlatforms: readonly Platform[]): Promise<OAuthClaimResult> {
    const stateHash = hashOAuthState(state);
    // A single conditional UPDATE is the atomic claim: only one caller can flip
    // `pending` to `processing`, and only for the expected callback platform.
    const { rows } = await databasePool().query<{
      session_id: string;
      user_id: string;
      platform: Platform;
      redirect_uri: string;
      expires_at: Date;
      app_credential_fingerprint: string | null;
    }>(
      `UPDATE public.oauth_authorization_sessions
          SET status = 'processing', claimed_at = NOW()
        WHERE state_hash = $1
          AND status = 'pending'
          AND expires_at > NOW()
          AND platform = ANY($2::text[])
        RETURNING session_id, user_id, platform, redirect_uri, expires_at, app_credential_fingerprint`,
      [stateHash, [...expectedPlatforms]],
    );
    const row = rows[0];
    if (row) {
      return {
        claimed: true,
        session: {
          sessionId: row.session_id,
          userId: row.user_id,
          platform: row.platform,
          redirectUri: row.redirect_uri,
          expiresAt: row.expires_at.getTime(),
          ...(row.app_credential_fingerprint ? { appCredentialFingerprint: row.app_credential_fingerprint } : {}),
        },
      };
    }

    // Nothing was claimed; determine why without mutating unrelated state.
    const { rows: probe } = await databasePool().query<{
      status: OAuthStoredStatus;
      expires_at: Date;
      platform: Platform;
    }>(
      `SELECT status, expires_at, platform
         FROM public.oauth_authorization_sessions
        WHERE state_hash = $1`,
      [stateHash],
    );
    const existing = probe[0];
    if (!existing) return { claimed: false, reason: "unknown" };
    if (!expectedPlatforms.includes(existing.platform)) return { claimed: false, reason: "wrong_platform" };
    if (existing.expires_at.getTime() <= Date.now()) {
      await databasePool().query(
        `UPDATE public.oauth_authorization_sessions
            SET status = 'expired', completed_at = NOW()
          WHERE state_hash = $1 AND status = 'pending'`,
        [stateHash],
      );
      return { claimed: false, reason: "expired" };
    }
    return { claimed: false, reason: "used" };
  }

  async getStatus(sessionId: string, userId: string): Promise<AuthorizationSessionStatus> {
    const { rows } = await databasePool().query<PostgresSessionRow>(
      `SELECT session_id, platform, status, expires_at, error
         FROM public.oauth_authorization_sessions
        WHERE session_id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    const row = rows[0];
    if (!row) throw new Error(sessionMissingMessage);
    return {
      sessionId: row.session_id,
      platform: row.platform,
      status: postgresStatus(row),
      expiresAt: row.expires_at.getTime(),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  async updateStatus(sessionId: string, status: OAuthSessionStatus, error?: string): Promise<void> {
    await databasePool().query(
      `UPDATE public.oauth_authorization_sessions
          SET status = $2,
              error = $3,
              completed_at = CASE WHEN $2 IN ('connected', 'cancelled', 'failed', 'expired')
                                  THEN NOW() ELSE completed_at END
        WHERE session_id = $1`,
      [sessionId, status, error ?? null],
    );
  }

  async waitForStatus(sessionId: string, userId: string, timeoutSeconds: number): Promise<AuthorizationSessionStatus> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      const status = await this.getStatus(sessionId, userId);
      if (status.status !== "pending" || timeoutSeconds === 0) return status;
      if (Date.now() >= deadline) return status;
      await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
    }
  }
}
