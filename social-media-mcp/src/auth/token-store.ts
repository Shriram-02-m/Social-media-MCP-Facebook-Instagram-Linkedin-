import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";
import { databasePool } from "../database.js";
import type { Platform, StoredToken, TokenVault } from "../platforms/types.js";

interface EncryptedFile { version: 1; iv: string; tag: string; ciphertext: string }
interface EncryptedCloudToken { version: 1; iv: string; tag: string; ciphertext: string }
const platforms: Platform[] = ["facebook", "instagram", "linkedin"];

function localEncryptionKey(): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
    throw new Error("Set SOCIAL_MCP_TOKEN_ENCRYPTION_KEY to a randomly generated 64-character hex key.");
  }
  return Buffer.from(config.tokenEncryptionKey, "hex");
}

function cloudEncryptionKey(): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(config.cloudTokenEncryptionKey)) {
    throw new Error("Set CLOUD_TOKEN_ENCRYPTION_KEY to a randomly generated 64-character hex key.");
  }
  return Buffer.from(config.cloudTokenEncryptionKey, "hex");
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

export async function readLocalTokens(): Promise<TokenVault> {
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
    return JSON.parse(plaintext) as TokenVault;
  } catch {
    throw new Error("Could not decrypt the token store. Check the encryption key or remove the stored file to reconnect.");
  }
}

export async function saveLocalTokens(tokens: TokenVault): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", localEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
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

async function loadCloudTokens(): Promise<TokenVault> {
  const { rows } = await databasePool().query<{ platform: Platform; token_ciphertext: EncryptedCloudToken }>(
    "SELECT platform, token_ciphertext FROM public.oauth_tokens WHERE platform = ANY($1::text[])",
    [platforms],
  );
  const tokens: TokenVault = {};
  try {
    for (const row of rows) tokens[row.platform] = decryptCloudToken(row.platform, row.token_ciphertext);
  } catch {
    throw new Error("Could not decrypt cloud OAuth credentials. Check CLOUD_TOKEN_ENCRYPTION_KEY.");
  }
  return tokens;
}

export async function saveCloudTokens(tokens: TokenVault, overwrite = true): Promise<void> {
  const client = await databasePool().connect();
  try {
    await client.query("BEGIN");
    if (!overwrite) {
      const existing = await client.query<{ platform: Platform }>(
        "SELECT platform FROM public.oauth_tokens WHERE platform = ANY($1::text[]) FOR UPDATE",
        [platforms.filter((platform) => Boolean(tokens[platform]))],
      );
      if (existing.rowCount) throw new Error("Cloud OAuth token records already exist; use --overwrite only if replacing them is intentional.");
    }
    for (const platform of platforms) {
      const token = tokens[platform];
      if (!token) continue;
      await client.query(
        `INSERT INTO public.oauth_tokens (platform, token_ciphertext, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (platform) DO UPDATE
         SET token_ciphertext = EXCLUDED.token_ciphertext, updated_at = NOW()`,
        [platform, JSON.stringify(encryptCloudToken(platform, token))],
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

export async function loadTokens(): Promise<TokenVault> {
  return config.tokenStoreBackend === "supabase" ? loadCloudTokens() : readLocalTokens();
}

export async function saveTokens(tokens: TokenVault): Promise<void> {
  if (config.tokenStoreBackend === "supabase") {
    await saveCloudTokens(tokens);
    return;
  }
  await saveLocalTokens(tokens);
}
