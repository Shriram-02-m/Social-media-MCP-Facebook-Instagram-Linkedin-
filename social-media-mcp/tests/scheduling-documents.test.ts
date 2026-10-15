import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("linkedin-document migration adds document columns, PDF bucket type, and document validation stage", async () => {
  const migration = await readFile(new URL("../migrations/005_linkedin_documents.sql", import.meta.url), "utf8");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_path TEXT NOT NULL DEFAULT ''/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_storage_path TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_content_type TEXT/i);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_title TEXT/i);
  assert.match(migration, /'document_validation'/);
  assert.match(migration, /application\/pdf/);
  assert.match(migration, /allowed_mime_types/i);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("database migration runner applies the linkedin-document migration", async () => {
  const runner = await readFile(new URL("../src/database-migrations.ts", import.meta.url), "utf8");
  assert.match(runner, /005_linkedin_documents\.sql/);
});

test("scheduler persists document columns and publishes LinkedIn native documents", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  assert.match(scheduler, /document_storage_path, document_content_type, document_title/);
  assert.match(scheduler, /publishLinkedInWithDocument/);
  assert.match(scheduler, /document_validation/);
  assert.match(scheduler, /document_storage_path \? \{ documentStoragePath/);
  assert.match(scheduler, /validateStoredOrLocalDocument/);
});

test("LinkedIn platform uploads documents through the Documents API", async () => {
  const linkedin = await readFile(new URL("../src/platforms/linkedin.ts", import.meta.url), "utf8");

  assert.match(linkedin, /https:\/\/api\.linkedin\.com\/rest\/documents\?action=initializeUpload/);
  assert.match(linkedin, /initializeUploadRequest: \{ owner: author \}/);
  assert.match(linkedin, /export async function publishLinkedInWithDocument/);
  assert.match(linkedin, /content = \{ media: \{ id: documentUrn, title: document\.title \} \}/);
});
