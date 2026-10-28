import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  InMemoryOAuthSessionStore,
  buildFrontendRedirectUrl,
  expectedPlatformsForCallbackPath,
  hashOAuthState,
  isOAuthCallbackPath,
  type CreateOAuthSessionInput,
} from "../src/auth/oauth-sessions.js";
import { processOAuthCallback } from "../src/auth/oauth.js";

function sessionInput(overrides: Partial<CreateOAuthSessionInput> = {}): CreateOAuthSessionInput {
  return {
    sessionId: "session-1",
    state: "state-1",
    userId: "user-1",
    platform: "linkedin",
    redirectUri: "https://social-media-cloud-worker.onrender.com/oauth/linkedin/callback",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("maps callback paths to their expected platforms", () => {
  assert.deepEqual(expectedPlatformsForCallbackPath("/oauth/meta/callback"), ["facebook", "instagram"]);
  assert.deepEqual(expectedPlatformsForCallbackPath("/oauth/linkedin/callback"), ["linkedin"]);
  assert.equal(expectedPlatformsForCallbackPath("/worker/run"), null);
  assert.equal(expectedPlatformsForCallbackPath("/health"), null);
  assert.equal(isOAuthCallbackPath("/oauth/meta/callback?state=abc"), true);
  assert.equal(isOAuthCallbackPath("/oauth/linkedin/callback"), true);
  assert.equal(isOAuthCallbackPath("/health"), false);
  assert.equal(isOAuthCallbackPath(undefined), false);
});

test("builds a fixed allowlisted frontend redirect and refuses unsafe bases", () => {
  assert.equal(
    buildFrontendRedirectUrl("https://app.example.com/", "connected", "linkedin"),
    "https://app.example.com/accounts?oauth=connected&platform=linkedin",
  );
  assert.equal(
    buildFrontendRedirectUrl("https://app.example.com", "failed"),
    "https://app.example.com/accounts?oauth=failed",
  );
  assert.equal(buildFrontendRedirectUrl("", "failed"), null);
  assert.equal(buildFrontendRedirectUrl("   ", "failed"), null);
  assert.equal(buildFrontendRedirectUrl("javascript:alert(1)", "failed"), null);
  assert.equal(buildFrontendRedirectUrl("ftp://example.com", "failed"), null);
  assert.equal(buildFrontendRedirectUrl("https://user:pass@example.com", "failed"), null);
  // A path or host supplied elsewhere can never move the redirect off /accounts.
  const injected = buildFrontendRedirectUrl("https://app.example.com/accounts", "failed", "facebook");
  assert.equal(injected, "https://app.example.com/accounts?oauth=failed&platform=facebook");
});

test("hashes OAuth state deterministically without keeping the raw value", () => {
  const hash = hashOAuthState("super-secret-state");
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashOAuthState("super-secret-state"));
  assert.notEqual(hash, hashOAuthState("super-secret-state-2"));
});

test("in-memory store claims a state exactly once", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "once", state: "once-state", userId: "u1" }));

  const first = await store.claim("once-state", ["linkedin"]);
  assert.equal(first.claimed, true);
  if (first.claimed) assert.equal(first.session.redirectUri, "https://social-media-cloud-worker.onrender.com/oauth/linkedin/callback");

  const second = await store.claim("once-state", ["linkedin"]);
  assert.equal(second.claimed, false);
  if (!second.claimed) assert.equal(second.reason, "used");
});

test("in-memory store rejects expired states", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "expired", state: "expired-state", expiresAt: Date.now() - 1 }));

  const result = await store.claim("expired-state", ["linkedin"]);
  assert.equal(result.claimed, false);
  if (!result.claimed) assert.equal(result.reason, "expired");

  const status = await store.getStatus("expired", "user-1");
  assert.equal(status.status, "expired");
});

test("in-memory store rejects wrong-platform states without consuming them", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({
    sessionId: "fb",
    state: "fb-state",
    userId: "u2",
    platform: "facebook",
    redirectUri: "https://social-media-cloud-worker.onrender.com/oauth/meta/callback",
  }));

  const wrong = await store.claim("fb-state", ["linkedin"]);
  assert.equal(wrong.claimed, false);
  if (!wrong.claimed) assert.equal(wrong.reason, "wrong_platform");

  const right = await store.claim("fb-state", ["facebook", "instagram"]);
  assert.equal(right.claimed, true);
  if (right.claimed) assert.equal(right.session.platform, "facebook");
});

test("in-memory store isolates authorization sessions by authenticated user", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "iso", state: "iso-state", userId: "alice" }));

  await assert.rejects(() => store.getStatus("iso", "bob"), /not found or expired/i);
  await assert.rejects(() => store.waitForStatus("iso", "bob", 0), /not found or expired/i);

  const status = await store.getStatus("iso", "alice");
  assert.equal(status.status, "pending");
});

test("in-memory store wakes waiters when the callback completes", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "wait", state: "wait-state", userId: "carol" }));

  const waiting = store.waitForStatus("wait", "carol", 5);
  await store.updateStatus("wait", "connected");
  const resolved = await waiting;
  assert.equal(resolved.status, "connected");
});

test("callback marks a provider cancellation without attempting an exchange", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "cancel", state: "cancel-state", userId: "dave" }));
  let finishCalled = false;

  const outcome = await processOAuthCallback(
    new URLSearchParams({ state: "cancel-state", error: "access_denied" }),
    ["linkedin"],
    { store, finish: async () => { finishCalled = true; } },
  );

  assert.equal(outcome.result, "cancelled");
  assert.equal(finishCalled, false);
  assert.equal((await store.getStatus("cancel", "dave")).status, "cancelled");
});

test("callback fails safely when the authorization code is missing", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "nocode", state: "nocode-state", userId: "erin" }));

  const outcome = await processOAuthCallback(
    new URLSearchParams({ state: "nocode-state" }),
    ["linkedin"],
    { store, finish: async () => { throw new Error("should not run"); } },
  );

  assert.equal(outcome.result, "failed");
  assert.equal((await store.getStatus("nocode", "erin")).status, "failed");
});

test("callback records a failed exchange without leaking secrets or codes", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "fail", state: "fail-state", userId: "frank" }));

  const outcome = await processOAuthCallback(
    new URLSearchParams({ state: "fail-state", code: "auth-code-123" }),
    ["linkedin"],
    {
      store,
      finish: async () => {
        throw new Error("client_secret=super-secret&access_token=abc123 failed for authorization_code=auth-code-123");
      },
    },
  );

  assert.equal(outcome.result, "failed");
  const status = await store.getStatus("fail", "frank");
  assert.equal(status.status, "failed");
  const recorded = status.error ?? "";
  assert.match(recorded, /\[redacted\]/);
  assert.doesNotMatch(recorded, /super-secret/);
  assert.doesNotMatch(recorded, /abc123/);
  assert.doesNotMatch(recorded, /auth-code-123/);
});

test("callback rejects an unknown state and a reused state", async () => {
  const store = new InMemoryOAuthSessionStore();
  const unknown = await processOAuthCallback(new URLSearchParams({ state: "nope" }), ["linkedin"], {
    store,
    finish: async () => undefined,
  });
  assert.equal(unknown.result, "failed");

  await store.create(sessionInput({ sessionId: "reuse", state: "reuse-state", userId: "gina" }));
  const first = await processOAuthCallback(new URLSearchParams({ state: "reuse-state", code: "c1" }), ["linkedin"], {
    store,
    finish: async () => undefined,
  });
  assert.equal(first.result, "connected");
  const second = await processOAuthCallback(new URLSearchParams({ state: "reuse-state", code: "c2" }), ["linkedin"], {
    store,
    finish: async () => undefined,
  });
  assert.equal(second.result, "failed");
});

test("migration 008 creates an idempotent, RLS-protected OAuth session table", async () => {
  const sql = await readFile(new URL("../migrations/008_oauth_sessions.sql", import.meta.url), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.oauth_authorization_sessions/i);
  assert.match(sql, /state_hash TEXT NOT NULL UNIQUE/i);
  assert.match(sql, /status TEXT NOT NULL DEFAULT 'pending'/i);
  assert.match(sql, /CHECK \(status IN \('pending', 'processing', 'connected', 'cancelled', 'failed', 'expired'\)\)/i);
  assert.match(sql, /expires_at TIMESTAMPTZ NOT NULL/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.oauth_authorization_sessions/i);
  assert.match(sql, /GRANT ALL ON TABLE public\.oauth_authorization_sessions TO service_role/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS oauth_authorization_sessions_user_idx/i);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b/i);
});

test("callback forwards the credential fingerprint recorded at authorization start", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({
    sessionId: "fp",
    state: "fp-state",
    userId: "henry",
    appCredentialFingerprint: "fingerprint-abc",
  }));
  let received: string | undefined = "sentinel";

  const outcome = await processOAuthCallback(
    new URLSearchParams({ state: "fp-state", code: "code-1" }),
    ["linkedin"],
    {
      store,
      finish: async (_platform, _userId, _code, _redirectUri, fingerprint) => {
        received = fingerprint;
      },
    },
  );

  assert.equal(outcome.result, "connected");
  assert.equal(received, "fingerprint-abc");
});

test("callback passes no fingerprint for a legacy session without one", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(sessionInput({ sessionId: "legacy", state: "legacy-state", userId: "iris" }));
  let received: string | undefined = "sentinel";

  const outcome = await processOAuthCallback(
    new URLSearchParams({ state: "legacy-state", code: "code-2" }),
    ["linkedin"],
    {
      store,
      finish: async (_platform, _userId, _code, _redirectUri, fingerprint) => {
        received = fingerprint;
      },
    },
  );

  assert.equal(outcome.result, "connected");
  assert.equal(received, undefined);
});

test("migration 009 adds user-owned app credentials and pins the session fingerprint", async () => {
  const sql = await readFile(new URL("../migrations/009_user_app_credentials.sql", import.meta.url), "utf8");

  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.oauth_app_credentials/i);
  assert.match(sql, /provider TEXT NOT NULL CHECK \(provider IN \('instagram', 'facebook', 'linkedin'\)\)/i);
  assert.match(sql, /client_id TEXT NOT NULL/i);
  assert.match(sql, /client_secret_ciphertext JSONB NOT NULL/i);
  assert.match(sql, /PRIMARY KEY \(user_id, provider\)/i);
  assert.match(sql, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(sql, /updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.oauth_app_credentials/i);
  assert.match(sql, /GRANT ALL ON TABLE public\.oauth_app_credentials TO service_role/i);
  assert.match(sql, /ALTER TABLE public\.oauth_authorization_sessions[\s\S]*ADD COLUMN IF NOT EXISTS app_credential_fingerprint TEXT/i);
  // Additive only: existing tokens, posts, and sessions are never removed.
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b|\bDROP\s+COLUMN\b/i);
});

test("worker registers the public OAuth callback routes without changing worker auth", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /isOAuthCallbackPath\(request\.url\)/);
  assert.match(worker, /handleOAuthCallback\(request, response\)/);
  assert.match(worker, /request\.url !== "\/worker\/run"/);
  assert.match(worker, /timingSafeEqual/);
  assert.match(worker, /request\.url === "\/health"/);
});
