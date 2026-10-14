import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scheduled-post migration stores schedule, media reference, and delivery state in PostgreSQL", async () => {
  const migration = await readFile(new URL("../migrations/001_scheduled_posts.sql", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.scheduled_posts/i);
  assert.match(migration, /scheduled_at TIMESTAMPTZ NOT NULL/i);
  assert.match(migration, /image_path TEXT NOT NULL/i);
  assert.match(migration, /status TEXT NOT NULL CHECK/i);
  assert.match(migration, /result JSONB/i);
  assert.match(migration, /scheduled_posts_due_idx/i);
  assert.match(migration, /retry_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(migration, /failure_stage TEXT/i);
  assert.match(migration, /image_validation JSONB/i);
});

test("additive scheduled-post migration adds checks without dropping existing data", async () => {
  const migration = await readFile(new URL("../migrations/002_scheduled_posts_constraints.sql", import.meta.url), "utf8");

  assert.match(migration, /ADD CONSTRAINT scheduled_posts_platform_check/i);
  assert.match(migration, /ADD CONSTRAINT scheduled_posts_status_check/i);
  assert.match(migration, /ADD CONSTRAINT scheduled_posts_failure_stage_check/i);
  assert.match(migration, /NOT VALID/i);
  assert.match(migration, /VALIDATE CONSTRAINT/i);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("due-post claim is atomic and skips rows claimed by other workers", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  assert.match(scheduler, /FOR UPDATE SKIP LOCKED/);
  assert.match(scheduler, /UPDATE public\.scheduled_posts AS post/);
  assert.match(scheduler, /export async function processDueJobs/);
  assert.match(scheduler, /setInterval\(\(\) => \{\s*void processDueJobs\(\)/);
});