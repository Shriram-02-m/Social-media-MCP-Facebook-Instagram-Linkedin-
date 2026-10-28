// Encryption key validation runs in its own process because the config is read
// once at import time.
import assert from "node:assert/strict";
import test from "node:test";

process.env["TOKEN_STORE_BACKEND"] = "local";
delete process.env["DATABASE_URL"];
process.env["APP_CREDENTIAL_ENCRYPTION_KEY"] = "too-short";

const { encryptAppSecret, decryptAppSecret } = await import("../src/auth/app-credentials.js");

test("a missing or malformed encryption key fails safely on use", () => {
  assert.throws(
    () => encryptAppSecret("user-1", "linkedin", "value"),
    /Set APP_CREDENTIAL_ENCRYPTION_KEY to a randomly generated 64-character hex key/,
  );

  const envelope = { version: 1 as const, iv: "00", tag: "00", ciphertext: "00" };
  assert.throws(
    () => decryptAppSecret("user-1", "linkedin", envelope),
    /Set APP_CREDENTIAL_ENCRYPTION_KEY to a randomly generated 64-character hex key/,
  );
});
