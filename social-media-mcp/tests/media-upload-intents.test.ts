import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env["WORKER_TRIGGER_SECRET"] = process.env["WORKER_TRIGGER_SECRET"]
  ?? "0123456789abcdef0123456789abcdef";
const { config } = await import("../src/config/env.js");
const endpoint = await import("../src/media/upload-endpoint.js");
const intents = await import("../src/storage/upload-intents.js");

// --- Migration safety (static; nothing touches a live database) --------------

test("media upload intents migration is additive, hashes tokens, and locks access down", async () => {
  const migration = await readFile(new URL("../migrations/011_mcp_media_upload_intents.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.mcp_media_upload_intents \(/);
  assert.match(migration, /token_hash TEXT NOT NULL UNIQUE/);
  assert.match(migration, /user_id TEXT NOT NULL/);
  assert.match(migration, /CHECK \(status <> 'uploaded' OR \(storage_path IS NOT NULL AND consumed_at IS NOT NULL\)\)/);
  assert.match(migration, /kind TEXT NOT NULL CHECK \(kind IN \('image', 'video', 'document'\)\)/);
  assert.match(migration, /CHECK \(status IN \('pending', 'uploaded', 'failed'\)\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.mcp_media_upload_intents FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON TABLE public\.mcp_media_upload_intents TO service_role/);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b/i);
  const migrations = await readFile(new URL("../src/database-migrations.ts", import.meta.url), "utf8");
  assert.match(migrations, /"011_mcp_media_upload_intents\.sql"/);
});

test("rate-hit history migration is additive, user-scoped, and locked to the service role", async () => {
  const migration = await readFile(new URL("../migrations/012_mcp_intent_rate_limit.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.mcp_media_intent_rate_hits \(/);
  assert.match(migration, /user_id TEXT NOT NULL/);
  assert.match(migration, /hit_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS mcp_media_intent_rate_hits_window_idx/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.mcp_media_intent_rate_hits FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT ALL ON TABLE public\.mcp_media_intent_rate_hits TO service_role/);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bDELETE\s+FROM\b/i, "migrations never delete data or drop tables");
  const migrations = await readFile(new URL("../src/database-migrations.ts", import.meta.url), "utf8");
  assert.match(migrations, /"012_mcp_intent_rate_limit\.sql"/);
});

// --- Pure validation helpers --------------------------------------------------

test("filenames are display-only and cannot traverse or shape a storage key", () => {
  assert.equal(intents.sanitizeUploadFilename("../../etc/passwd.png"), "passwd.png");
  assert.equal(intents.sanitizeUploadFilename("C:\\evil\\beach shot.png"), "beach shot.png");
  assert.equal(intents.sanitizeUploadFilename("holiday\x00\x1f.mp4"), "holiday.mp4");
  assert.equal(intents.sanitizeUploadFilename("a".repeat(300)), "a".repeat(200));
});

test("content types are constrained to the private bucket's accepted set", () => {
  assert.equal(intents.extensionForContentType("image/jpeg"), ".jpg");
  assert.equal(intents.extensionForContentType("image/png"), ".png");
  assert.equal(intents.extensionForContentType("image/gif"), ".gif");
  assert.equal(intents.extensionForContentType("video/mp4"), ".mp4");
  assert.equal(intents.extensionForContentType("video/quicktime"), ".mov");
  assert.equal(intents.extensionForContentType("application/pdf"), ".pdf");
  assert.equal(intents.extensionForContentType("image/webp"), undefined);
  assert.equal(intents.contentTypeForFilename("holiday.jpg"), "image/jpeg");
  assert.equal(intents.contentTypeForFilename("holiday.JPEG"), "image/jpeg");
  assert.equal(intents.contentTypeForFilename("clip.mov"), "video/quicktime");
  assert.equal(intents.contentTypeForFilename("song.mp3"), undefined);
});

test("upload intents reject unsupported or mismatched declared media", () => {
  assert.throws(() => intents.assertSupportedMediaUpload("image", "image/webp"), /Unsupported upload content type/);
  assert.throws(() => intents.assertSupportedMediaUpload("video", "image/png"), /not valid for a video upload/);
  assert.doesNotThrow(() => intents.assertSupportedMediaUpload("document", "application/pdf"));
});

test("declared sizes are bounded by the per-kind bucket limits", () => {
  intents.assertAllowedDeclaredSize("image", config.scheduleImageMaxBytes);
  assert.throws(() => intents.assertAllowedDeclaredSize("image", config.scheduleImageMaxBytes + 1), /byte limit/);
  assert.throws(() => intents.assertAllowedDeclaredSize("video", 0), /positive integer/);
  assert.doesNotThrow(() => intents.assertAllowedDeclaredSize("video", config.scheduleVideoMaxBytes));
});

test("upload token is opaque, 256-bit entropy, and hashed to a stable digest", () => {
  const token = intents.newUploadToken();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.match(intents.hashUploadToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(intents.hashUploadToken(token), intents.hashUploadToken(intents.newUploadToken()));
});

test("rate limiter allows the configured burst and blocks beyond the window", () => {
  const limiter = intents.createSlidingWindowRateLimiter({ maxRequests: 3, windowMs: 1000 });
  assert.equal(limiter.allow("user-a", 0), true);
  assert.equal(limiter.allow("user-a", 10), true);
  assert.equal(limiter.allow("user-a", 20), true);
  assert.equal(limiter.allow("user-a", 30), false);
  assert.equal(limiter.allow("user-b", 30), true);
  assert.equal(limiter.allow("user-a", 999), false, "all three hits are still inside the window");
  assert.equal(limiter.allow("user-a", 1050), true, "the window has fully slid past all three hits");
});

// --- Upload endpoint request evaluation ---------------------------------------

test("uploads must match the intent's kind, content type, size, and availability", () => {
  const intent = { kind: "image" as const, contentType: "image/jpeg", expectedBytes: 0 };
  assert.equal(intents.evaluateMediaUpload(intent, "image/jpeg", new Uint8Array(8)), undefined);
  const mismatch = intents.evaluateMediaUpload(intent, "image/png", new Uint8Array(8));
  assert.equal(mismatch?.status, 415);
  assert.match(mismatch?.message ?? "", /single-use/);
  const unsupported = intents.evaluateMediaUpload(intent, "image/webp", new Uint8Array(8));
  assert.equal(unsupported?.status, 415);
  const empty = intents.evaluateMediaUpload(intent, "image/jpeg", new Uint8Array(0));
  assert.equal(empty?.status, 400);
  const oversized = intents.evaluateMediaUpload(intent, "image/jpeg", new Uint8Array(config.scheduleImageMaxBytes + 1));
  assert.equal(oversized?.status, 413);
});

// --- Upload URL building -------------------------------------------------------

test("upload endpoint URLs must be HTTPS outside localhost", () => {
  intents.assertUploadEndpointUrl("https://worker.example.com/media/upload");
  intents.assertUploadEndpointUrl("http://localhost:8787/media/upload");
  assert.throws(() => intents.assertUploadEndpointUrl("http://worker.example.com/media/upload"), /HTTPS/);
  assert.throws(() => intents.assertUploadEndpointUrl("https://u:p@worker.example.com/media/upload"), /credentials/);
  const endpointUrl = intents.mediaUploadEndpointUrl();
  assert.ok(endpointUrl.startsWith(new URL(config.mcpPublicUrl).origin), endpointUrl);
});

// --- Endpoint token extraction (web Request, no server or database) ------------

test("the endpoint accepts the capability token via bearer header or query, never an MCP token", () => {
  const bearer = new Request("https://worker.example.com/media/upload", {
    method: "POST",
    headers: { authorization: "Bearer abc123" },
  });
  assert.equal(endpoint.extractUploadToken(bearer), "abc123");
  const query = new Request("https://worker.example.com/media/upload?token=abc123", { method: "POST" });
  assert.equal(endpoint.extractUploadToken(query), "abc123");
  const missing = new Request("https://worker.example.com/media/upload", { method: "POST" });
  assert.equal(endpoint.extractUploadToken(missing), undefined);
  const wrongScheme = new Request("https://worker.example.com/media/upload", {
    method: "POST",
    headers: { authorization: "Basic abc123" },
  });
  assert.equal(endpoint.extractUploadToken(wrongScheme), undefined);
});

test("the transport limit covers the largest accepted video plus package overhead", () => {
  assert.ok(endpoint.mediaUploadBodyLimit >= config.scheduleVideoMaxBytes);
  assert.ok(endpoint.mediaUploadBodyLimit < config.scheduleVideoMaxBytes + 2 * 1024 * 1024);
});

// --- Wiring (static assertions against the source, per project convention) ----

test("the worker serves POST /media/upload with a proper body bound and auth gate ordering", async () => {
  const worker = await readFile(new URL("../src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /pathname === "\/media\/upload"/);
  assert.match(worker, /mediaUploadBodyLimit/);
  assert.match(worker, /mediaUploadResponse/);
  const handler = worker.slice(worker.indexOf("async function handleMediaUpload"), worker.indexOf("async function route"));
  assert.match(handler, /methodNotAllowed\(response, "POST"\)/);
  assert.match(handler, /readWebRequest\(request, mediaUploadBodyLimit\)/);
  assert.match(handler, /sendWebResponse\(response, webResponse\)/);
});

test("the upload endpoint claims the intent before accepting bytes and cleans up on uncertainty", async () => {
  const source = await readFile(new URL("../src/media/upload-endpoint.ts", import.meta.url), "utf8");
  const claimIndex = source.indexOf("claimPendingMediaUploadIntent(token)");
  const arrayBufferIndex = source.indexOf("request.arrayBuffer()");
  const uploadIndex = source.indexOf("await uploadScheduledVideo(bytes,");
  assert.ok(claimIndex >= 0, "the intent must be claimed");
  assert.ok(arrayBufferIndex > claimIndex, "body bytes are accepted only after the atomic single-use claim");
  assert.ok(uploadIndex > claimIndex, "storage writes happen only after the claim");
  assert.match(source, /completeMediaUploadIntent/);
  assert.match(source, /failMediaUploadIntent/);
  assert.match(source, /deleteScheduledVideo|deleteScheduledImage|deleteScheduledDocument/);
  assert.match(source, /media_upload_orphan_cleanup_failed/);
  assert.match(source, /matchesMediaSignature/);
  assert.doesNotMatch(source, /createScheduledImageUrl/, "the endpoint must never mint signed URLs");
  assert.doesNotMatch(source, /supabaseServiceRoleKey"?\s*:/, "the service-role key must not appear in a response body");
  assert.doesNotMatch(source, /Bearer \$\{config/, "MCP access tokens must never be placed in upload responses");
});

test("the tool binds the intent to the trusted session user, never a caller-supplied id", async () => {
  const register = await readFile(new URL("../src/tools/register.ts", import.meta.url), "utf8");
  const toolIndex = register.indexOf('server.registerTool("social_upload_media_intent"');
  const nextToolIndex = register.indexOf('server.registerTool("social_publish"');
  const tool = register.slice(toolIndex, nextToolIndex);
  assert.ok(toolIndex >= 0, "the upload intent tool must be registered");
  assert.match(tool, /userId\b/);
  assert.doesNotMatch(tool, /ownerUserId:|userId: input|userId: args/);
  assert.match(tool, /buildUploadInstructions/);
});

test("social_publish accepts and ownership-checks permanent storage paths", async () => {
  const register = await readFile(new URL("../src/tools/register.ts", import.meta.url), "utf8");
  assert.match(register, /assertOwnedStorageObjectPath\(input\.imageStoragePath, userId\)/);
  assert.match(register, /requireCloudStorageForReference\(\)/);
  assert.match(register, /downloadScheduledImage\(input\.imageStoragePath\)/);
  assert.match(register, /createScheduledImageUrl\(input\.imageStoragePath\)/);
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /export function requireCloudStorageForReference/);
  const validation = await readFile(new URL("../src/utils/validation.ts", import.meta.url), "utf8");
  assert.match(validation, /platformImageRequirements\(\s*platform: Platform,\s*imageUrl\?: string,\s*imagePath\?: string,\s*imageStoragePath\?: string,/);
  assert.match(validation, /validatePostContent\(\s*text\?: string,\s*imageUrl\?: string,\s*imagePath\?: string,\s*imageStoragePath\?: string,/);
});

test("the intent tool result explains the Claude.ai reality and the browser fallback", async () => {
  const intentsSource = await readFile(new URL("../src/storage/upload-intents.ts", import.meta.url), "utf8");
  assert.match(intentsSource, /single-use/);
  assert.match(intentsSource, /fallbackUrl/);
  assert.match(intentsSource, /code execution/, "instructions must describe the sandbox requirement honestly");
  assert.match(intentsSource, /fallback upload/, "instructions must offer the browser fallback");
  assert.match(intentsSource, /not an MCP access token/);
});

// --- Durable intent rate limiting (migration 012 + database check) ------------

test("intent rate limiting spans processes via the database and fails open on database errors", async () => {
  const intentsSource = await readFile(new URL("../src/storage/upload-intents.ts", import.meta.url), "utf8");
  const inMemoryIndex = intentsSource.indexOf("intentRateLimiter.allow(userId)");
  const databaseIndex = intentsSource.indexOf("recordMediaIntentRateHit(userId)");
  assert.ok(inMemoryIndex >= 0, "the in-process window remains the always-available guard");
  assert.ok(databaseIndex > inMemoryIndex, "the durable database window is consulted after the in-process check");
  assert.match(intentsSource, /mcp_media_intent_rate_hits/);
  assert.match(intentsSource, /hit_at > NOW\(\) - make_interval\(secs => \$2\)/);
  assert.match(intentsSource, /media_upload_intent_rate_limit_database_unavailable/,
    "a database error must fail open instead of blocking uploads");
});

// --- Expired-upload cleanup through the reference-counted helper --------------

test("expired uploads are cleaned up through the reference-counted storage helper", async () => {
  const intentsSource = await readFile(new URL("../src/storage/upload-intents.ts", import.meta.url), "utf8");
  assert.match(intentsSource, /await deleteUnreferencedStorageObjects\(candidates\)/,
    "sweeping never deletes an object without the shared reference check");
  const selectIndex = intentsSource.indexOf("SELECT id, storage_path, kind");
  const cleanupIndex = intentsSource.indexOf("deleteUnreferencedStorageObjects(candidates)");
  const rowIndex = intentsSource.indexOf("storage_path IS NULL OR id = ANY($2::text[])");
  assert.ok(selectIndex >= 0 && cleanupIndex > selectIndex, "candidates are read before the reference-counted delete");
  assert.ok(rowIndex > cleanupIndex, "rows whose object survived the sweep are kept for retry");
  const sharedStorage = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(sharedStorage, /export async function deleteUnreferencedStorageObjects/,
    "the sweeper reuses the exact reference-counted deletion helper");
  assert.match(sharedStorage, /export interface StorageCleanupResult/);
});

// --- Failed-attempt throttling (HTTP 429) --------------------------------------

test("failed-attempt penalty box blocks after the limit and slides with the window", () => {
  const box = intents.createSlidingWindowPenaltyBox({ maxAttempts: 3, windowMs: 1000 });
  assert.equal(box.blocked("ip-a", 0), false);
  box.record("ip-a", 0);
  box.record("ip-a", 10);
  box.record("ip-a", 20);
  assert.equal(box.blocked("ip-a", 30), true);
  assert.equal(box.blocked("ip-a", 40), true, "blocking consults the recorded history without adding a hit");
  assert.equal(box.blocked("ip-b", 40), false, "blocks are per client address");
  assert.equal(box.blocked("ip-a", 1050), false, "the penalty window has slid past all recorded failures");
});

test("the upload endpoint throttles failed attempts before any claim and records every rejection", async () => {
  const source = await readFile(new URL("../src/media/upload-endpoint.ts", import.meta.url), "utf8");
  assert.match(source, /Too many failed upload attempts/);
  assert.match(source, /media_upload_throttled/);
  assert.match(source, /windowMs: 600_000/);
  const blockedIndex = source.indexOf("attemptPenalty.blocked(clientKey)");
  const claimIndex = source.indexOf("claimPendingMediaUploadIntent(token)");
  const arrayBufferIndex = source.indexOf("request.arrayBuffer()");
  assert.ok(blockedIndex >= 0 && blockedIndex < claimIndex, "throttling rejects requests before any intent claim");
  assert.ok(claimIndex < arrayBufferIndex, "the single-use claim still precedes byte transfer");
  const recordCalls = source.match(/attemptPenalty\.record\(clientKey\)/g) ?? [];
  assert.ok(recordCalls.length >= 4, "bad tokens, rejected payloads, unknown intents, and failures all count");
  const endpoint = await readFile(new URL("../src/config/env.ts", import.meta.url), "utf8");
  assert.match(endpoint, /mediaUploadAttemptLimit = integer\("MEDIA_UPLOAD_ATTEMPT_LIMIT", "30", 1\)/);
});
