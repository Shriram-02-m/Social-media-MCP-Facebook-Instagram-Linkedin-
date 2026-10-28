import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config/env.js";
import { databasePool } from "../database.js";
import { ensureDatabaseMigrations } from "../database-migrations.js";
import type { Platform } from "../platforms/types.js";

// User-owned Developer App credentials. Facebook, Instagram and LinkedIn each
// issue their own app/client id and secret, so a user configures one record per
// provider. Secrets are encrypted at rest; the client id is public (it appears in
// the provider consent URL) but is only exposed for the user's own record.
export const appCredentialProviders: readonly Platform[] = ["facebook", "instagram", "linkedin"];

export interface AppCredentialStatus {
  provider: Platform;
  // True when the user stored their own app credentials; false when the shared
  // environment credentials are used as a fallback.
  configured: boolean;
  source: "user" | "shared";
  clientId?: string;
  updatedAt?: string;
}

export interface ResolvedAppCredentials {
  provider: Platform;
  source: "user" | "shared";
  clientId: string;
  // Only present when the caller asked for the secret. Local (stdio) callers and
  // request paths that only build an authorization URL never decrypt it.
  clientSecret?: string;
  // Opaque, non-reversible identifier of the exact credential version. It is
  // stored with the authorization session so a mid-flow edit cannot silently
  // swap the app that finishes the exchange.
  fingerprint: string;
}

export interface SaveAppCredentialsInput {
  clientId: string;
  // When omitted or blank on an update, the existing secret is preserved.
  clientSecret?: string | null;
}

interface EncryptedAppSecret {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

interface AppCredentialRow {
  provider: Platform;
  client_id: string;
  client_secret_ciphertext: EncryptedAppSecret;
  updated_at: Date;
}

// User-owned credentials live in the shared cloud database, next to the OAuth
// tokens. A local (stdio) MCP install uses TOKEN_STORE_BACKEND=local and keeps
// resolving the shared environment credentials, so nothing changes for it.
export function userAppCredentialsActive(): boolean {
  return config.tokenStoreBackend === "supabase";
}

function encryptionKey(): Buffer {
  const value = config.appCredentialEncryptionKey;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Set APP_CREDENTIAL_ENCRYPTION_KEY to a randomly generated 64-character hex key (see .env.example).");
  }
  return Buffer.from(value, "hex");
}

function appSecretAad(userId: string, provider: Platform): Buffer {
  // Bind the ciphertext to the owning user and provider so a record can never be
  // replayed as another user's or another provider's secret.
  return Buffer.from(`social-media-mcp:app-credential:${userId}:${provider}:v1`, "utf8");
}

export function encryptAppSecret(userId: string, provider: Platform, clientSecret: string): EncryptedAppSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(appSecretAad(userId, provider));
  const ciphertext = Buffer.concat([cipher.update(clientSecret, "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

export function decryptAppSecret(userId: string, provider: Platform, envelope: EncryptedAppSecret): string {
  if (!envelope || envelope.version !== 1) {
    throw new Error("Unsupported developer app credential record version.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(envelope.iv, "hex"));
  decipher.setAAD(appSecretAad(userId, provider));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never surface the ciphertext or the key. A failed tag check means the
    // record was tampered with or the key changed; fail instead of guessing.
    throw new Error("Could not decrypt the stored developer app secret. Check APP_CREDENTIAL_ENCRYPTION_KEY or re-save the credentials.");
  }
}

export function appCredentialFingerprint(
  source: "user" | "shared",
  provider: Platform,
  clientId: string,
  version: string,
): string {
  // Hashes only non-secret inputs, so it cannot be brute-forced into the secret.
  return createHash("sha256").update(`${source}:${provider}:${clientId}:${version}`, "utf8").digest("hex");
}

// Fails when the credential version stored at authorization start no longer
// matches the configured one, so an in-flight flow never exchanges a code with a
// different app. A missing expected value (legacy session) is tolerated.
export function assertAppCredentialFingerprint(expected: string | undefined, current: string): void {
  if (expected && expected !== current) {
    throw new Error("The developer app credentials changed while this authorization was in progress. Start the connection again from the Accounts page.");
  }
}

function sharedClientCredentials(provider: Platform): { clientId: string; clientSecret: string } {
  if (provider === "linkedin") {
    return { clientId: config.linkedinClientId, clientSecret: config.linkedinClientSecret };
  }
  if (provider === "instagram") {
    return { clientId: config.instagramAppId, clientSecret: config.instagramAppSecret };
  }
  return { clientId: config.metaAppId, clientSecret: config.metaAppSecret };
}

export function resolveSharedAppCredentials(
  provider: Platform,
  includeSecret = true,
): ResolvedAppCredentials {
  const { clientId, clientSecret } = sharedClientCredentials(provider);
  return {
    provider,
    source: "shared",
    clientId,
    ...(includeSecret ? { clientSecret } : {}),
    fingerprint: appCredentialFingerprint("shared", provider, clientId, "shared"),
  };
}

async function readAppCredential(userId: string, provider: Platform): Promise<AppCredentialRow | undefined> {
  // The table is created by migration 009. Ensure it exists before the first read
  // (the runner is idempotent and memoized per process).
  await ensureDatabaseMigrations();
  const { rows } = await databasePool().query<AppCredentialRow>(
    `SELECT provider, client_id, client_secret_ciphertext, updated_at
       FROM public.oauth_app_credentials
      WHERE user_id = $1 AND provider = $2`,
    [userId, provider],
  );
  return rows[0];
}

export async function resolveAppCredentials(
  userId: string,
  provider: Platform,
  options: { includeSecret?: boolean } = {},
): Promise<ResolvedAppCredentials> {
  const includeSecret = options.includeSecret ?? true;
  if (!userAppCredentialsActive()) return resolveSharedAppCredentials(provider, includeSecret);
  const row = await readAppCredential(userId, provider);
  if (!row) return resolveSharedAppCredentials(provider, includeSecret);
  return {
    provider,
    source: "user",
    clientId: row.client_id,
    ...(includeSecret ? { clientSecret: decryptAppSecret(userId, provider, row.client_secret_ciphertext) } : {}),
    fingerprint: appCredentialFingerprint("user", provider, row.client_id, row.updated_at.toISOString()),
  };
}

export async function appCredentialStatuses(userId: string): Promise<AppCredentialStatus[]> {
  if (!userAppCredentialsActive()) {
    return appCredentialProviders.map((provider) => ({ provider, configured: false, source: "shared" as const }));
  }
  await ensureDatabaseMigrations();
  const { rows } = await databasePool().query<{ provider: Platform; client_id: string; updated_at: Date }>(
    "SELECT provider, client_id, updated_at FROM public.oauth_app_credentials WHERE user_id = $1",
    [userId],
  );
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return appCredentialProviders.map((provider) => {
    const row = byProvider.get(provider);
    if (row) {
      return {
        provider,
        configured: true,
        source: "user" as const,
        clientId: row.client_id,
        updatedAt: row.updated_at.toISOString(),
      };
    }
    return { provider, configured: false, source: "shared" as const };
  });
}

export async function saveAppCredentials(
  userId: string,
  provider: Platform,
  input: SaveAppCredentialsInput,
): Promise<void> {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret?.trim() ?? "";
  if (!clientId) throw new Error("Enter the app/client ID.");
  await ensureDatabaseMigrations();
  if (clientSecret) {
    const envelope = encryptAppSecret(userId, provider, clientSecret);
    await databasePool().query(
      `INSERT INTO public.oauth_app_credentials
         (user_id, provider, client_id, client_secret_ciphertext, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())
       ON CONFLICT (user_id, provider) DO UPDATE
         SET client_id = EXCLUDED.client_id,
             client_secret_ciphertext = EXCLUDED.client_secret_ciphertext,
             updated_at = NOW()`,
      [userId, provider, clientId, JSON.stringify(envelope)],
    );
    return;
  }
  // A blank secret preserves the stored one. Only an update can omit it; a new
  // credential must always include the secret.
  const { rowCount } = await databasePool().query(
    "UPDATE public.oauth_app_credentials SET client_id = $3, updated_at = NOW() WHERE user_id = $1 AND provider = $2",
    [userId, provider, clientId],
  );
  if (rowCount !== 1) throw new Error("Enter the app/client secret to save this credential.");
}

export async function deleteAppCredentials(userId: string, provider: Platform): Promise<boolean> {
  // Deleting credentials only removes the app configuration. Stored social
  // tokens and scheduled posts are intentionally untouched.
  await ensureDatabaseMigrations();
  const { rowCount } = await databasePool().query(
    "DELETE FROM public.oauth_app_credentials WHERE user_id = $1 AND provider = $2",
    [userId, provider],
  );
  return (rowCount ?? 0) > 0;
}

export function isAppCredentialProvider(value: unknown): value is Platform {
  return typeof value === "string" && (appCredentialProviders as readonly string[]).includes(value);
}

export function validateAppCredentialInput(
  provider: unknown,
  clientId: unknown,
  clientSecret: unknown,
  requireSecret: boolean,
): string | null {
  if (!isAppCredentialProvider(provider)) return "Unknown provider.";
  const id = typeof clientId === "string" ? clientId.trim() : "";
  if (!id) return "Enter the app/client ID.";
  if (id.length > 255 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    return "The app/client ID may only contain letters, numbers, dots, hyphens, and underscores.";
  }
  const secret = typeof clientSecret === "string" ? clientSecret.trim() : "";
  if (requireSecret && !secret) return "Enter the app/client secret.";
  if (secret && (secret.length > 1024 || /[\s\0]/.test(secret))) {
    return "The app/client secret contains invalid characters.";
  }
  return null;
}
