// Focused LinkedIn OAuth authorization-URL tests. The real `beginAuthorization`
// is executed in a child process with a deterministic cloud-mode-shaped
// environment (matching the production Render worker values) because local
// callback mode binds the local OAuth/media listener port. No network requests
// are made: the consent URL is only parsed and asserted against. No production
// data is touched; the child uses an in-memory session store.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { execPathSpawnTsx } from "./helpers/tsx-spawn.js";
import { config } from "../src/config/env.js";
import { InMemoryOAuthSessionStore, expectedPlatformsForCallbackPath } from "../src/auth/oauth-sessions.js";
import { oauthCallbackUrl, processOAuthCallback, type OAuthCallbackOutcome } from "../src/auth/oauth.js";
import type { CreateOAuthSessionInput } from "../src/auth/oauth-sessions.js";

const PRODUCTION_REDIRECT_BASE = "https://social-media-cloud-worker.onrender.com";
const LINKEDIN_CALLBACK_URI = `${PRODUCTION_REDIRECT_BASE}/oauth/linkedin/callback`;

function linkedinSession(overrides: Partial<CreateOAuthSessionInput> = {}): CreateOAuthSessionInput {
  return {
    sessionId: "linkedin-session",
    state: "linkedin-state",
    userId: "linkedin-user",
    platform: "linkedin",
    redirectUri: LINKEDIN_CALLBACK_URI,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("OAuth callback URLs keep the platform paths used by the registered provider apps", () => {
  // Facebook and Instagram share the Meta callback route registered in the
  // Meta dashboard; LinkedIn has its own exact route in the LinkedIn portal.
  assert.equal(oauthCallbackUrl("facebook"), `${config.redirectBaseUrl}/oauth/meta/callback`);
  assert.equal(oauthCallbackUrl("instagram"), `${config.redirectBaseUrl}/oauth/meta/callback`);
  assert.equal(oauthCallbackUrl("linkedin"), `${config.redirectBaseUrl}/oauth/linkedin/callback`);
  // No path component may ever move the callback off the registered host: after
  // the scheme the value must be exactly `//host` with no path or trailing slash.
  const parsedBase = new URL(config.redirectBaseUrl);
  assert.equal(parsedBase.pathname, "/");
  assert.equal(parsedBase.search, "");
  assert.equal(parsedBase.hash, "");
});

test("LinkedIn sessions can only be claimed from the LinkedIn callback path, and Meta callbacks cannot claim them", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(linkedinSession({ sessionId: "li-iso", state: "li-iso-state" }));

  // A Meta-path callback (facebook/instagram) must never consume the LinkedIn state.
  const metaClaim = await store.claim("li-iso-state", ["facebook", "instagram"]);
  assert.equal(metaClaim.claimed, false);
  if (!metaClaim.claimed) assert.equal(metaClaim.reason, "wrong_platform");

  // The LinkedIn path claims it and reveals the persisted redirect URI for exchange.
  const linkedinClaim = await store.claim("li-iso-state", expectedPlatformsForCallbackPath("/oauth/linkedin/callback")!);
  assert.equal(linkedinClaim.claimed, true);
  if (linkedinClaim.claimed) {
    assert.equal(linkedinClaim.session.platform, "linkedin");
    assert.equal(linkedinClaim.session.redirectUri, LINKEDIN_CALLBACK_URI);
  }
});

test("the token exchange step receives the exact persisted callback URI", async () => {
  const store = new InMemoryOAuthSessionStore();
  await store.create(linkedinSession({ sessionId: "li-exchange", state: "li-exchange-state" }));

  const finishCalls: Array<{ platform: string; userId: string; code: string; redirectUri: string }> = [];
  const outcome: OAuthCallbackOutcome = await processOAuthCallback(
    new URLSearchParams({ state: "li-exchange-state", code: "auth-code" }),
    expectedPlatformsForCallbackPath("/oauth/linkedin/callback")!,
    {
      store,
      finish: async (platform, userId, code, redirectUri) => {
        finishCalls.push({ platform, userId, code, redirectUri });
      },
    },
  );

  assert.equal(outcome.result, "connected");
  assert.equal(finishCalls.length, 1);
  // Byte-identical to what the consent screen was handed, otherwise LinkedIn
  // rejects the exchange with a redirect_uri mismatch.
  assert.equal(finishCalls[0]?.redirectUri, LINKEDIN_CALLBACK_URI);
  assert.equal(finishCalls[0]?.platform, "linkedin");
  assert.equal((await store.getStatus("li-exchange", "linkedin-user")).status, "connected");
});

test("LinkedIn callback rejects invalid and reused states", async () => {
  const store = new InMemoryOAuthSessionStore();

  const unknown = await processOAuthCallback(new URLSearchParams({ state: "bogus", code: "c" }), ["linkedin"], {
    store,
    finish: async () => undefined,
  });
  assert.equal(unknown.result, "failed");

  await store.create(linkedinSession({ sessionId: "li-reuse", state: "li-reuse-state" }));
  const first = await processOAuthCallback(new URLSearchParams({ state: "li-reuse-state", code: "c1" }), ["linkedin"], {
    store,
    finish: async () => undefined,
  });
  assert.equal(first.result, "connected");

  const second = await processOAuthCallback(new URLSearchParams({ state: "li-reuse-state", code: "c2" }), ["linkedin"], {
    store,
    finish: async () => undefined,
  });
  assert.equal(second.result, "failed");
});

test("beginAuthorization('linkedin') emits the production consent URL with the registered callback URI", async () => {
  const childScript = new URL("./fixtures/linkedin-consent-child.mjs", import.meta.url);
  const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const { stdout, stderr, status } = await execPathSpawnTsx([tsxCli, fileURLToPath(childScript)], {
      // Force the local backend so a developer's real `.env` cannot change the
      // outcome. Local MCP mode always builds the consent URL from the shared
      // environment app, which is exactly what this test asserts.
      TOKEN_STORE_BACKEND: "local",
      SCHEDULED_IMAGE_STORAGE: "local",
      SCHEDULER_MODE: "disabled",
      OAUTH_CALLBACK_PORT: "34117",
      OAUTH_CALLBACK_MODE: "local",
      OAUTH_REDIRECT_BASE_URL: PRODUCTION_REDIRECT_BASE,
      LINKEDIN_CLIENT_ID: "test-client-id",
      LINKEDIN_SCOPES: "openid profile w_member_social",
    },
  );

  const payload =
    stdout.length > 0
      ? (JSON.parse(stdout) as { authorizationUrl: string; sessionId: string; error?: string })
      : { authorizationUrl: "", error: `child exited ${status}: ${stderr || "(no stderr)"}` };
  assert.ok(payload.authorizationUrl, payload.error);

  const url = new URL(payload.authorizationUrl);
  assert.equal(url.host, "www.linkedin.com");
  assert.equal(url.pathname, "/oauth/v2/authorization");
  // Exactly the URI that must be registered in the LinkedIn Developer Portal.
  assert.equal(url.searchParams.get("redirect_uri"), LINKEDIN_CALLBACK_URI);
  // The raw encoded form must be percent-encoded without double encoding.
  assert.match(
    url.search,
    /redirect_uri=https%3A%2F%2Fsocial-media-cloud-worker\.onrender\.com%2Foauth%2Flinkedin%2Fcallback/,
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "test-client-id");
  assert.match(url.searchParams.get("state") ?? "", /^[0-9a-f]{64}$/);
  assert.equal(url.searchParams.get("scope"), "openid profile w_member_social");
});
