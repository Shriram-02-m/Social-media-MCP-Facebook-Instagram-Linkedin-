import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { accountConnectionState, connectionAction } from "@/lib/account-connection-state";

const readFile = (relative: string) => readFileSync(relative, "utf8");

const page = readFile("src/app/(dashboard)/accounts/page.tsx");
const panel = readFile("src/app/(dashboard)/accounts/accounts-panel.tsx");
const credentialsRoute = readFile("src/app/api/credentials/route.ts");
const platformsRoute = readFile("src/app/api/platforms/route.ts");
const appCredentials = readFile("../social-media-mcp/src/auth/app-credentials.ts");
const oauth = readFile("../social-media-mcp/src/auth/oauth.ts");
const linkedin = readFile("../social-media-mcp/src/platforms/linkedin.ts");
const migration = readFile("../social-media-mcp/migrations/009_user_app_credentials.sql");

describe("accountConnectionState", () => {
  it("treats a missing or disconnected status as disconnected", () => {
    expect(accountConnectionState(undefined)).toBe("disconnected");
    expect(accountConnectionState({ connected: false })).toBe("disconnected");
  });

  it("only reports connected for a live, unexpired authorization", () => {
    expect(accountConnectionState({ connected: true })).toBe("connected");
    expect(accountConnectionState({ connected: true, tokenExpired: false })).toBe(
      "connected",
    );
    expect(accountConnectionState({ connected: true, tokenExpired: true })).toBe(
      "expired",
    );
  });
});

describe("connectionAction (Connect vs Reconnect)", () => {
  it("shows Connect for users who never completed an OAuth consent", () => {
    expect(connectionAction("disconnected")).toBe("connect");
    expect(connectionAction("disconnected", false)).toBe("connect");
  });

  it("shows Connect when only developer app credentials are saved", () => {
    // Saved credentials must not imply a previous social account connection;
    // the panel passes the API's token-record flag, not credential state.
    expect(connectionAction("disconnected", false)).toBe("connect");
  });

  it("shows Reconnect when a previous connection exists but is no longer active", () => {
    expect(connectionAction("expired", true)).toBe("reconnect");
    expect(connectionAction("disconnected", true)).toBe("reconnect");
  });

  it("shows Reconnect for a currently connected platform as its management action", () => {
    expect(connectionAction("connected")).toBe("reconnect");
    expect(connectionAction("connected", true)).toBe("reconnect");
  });

  it("defaults to Connect when the API response carries no history flag", () => {
    expect(connectionAction("disconnected", undefined)).toBe("connect");
  });
});

describe("unified Accounts page", () => {
  it("renders one AccountsPanel and no duplicate developer settings section", () => {
    expect(page).toMatch(/<AccountsPanel \/>/);
    expect(page).not.toMatch(/DeveloperAppSettings/);
    expect(page.match(/<AccountsPanel \/>/g)).toHaveLength(1);
  });

  it("loads both live connection state and saved credential metadata", () => {
    expect(panel).toMatch(/fetch\("\/api\/platforms", \{ cache: "no-store" \}\)/);
    expect(panel).toMatch(/fetch\("\/api\/credentials", \{ cache: "no-store" \}\)/);
    expect(panel).toMatch(/accountConnectionState\(connection\)/);
  });

  it("keeps one card per provider with credentials and connection actions together", () => {
    for (const provider of ["facebook", "instagram", "linkedin"]) {
      expect(panel).toContain(`  ${provider}: {`);
    }
    expect(panel).toMatch(/PLATFORM_ORDER: PlatformId\[\] = \["facebook", "instagram", "linkedin"\]/);
    expect(panel).toContain("Save credentials");
    expect(panel).toContain("Update credentials");
    expect(panel).toContain("Connect");
    expect(panel).toContain("Reconnect");
    expect(panel).toContain("Credentials saved");
    expect(panel).toContain("type=\"password\"");
  });

  it("drives the card border from the connection state, never from saved credentials", () => {
    expect(panel).toMatch(/cardRingClass\(state\)/);
    expect(panel).toContain("ring-emerald-500/80");
    expect(panel).toContain("ring-destructive/70");
    expect(panel).toContain("bg-emerald-600 text-white");
  });

  it("never stores credentials in browser storage", () => {
    expect(panel).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it("never reads or renders a secret returned by the API", () => {
    const credentialInterface = panel.slice(
      panel.indexOf("interface CredentialStatus"),
      panel.indexOf("interface ProviderMeta"),
    );
    expect(credentialInterface).toContain("clientId?: string");
    expect(credentialInterface).not.toContain("clientSecret");
    expect(panel).not.toMatch(/credential\.clientSecret|credentialsBody\.clientSecret/);
    expect(panel).toMatch(/Leave blank to keep the saved secret/);
  });
});

describe("credential storage and isolation", () => {
  it("stores only an AES-256-GCM envelope bound to the owner and provider", () => {
    expect(migration).toMatch(/client_secret_ciphertext JSONB NOT NULL/);
    expect(migration).not.toMatch(/client_secret\s+TEXT/i);
    expect(appCredentials).toMatch(/createCipheriv\("aes-256-gcm"/);
    expect(appCredentials).toMatch(/setAAD\(appSecretAad\(userId, provider\)\)/);
    expect(appCredentials).toContain(
      "social-media-mcp:app-credential:${userId}:${provider}:v1",
    );
  });

  it("scopes reads, updates, and deletes to the authenticated user", () => {
    expect(appCredentials).toMatch(
      /WHERE user_id = \$1 AND provider = \$2/,
    );
    expect(appCredentials).toMatch(
      /SET client_id = \$3, updated_at = NOW\(\) WHERE user_id = \$1 AND provider = \$2/,
    );
    expect(appCredentials).toMatch(
      /DELETE FROM public\.oauth_app_credentials WHERE user_id = \$1 AND provider = \$2/,
    );
    expect(credentialsRoute).toMatch(/session\.user\.id/);
  });

  it("preserves the existing secret when an update omits it", () => {
    expect(appCredentials).toMatch(
      /if \(clientSecret\) \{/,
    );
    expect(appCredentials).toContain("A blank secret preserves the stored one");
    expect(credentialsRoute).toMatch(/clientSecret: z\.string\(\)\.optional\(\)/);
    expect(credentialsRoute).toMatch(/if \(!configured && !\(clientSecret \?\? ""\)\.trim\(\)\)/);
  });

  it("returns only safe status metadata from the credentials API", () => {
    const statusInterface = appCredentials.slice(
      appCredentials.indexOf("export interface AppCredentialStatus"),
      appCredentials.indexOf("export interface ResolvedAppCredentials"),
    );
    expect(statusInterface).toContain("clientId?: string");
    expect(statusInterface).not.toContain("clientSecret");
    expect(credentialsRoute).toMatch(/appCredentialStatuses\(session\.user\.id\)/);
    expect(credentialsRoute).not.toMatch(/decryptAppSecret|client_secret_ciphertext/);
  });

  it("does not delete social tokens when app credentials are removed", () => {
    expect(appCredentials).toContain(
      "Deleting credentials only removes the app configuration.",
    );
    expect(appCredentials).not.toMatch(
      /DELETE FROM public\.oauth_tokens|saveTokens\(/,
    );
  });
});

describe("connection history detection", () => {
  it("derives the Connect/Reconnect flag from stored token records only", () => {
    // The platforms route merges per-user token metadata, which exists only
    // after a completed OAuth consent; saved developer credentials are a
    // separate table and must never produce the history flag.
    expect(platformsRoute).toMatch(/loadTokenMetadata\(session\.user\.id\)/);
    expect(platformsRoute).toMatch(/previouslyConnected: true/);
    expect(platformsRoute).not.toMatch(/appCredentialStatuses|loadAppCredentials/);
  });

  it("labels the card action via the shared truth table", () => {
    expect(panel).toMatch(
      /connectionAction\(state, connection\.previouslyConnected\)/,
    );
    expect(panel).toMatch(/action === "reconnect" \?/);
  });
});

describe("automatic credential reuse", () => {
  it("resolves the acting user's app for authorization start and token exchange", () => {
    expect(oauth).toMatch(
      /resolveAppCredentials\(userId, platform, \{\s*includeSecret: config\.oauthCallbackMode !== "cloud"/,
    );
    expect(oauth).toMatch(/resolveAppCredentials\(userId, platform\)/);
    expect(oauth).toContain("appCredentialFingerprint: credentials.fingerprint");
    expect(oauth).toContain("assertAppCredentialFingerprint");
  });

  it("refreshes LinkedIn tokens with the same user's app", () => {
    expect(linkedin).toMatch(
      /\(userId\) => resolveAppCredentials\(userId, "linkedin"\)/,
    );
    expect(linkedin).toContain("Refresh must use the LinkedIn app that issued the refresh token");
  });

  it("enriches status responses with display metadata without exposing tokens", () => {
    expect(platformsRoute).toMatch(/loadTokenMetadata\(session\.user\.id\)/);
    expect(platformsRoute).toContain("accountName");
    expect(platformsRoute).toContain("expiresAt");
    expect(platformsRoute).not.toMatch(/accessToken|refreshToken|token_ciphertext/);
  });
});
