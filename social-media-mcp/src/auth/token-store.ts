import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";
import { databasePool } from "../database.js";
import type { Platform, StoredToken, TokenVault } from "../platforms/types.js";

interface EncryptedFile { version: 1; iv: string; tag: string; ciphertext: string }
interface EncryptedCloudToken { version: 1; iv: string; tag: string; ciphertext: string }

// One provider-token vault per application user. The local encrypted file and the
// cloud oauth_tokens table both key records by (user_id, platform).
type UserTokenVaults = Record<string, TokenVault>;

const platforms: Platform[] = ["facebook", "instagram", "linkedin"];

function isPlatform(key: string): key is Platform {
  return (platforms as string[]).includes(key);
}

function encryptionKey(envName: string, value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Set ${envName} to a randomly generated 64-character hex key.`);
  }
  return Buffer.from(value, "hex");
}

function localEncryptionKey(): Buffer {
  return encryptionKey("SOCIAL_MCP_TOKEN_ENCRYPTION_KEY", config.tokenEncryptionKey);
}

function cloudEncryptionKey(): Buffer {
  return encryptionKey("CLOUD_TOKEN_ENCRYPTION_KEY", config.cloudTokenEncryptionKey);
}

function encryptCloudToken(platform: Platform, token: StoredToken): EncryptedCloudToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cloudEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(`social-media-mcp:${platform}:v1`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

function decryptCloudToken(platform: Platform, envelope: EncryptedCloudToken): StoredToken {
  if (envelope.version !== 1) throw new Error("Unsupported cloud token record version.");
  const decipher = createDecipheriv("aes-256-gcm", cloudEncryptionKey(), Buffer.from(envelope.iv, "hex"));
  decipher.setAAD(Buffer.from(`social-media-mcp:${platform}:v1`, "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8")) as StoredToken;
}

function normalizeUserVaults(parsed: unknown): UserTokenVaults {
  if (!parsed || typeof parsed !== "object") return {};
  const record = parsed as Record<string, unknown>;
  // Legacy single-user files store a bare platform -> token object. Wrap it under
  // the owner identity so existing local installs keep working after upgrading.
  if (Object.keys(record).some((key) => isPlatform(key))) {
    return { [config.ownerUserId]: record as TokenVault };
  }
  const vaults: UserTokenVaults = {};
  for (const [userId, vault] of Object.entries(record)) {
    if (vault && typeof vault === "object") vaults[userId] = vault as TokenVault;
  }
  return vaults;
}

async function readLocalVaults(): Promise<UserTokenVaults> {
  let file: string;
  try {
    file = await readFile(config.tokenFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not read the encrypted token store.");
  }
  try {
    const envelope = JSON.parse(file) as EncryptedFile;
    if (envelope.version !== 1) throw new Error("Unsupported token store version.");
    const decipher = createDecipheriv("aes-256-gcm", localEncryptionKey(), Buffer.from(envelope.iv, "hex"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "hex"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "hex")),
      decipher.final(),
    ]).toString("utf8");
    return normalizeUserVaults(JSON.parse(plaintext));
  } catch {
    throw new Error("Could not decrypt the token store. Check the encryption key or remove the stored file to reconnect.");
  }
}

async function writeLocalVaults(vaults: UserTokenVaults): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(vaults), "utf8"), cipher.final()]);
  const envelope: EncryptedFile = {
    version: 1,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
  await mkdir(path.dirname(config.tokenFile), { recursive: true });
  const temporaryPath = `${config.tokenFile}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(envelope), { mode: 0o600 });
  await rename(temporaryPath, config.tokenFile);
}

export async function readLocalTokens(ownerId: string): Promise<TokenVault> {
  return (await readLocalVaults())[ownerId] ?? {};
}

export async function saveLocalTokens(ownerId: string, tokens: TokenVault): Promise<void> {
  const vaults = await readLocalVaults();
  vaults[ownerId] = tokens;
  await writeLocalVaults(vaults);
}

async function loadCloudTokens(ownerId: string): Promise<TokenVault> {
  const { rows } = await databasePool().query<{ platform: Platform; token_ciphertext: EncryptedCloudToken }>(
    "SELECT platform, token_ciphertext FROM public.oauth_tokens WHERE user_id = $1 AND platform = ANY($2::text[])",
    [ownerId, platforms],
  );
  const tokens: TokenVault = {};
  for (const row of rows) tokens[row.platform] = decryptCloudToken(row.platform, row.token_ciphertext);
  return tokens;
}

export async function saveCloudTokens(
  ownerId: string,
  tokens: TokenVault,
  overwrite = true,
): Promise<void> {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    if (!overwrite) {
      const { rows } = await client.query<{ platform: Platform }>(
        "SELECT platform FROM public.oauth_tokens WHERE user_id = $1 AND platform = ANY($2::text[]) FOR UPDATE",
        [ownerId, platforms],
      );
      const existing = rows.filter((row) => Boolean(tokens[row.platform]));
      if (existing.length) {
        throw new Error(
          `Cloud OAuth records already exist for user ${ownerId} (${existing.map((row) => row.platform).join(", ")}). Pass --overwrite to replace them.`,
        );
      }
    }
    for (const platform of platforms) {
      const token = tokens[platform];
      if (!token) continue;
      await client.query(
        `INSERT INTO public.oauth_tokens (user_id, platform, token_ciphertext, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (user_id, platform) DO UPDATE
         SET token_ciphertext = EXCLUDED.token_ciphertext, updated_at = NOW()`,
        [ownerId, platform, JSON.stringify(encryptCloudToken(platform, token))],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadTokens(ownerId: string): Promise<TokenVault> {
  return config.tokenStoreBackend === "supabase" ? loadCloudTokens(ownerId) : readLocalTokens(ownerId);
}

export async function saveTokens(ownerId: string, tokens: TokenVault): Promise<void> {
  if (config.tokenStoreBackend === "supabase") {
    await saveCloudTokens(ownerId, tokens);
    return;
  }
  await saveLocalTokens(ownerId, tokens);
}
