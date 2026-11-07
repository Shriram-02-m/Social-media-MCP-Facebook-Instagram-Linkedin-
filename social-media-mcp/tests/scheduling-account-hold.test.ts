import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canCancelScheduledPost,
  canRescheduleScheduledPost,
} from "../src/scheduler.js";

test("held posts can be rescheduled (the defined recovery for overdue holds)", () => {
  assert.equal(canRescheduleScheduledPost("scheduled"), true);
  assert.equal(canRescheduleScheduledPost("held"), true);
  assert.equal(canRescheduleScheduledPost("publishing"), false);
  assert.equal(canRescheduleScheduledPost("published"), false);
  assert.equal(canRescheduleScheduledPost("failed"), false);
  assert.equal(canRescheduleScheduledPost("cancelled"), false);
});

test("held posts can still be cancelled, terminal states cannot", () => {
  assert.equal(canCancelScheduledPost("scheduled"), true);
  assert.equal(canCancelScheduledPost("held"), true);
  assert.equal(canCancelScheduledPost("publishing"), false);
  assert.equal(canCancelScheduledPost("published"), false);
  assert.equal(canCancelScheduledPost("failed"), false);
  assert.equal(canCancelScheduledPost("cancelled"), false);
});

test("the account-hold migration is additive and enforces the new hold state", async () => {
  const migration = await readFile(new URL("../migrations/013_account_hold.sql", import.meta.url), "utf8");

  assert.match(migration, /CHECK \(status IN \('scheduled', 'publishing', 'published', 'failed', 'cancelled', 'held'\)\) NOT VALID/i);
  assert.match(migration, /VALIDATE CONSTRAINT scheduled_posts_status_check/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.social_media_account_is_active/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.activity_log/i);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/i);
  // No destructive statements: existing scheduled jobs and history are safe.
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("the worker claim refuses posts owned by suspended or deleted accounts", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  // The original claim guarantees are untouched.
  assert.match(scheduler, /WHERE status = 'scheduled' AND scheduled_at <= NOW\(\)/);
  assert.match(scheduler, /ORDER BY scheduled_at\s*\n\s*FOR UPDATE SKIP LOCKED\s*\n\s*LIMIT 10/);
  // The new database-level guard runs inside the claim query itself.
  assert.match(scheduler, /AND public\.social_media_account_is_active\(user_id\)/);
});

test("holding locks pending rows so racing claims cannot start publishing", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  const start = scheduler.indexOf("export async function holdScheduledPostsForUser");
  assert.ok(start >= 0, "holdScheduledPostsForUser should be exported from the scheduler");
  const source = scheduler.slice(start, scheduler.indexOf("export interface ResumeScheduledPostsResult"));

  assert.match(source, /WHERE user_id = \$1 AND status = 'scheduled'\s*\n\s*ORDER BY scheduled_at\s*\n\s*FOR UPDATE/);
  assert.match(source, /SET status = 'held', error = \$2, claimed_at = NULL, updated_at = NOW\(\)/);
  // Holds never delete posts, media, or history.
  assert.doesNotMatch(source, /\bDELETE FROM\b/i);
  assert.doesNotMatch(source, /\bUPDATE public\.scheduled_posts\s+SET scheduled_at\b/i);
});

test("resume re-enables future posts without stale-time republishing of overdue ones", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  const start = scheduler.indexOf("export async function resumeScheduledPostsForUser");
  assert.ok(start >= 0, "resumeScheduledPostsForUser should be exported from the scheduler");
  const source = scheduler.slice(start);

  assert.match(source, /SELECT \* FROM public\.scheduled_posts\s*\n\s*WHERE user_id = \$1 AND status = 'held' AND \(\$2::text IS NULL OR id = \$2\)\s*\n\s*ORDER BY scheduled_at\s*\n\s*FOR UPDATE/);
  assert.match(source, /const overdue = row\.scheduled_at\.getTime\(\) <= Date\.now\(\)/);
  assert.match(source, /Still held: the original schedule time has passed\. Reschedule the post explicitly\./);
  assert.match(source, /SET status = 'scheduled', error = NULL, claimed_at = NULL/);
  // Resume never publishes at a stale time and never duplicates posts: no
  // scheduled_at rewrite for resumed rows and no new rows at all.
  assert.doesNotMatch(source, /SET scheduled_at =/);
  assert.doesNotMatch(source, /\bINSERT INTO public\.scheduled_posts\b/i);
});

test("new scheduling and retry attempts respect the account hold gate", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  assert.match(scheduler, /export async function assertAccountCanSchedule/);
  assert.match(scheduler, /SELECT public\.social_media_account_is_active\(\$1\) AS active/);
  // All three mutation entry points are gated (schedulePosts,
  // scheduleMediaPosts, retryScheduledPost).
  assert.equal(scheduler.match(/await assertAccountCanSchedule\(ownerId\);/g)?.length, 3);
});

test("activity logging for hold and resume never affects the critical flow", async () => {
  const activity = await readFile(new URL("../src/utils/activity.ts", import.meta.url), "utf8");

  assert.match(activity, /export async function recordActivity/);
  assert.match(activity, /catch \(error: unknown\)/);
  // Credential-bearing keys are dropped before anything reaches the database.
  assert.match(activity, /FORBIDDEN_META_KEYS = \//);
  assert.match(activity, /access_\?token\|refresh_\?token\|secret/);
  assert.match(activity, /if \(FORBIDDEN_META_KEYS\.test\(key\)\) continue;/);
});

test("the migration runner includes the account-hold migration", async () => {
  const migrations = await readFile(new URL("../src/database-migrations.ts", import.meta.url), "utf8");
  assert.match(migrations, /"013_account_hold\.sql"/);
});
