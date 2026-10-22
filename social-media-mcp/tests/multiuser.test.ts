import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { StoredToken } from "../src/platforms/types.js";

const directory = await mkdtemp(join(tmpdir(), "social-media-mcp-multiuser-"));
const tokenFile = join(directory, "tokens.enc");
process.env["SOCIAL_MCP_TOKEN_FILE"] = tokenFile;
process.env["SOCIAL_MCP_TOKEN_ENCRYPTION_KEY"] = "a".repeat(64);
process.env["TOKEN_STORE_BACKEND"] = "local";
process.env["MCP_OWNER_USER_ID"] = "local-owner";

const tokenStore = await import("../src/auth/token-store.js");
const { config } = await import("../src/config/env.js");

test.after(async () => rm(directory, { recursive: true, force: true }));

const instagramToken: StoredToken = {
  accessToken: "alice-instagram",
  scopes: ["instagram_business_basic"],
  connectedAt: 1,
};
const linkedinToken: StoredToken = {
  accessToken: "bob-linkedin",
  scopes: ["w_member_social"],
  connectedAt: 2,
};

function writeLegacyVault(payload: unknown): string {
  const key = Buffer.from(process.env["SOCIAL_MCP_TOKEN_ENCRYPTION_KEY"]!, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  });
}

test("local token vault isolates each user's credentials", async () => {
  await tokenStore.saveLocalTokens("alice", { instagram: instagramToken });
  await tokenStore.saveLocalTokens("bob", { linkedin: linkedinToken });

  assert.equal((await tokenStore.loadTokens("alice")).instagram?.accessToken, "alice-instagram");
  assert.equal((await tokenStore.loadTokens("alice")).linkedin, undefined);
  assert.equal((await tokenStore.loadTokens("bob")).linkedin?.accessToken, "bob-linkedin");
  assert.equal((await tokenStore.loadTokens("bob")).instagram, undefined);
  assert.deepEqual(await tokenStore.loadTokens("carol"), {});
});

test("legacy single-user vaults are adopted by the configured owner identity", async () => {
  await writeFile(tokenFile, writeLegacyVault({ linkedin: { ...linkedinToken, accessToken: "legacy-linkedin" } }));

  assert.equal((await tokenStore.loadTokens(config.ownerUserId)).linkedin?.accessToken, "legacy-linkedin");
  assert.deepEqual(await tokenStore.loadTokens("someone-else"), {});
});

test("migration 007 adds per-user ownership to scheduled posts and tokens", async () => {
  const sql = await readFile(new URL("../migrations/007_multi_user.sql", import.meta.url), "utf8");

  assert.match(sql, /ALTER TABLE public\.scheduled_posts[\s\S]*ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'local-owner'/i);
  assert.match(sql, /ALTER TABLE public\.oauth_tokens[\s\S]*ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'local-owner'/i);
  assert.match(sql, /PRIMARY KEY \(user_id, platform\)/i);
  assert.match(sql, /scheduled_posts_user_due_idx/i);
});

test("scheduler scopes ownership-sensitive queries by user_id", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  assert.match(scheduler, /async function loadJobs\(ownerId: string\)/);
  assert.match(scheduler, /WHERE id = \$1 AND user_id = \$2 AND status = 'scheduled'/);
  assert.match(scheduler, /WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
  assert.match(scheduler, /INSERT INTO public\.scheduled_posts[\s\S]*\(user_id, id, platform/);
});
