import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "social-media-mcp-token-test-"));
process.env["SOCIAL_MCP_TOKEN_FILE"] = join(directory, "tokens.enc");
process.env["SOCIAL_MCP_TOKEN_ENCRYPTION_KEY"] = "a".repeat(64);
process.env["TOKEN_STORE_BACKEND"] = "local";
process.env["LINKEDIN_CLIENT_ID"] = "test-client";
process.env["LINKEDIN_CLIENT_SECRET"] = "test-client-secret";
const tokenStore = await import("../src/auth/token-store.js");
const { linkedinTokenForUse } = await import("../src/platforms/linkedin.js");

test.after(async () => rm(directory, { recursive: true, force: true }));

const OWNER = "test-owner";

test("LinkedIn refresh token renews and persists an expiring token without changing the local vault format", async () => {
  await tokenStore.saveTokens(OWNER, {
    linkedin: {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() - 1,
      scopes: ["w_member_social"],
      connectedAt: Date.now() - 10_000,
      accountId: "member-id",
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://www.linkedin.com/oauth/v2/accessToken");
    assert.equal(init?.method, "POST");
    assert.match(String(init?.body), /grant_type=refresh_token/);
    assert.match(String(init?.body), /refresh_token=old-refresh-token/);
    return Response.json({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
    });
  };
  try {
    const refreshed = await linkedinTokenForUse(OWNER);
    assert.equal(refreshed.accessToken, "new-access-token");
    assert.equal(refreshed.refreshToken, "new-refresh-token");
    assert.ok(refreshed.expiresAt && refreshed.expiresAt > Date.now());
    assert.equal((await tokenStore.loadTokens(OWNER)).linkedin?.accessToken, "new-access-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("expired LinkedIn tokens without a provider refresh token require reauthorization", async () => {
  await tokenStore.saveTokens(OWNER, {
    linkedin: {
      accessToken: "expired-access-token",
      expiresAt: Date.now() - 1,
      scopes: ["w_member_social"],
      connectedAt: Date.now() - 10_000,
    },
  });
  await assert.rejects(linkedinTokenForUse(OWNER), /has no refresh token\. Reauthorize LinkedIn/);
});
