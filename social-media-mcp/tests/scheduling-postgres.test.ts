import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scheduled-post migration stores schedule, media reference, and delivery state in PostgreSQL", async () => {
  const migration = await readFile(new URL("../migrations/001_scheduled_posts.sql", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS scheduled_posts/i);
  assert.match(migration, /scheduled_at TIMESTAMPTZ NOT NULL/i);
  assert.match(migration, /image_path TEXT NOT NULL/i);
  assert.match(migration, /status TEXT NOT NULL CHECK/i);
  assert.match(migration, /result JSONB/i);
  assert.match(migration, /scheduled_posts_due_idx/i);
  assert.match(migration, /retry_count INTEGER NOT NULL DEFAULT 0/i);
  assert.match(migration, /failure_stage TEXT/i);
  assert.match(migration, /image_validation JSONB/i);
});