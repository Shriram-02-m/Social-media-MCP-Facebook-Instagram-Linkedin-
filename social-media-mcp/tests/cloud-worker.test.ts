import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env["WORKER_TRIGGER_SECRET"] = "0123456789abcdef0123456789abcdef";
const { isWorkerTriggerAuthorized } = await import("../src/worker.js");

test("cloud migration adds storage references and encrypted token storage without deleting post data", async () => {
  const migration = await readFile(new URL("../migrations/003_cloud_scheduling.sql", import.meta.url), "utf8");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS image_storage_path/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.oauth_tokens/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(migration, /REVOKE ALL ON TABLE public\.oauth_tokens/i);
  assert.match(migration, /social-media-images[\s\S]*FALSE/i);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b/i);
});

test("Supabase Cron migration requires Vault secrets and calls a configured HTTPS endpoint", async () => {
  const migration = await readFile(new URL("../migrations/004_supabase_cron.sql", import.meta.url), "utf8");
  assert.match(migration, /vault\.decrypted_secrets/i);
  assert.match(migration, /social_worker_url/i);
  assert.match(migration, /social_worker_secret/i);
  assert.match(migration, /https:\/\/\[\^\/\]\+/i);
  assert.match(migration, /\/worker\/run/i);
  assert.match(migration, /'\* \* \* \* \*'/);
});

test("worker endpoint authenticates requests and scheduler disables its timer in cloud mode", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(worker, /timingSafeEqual/);
  assert.match(worker, /pathname === "\/worker\/run"/);
  assert.match(worker, /pathname === "\/mcp"/);
  assert.match(worker, /processDueJobs\(\)/);
  assert.match(scheduler, /config\.schedulerMode !== "local"\) return/);
  assert.match(scheduler, /FOR UPDATE SKIP LOCKED/);
});

test("scheduled cancellation only updates unclaimed jobs", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /export async function cancelScheduledPost/);
  assert.match(scheduler, /WHERE id = \$1 AND user_id = \$2 AND status = 'scheduled'/);
  assert.match(scheduler, /failure_stage = COALESCE\(failure_stage, 'publishing'\)/);
});

test("worker trigger accepts only the exact configured bearer secret", () => {
  const secret = process.env["WORKER_TRIGGER_SECRET"]!;
  assert.equal(isWorkerTriggerAuthorized(`Bearer ${secret}`, secret), true);
  assert.equal(isWorkerTriggerAuthorized(`Bearer ${secret}x`, secret), false);
  assert.equal(isWorkerTriggerAuthorized("Bearer wrong", secret), false);
});
