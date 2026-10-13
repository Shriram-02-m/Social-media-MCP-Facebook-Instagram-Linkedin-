import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config/env.js";
import type { TokenVault } from "../platforms/types.js";

interface EncryptedFile { version: 1; iv: string; tag: string; ciphertext: string }

function encryptionKey(): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(config.tokenEncryptionKey)) {
    throw new Error("Set SOCIAL_MCP_TOKEN_ENCRYPTION_KEY to a randomly generated 64-character hex key.");
  }
  return Buffer.from(config.tokenEncryptionKey, "hex");
}

export async function loadTokens(): Promise<TokenVault> {
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
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(envelope.iv, "hex"));
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

export async function saveTokens(tokens: TokenVault): Promise<void> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
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