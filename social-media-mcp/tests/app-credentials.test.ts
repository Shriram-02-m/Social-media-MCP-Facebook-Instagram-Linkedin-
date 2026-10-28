// User-owned Developer App credential tests that run in local MCP mode. The
// module is imported in a dedicated process (node:test isolates each file), so
// the shared-env fallback path can be asserted without a database.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env["TOKEN_STORE_BACKEND"] = "local";
delete process.env["DATABASE_URL"];
process.env["APP_CREDENTIAL_ENCRYPTION_KEY"] = "b".repeat(64);
process.env["LINKEDIN_CLIENT_ID"] = "shared-linkedin-id";
process.env["LINKEDIN_CLIENT_SECRET"] = "shared-linkedin-secret";
process.env["META_APP_ID"] = "shared-meta-id";
process.env["META_APP_SECRET"] = "shared-meta-secret";
process.env["INSTAGRAM_APP_ID"] = "shared-instagram-id";
process.env["INSTAGRAM_APP_SECRET"] = "shared-instagram-secret";

const {
  appCredentialFingerprint,
  appCredentialProviders,
  assertAppCredentialFingerprint,
  decryptAppSecret,
  encryptAppSecret,
  isAppCredentialProvider,
  resolveAppCredentials,
  resolveSharedAppCredentials,
  userAppCredentialsActive,
  validateAppCredentialInput,
} = await import("../src/auth/app-credentials.js");

test("exposes exactly the three per-provider developer app slots", () => {
  assert.deepEqual([...appCredentialProviders], ["facebook", "instagram", "linkedin"]);
  assert.equal(isAppCredentialProvider("linkedin"), true);
  assert.equal(isAppCredentialProvider("twitter"), false);
  assert.equal(isAppCredentialProvider(42), false);
});

test("local MCP mode never activates user-owned credentials", async () => {
  assert.equal(userAppCredentialsActive(), false);
  // Even with a user id, a local install resolves the shared environment app.
  const resolved = await resolveAppCredentials("some-user", "linkedin");
  assert.equal(resolved.source, "shared");
  assert.equal(resolved.clientId, "shared-linkedin-id");
  assert.equal(resolved.clientSecret, "shared-linkedin-secret");
});

test("shared credentials are resolved per provider and can omit the secret", () => {
  assert.equal(resolveSharedAppCredentials("facebook").clientId, "shared-meta-id");
  assert.equal(resolveSharedAppCredentials("instagram").clientId, "shared-instagram-id");
  assert.equal(resolveSharedAppCredentials("linkedin").clientId, "shared-linkedin-id");
  // A cloud request that only builds a consent URL must not decrypt a secret.
  assert.equal(resolveSharedAppCredentials("linkedin", false).clientSecret, undefined);
});

test("AES-256-GCM round-trips an app secret and binds it to the user and provider", () => {
  const envelope = encryptAppSecret("user-1", "linkedin", "s3cr3t-value");
  assert.equal(decryptAppSecret("user-1", "linkedin", envelope), "s3cr3t-value");

  // AAD must reject a record replayed as another user's or provider's secret.
  assert.throws(() => decryptAppSecret("user-2", "linkedin", envelope), /Could not decrypt/);
  assert.throws(() => decryptAppSecret("user-1", "facebook", envelope), /Could not decrypt/);
});

test("decryption fails safely for an unsupported record version", () => {
  const envelope = encryptAppSecret("user-1", "instagram", "value");
  assert.throws(
    () => decryptAppSecret("user-1", "instagram", { ...envelope, version: 2 as unknown as 1 }),
    /Unsupported developer app credential record version/,
  );
});

test("each save produces an independent ciphertext", () => {
  const first = encryptAppSecret("user-1", "facebook", "same-secret");
  const second = encryptAppSecret("user-1", "facebook", "same-secret");
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.notEqual(first.iv, second.iv);
});

test("credential fingerprints change with the app or its version", () => {
  const base = appCredentialFingerprint("user", "linkedin", "client-a", "v1");
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(base, appCredentialFingerprint("user", "linkedin", "client-a", "v1"));
  assert.notEqual(base, appCredentialFingerprint("shared", "linkedin", "client-a", "v1"));
  assert.notEqual(base, appCredentialFingerprint("user", "facebook", "client-a", "v1"));
  assert.notEqual(base, appCredentialFingerprint("user", "linkedin", "client-b", "v1"));
  assert.notEqual(base, appCredentialFingerprint("user", "linkedin", "client-a", "v2"));
});

test("fingerprint assertion blocks a mid-flow credential change but tolerates legacy sessions", () => {
  const current = appCredentialFingerprint("user", "linkedin", "client-a", "v1");
  assert.doesNotThrow(() => assertAppCredentialFingerprint(current, current));
  assert.doesNotThrow(() => assertAppCredentialFingerprint(undefined, current));
  assert.throws(
    () => assertAppCredentialFingerprint(appCredentialFingerprint("user", "linkedin", "client-a", "v0"), current),
    /changed while this authorization was in progress/,
  );
});

test("validates provider, client id, and secret for save operations", () => {
  assert.equal(validateAppCredentialInput("linkedin", "abc-123_X.Y", "s", false), null);
  assert.match(validateAppCredentialInput("twitter", "abc", "s", false) ?? "", /Unknown provider/);
  assert.match(validateAppCredentialInput("facebook", "", "s", false) ?? "", /Enter the app\/client ID/);
  assert.match(validateAppCredentialInput("facebook", "has space", "s", false) ?? "", /may only contain/);
  assert.match(validateAppCredentialInput("facebook", "id", "", true) ?? "", /Enter the app\/client secret/);
  assert.match(validateAppCredentialInput("facebook", "id", "has space", false) ?? "", /invalid characters/);
  // A blank secret is allowed when it is not required (update preserving the stored secret).
  assert.equal(validateAppCredentialInput("facebook", "id", "", false), null);
});

test("credential storage is user-scoped, parameterized, and never stores a plaintext secret", async () => {
  const source = await readFile(new URL("../src/auth/app-credentials.ts", import.meta.url), "utf8");

  // Reads, updates, and deletes are all scoped by the owning user and provider so
  // one user can never read or modify another user's credential.
  assert.match(source, /WHERE user_id = \$1 AND provider = \$2/);
  assert.match(source, /ON CONFLICT \(user_id, provider\) DO UPDATE/);
  assert.match(source, /INSERT INTO public\.oauth_app_credentials[\s\S]*client_secret_ciphertext/);
  // Only the ciphertext column exists; no plaintext secret column is ever written.
  assert.doesNotMatch(source, /client_secret\s+TEXT/i);
  assert.match(source, /createCipheriv\("aes-256-gcm"/);
});

test("OAuth begin records the credential fingerprint and the callback verifies it", async () => {
  const oauth = await readFile(new URL("../src/auth/oauth.ts", import.meta.url), "utf8");
  const sessions = await readFile(new URL("../src/auth/oauth-sessions.ts", import.meta.url), "utf8");

  assert.match(oauth, /appCredentialFingerprint: credentials\.fingerprint/);
  assert.match(oauth, /assertAppCredentialFingerprint\(appCredentialFingerprint, credentials\.fingerprint\)/);
  assert.match(sessions, /app_credential_fingerprint/);
});
