import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canRescheduleScheduledPost,
  normalizeRescheduledTime,
} from "../src/scheduler.js";

test("only posts still waiting to publish can be rescheduled", () => {
  assert.equal(canRescheduleScheduledPost("scheduled"), true);
  assert.equal(canRescheduleScheduledPost("publishing"), false);
  assert.equal(canRescheduleScheduledPost("published"), false);
  assert.equal(canRescheduleScheduledPost("failed"), false);
  assert.equal(canRescheduleScheduledPost("cancelled"), false);
});

test("reschedule validation requires a valid future timestamp", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const future = new Date(now + 3_600_000).toISOString();
  assert.equal(normalizeRescheduledTime(future, now), future);

  assert.throws(() => normalizeRescheduledTime("", now), /valid date and time/i);
  assert.throws(() => normalizeRescheduledTime("not-a-date", now), /valid date and time/i);
  assert.throws(() => normalizeRescheduledTime(new Date(now).toISOString(), now), /future/i);
  assert.throws(
    () => normalizeRescheduledTime(new Date(now - 60_000).toISOString(), now),
    /future/i,
  );
});

test("rescheduling updates the existing job in place and never inserts a duplicate", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  const start = scheduler.indexOf("export async function rescheduleScheduledPost");
  assert.ok(start >= 0, "rescheduleScheduledPost should be exported from the scheduler");
  const source = scheduler.slice(start);

  assert.match(source, /SELECT \* FROM public\.scheduled_posts WHERE id = \$1 AND user_id = \$2 FOR UPDATE/);
  assert.match(source, /UPDATE public\.scheduled_posts\s+SET scheduled_at = \$3/);
  assert.match(source, /claimed_at = NULL/);
  assert.match(source, /canRescheduleScheduledPost\(row\.status\)/);
  assert.doesNotMatch(source, /\bINSERT INTO\b/i);
  assert.doesNotMatch(source, /\bDELETE FROM\b/i);
});

test("the worker claim and the reschedule lock cooperate", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  // Resume uses a row lock; the due-job claim skips locked rows so a post being
  // rescheduled is never published at its previous time.
  assert.match(scheduler, /WHERE status = 'scheduled' AND scheduled_at <= NOW\(\)/);
  assert.match(scheduler, /FOR UPDATE SKIP LOCKED/);
});
