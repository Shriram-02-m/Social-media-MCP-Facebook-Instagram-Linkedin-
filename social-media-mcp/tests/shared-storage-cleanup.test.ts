import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { dedupeStorageCandidates } = await import("../src/scheduler.js");

// --- Pure helper -------------------------------------------------------------

test("storage cleanup candidates are deduplicated by path keeping the first kind", () => {
  const deduped = dedupeStorageCandidates([
    { kind: "image", path: "scheduled/owner/aaa.jpg" },
    { kind: "video", path: "scheduled/owner/bbb.mp4" },
    { kind: "image", path: "scheduled/owner/aaa.jpg" },
    { kind: "image", path: "" },
  ]);
  assert.deepEqual(deduped, [
    { kind: "image", path: "scheduled/owner/aaa.jpg" },
    { kind: "video", path: "scheduled/owner/bbb.mp4" },
  ]);
});

// --- Reference-counted deletion (source assertions per project convention) ---

test("cleanup helper counts references in posts and media tables, honoring active statuses", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /post\.image_storage_path = ANY\(\$1::text\[\]\)/);
  assert.match(scheduler, /post\.document_storage_path = ANY\(\$1::text\[\]\)/);
  assert.match(scheduler, /media_ref\.storage_path = ANY\(\$1::text\[\]\)/);
  assert.match(scheduler, /JOIN public\.scheduled_posts AS post ON post\.id = media_ref\.post_id/);
  assert.match(scheduler, /refs\.status IN \('scheduled', 'publishing'\)/);
});

test("cleanup helper is concurrency-safe and fails safe", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  const helper = scheduler.slice(
    scheduler.indexOf("async function deleteUnreferencedStorageObjects"),
    scheduler.indexOf("export async function cancelScheduledPost"),
  );
  assert.match(helper, /BEGIN/);
  assert.match(helper, /COMMIT/);
  assert.match(helper, /pg_advisory_xact_lock/, "per-path advisory locks serialize racing cleanups");
  assert.match(helper, /sort\(\(a, b\) => a\.path\.localeCompare\(b\.path\)\)/, "sorted lock order prevents deadlocks");
  assert.match(helper, /scheduled_shared_object_cleanup_skipped/, "unverifiable references must not delete");
  const referenceIndex = helper.indexOf("const referenced = new Set");
  const deleteIndex = helper.indexOf("deleteScheduledVideo");
  const beginIndex = helper.indexOf('"BEGIN"');
  assert.ok(beginIndex >= 0 && referenceIndex > beginIndex && deleteIndex > referenceIndex, "deletes happen after the reference count");
});

test("cancel routes shared objects through the reference-counted helper", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  const cancel = scheduler.slice(
    scheduler.indexOf("export async function cancelScheduledPost"),
    scheduler.indexOf("export async function rescheduleScheduledPost"),
  );
  assert.match(cancel, /deleteUnreferencedStorageObjects\(storageObjects\)/);
  assert.doesNotMatch(cancel, /deleteScheduled(Video|Image|Document)\(/, "cancel must never delete unconditionally");
  assert.match(cancel, /unregisterScheduledMedia/, "media token registration is still cleaned up");
  assert.match(cancel, /await unlink\(file\)/, "local files remain directly deleted (never shared)");
  assert.match(cancel, /kind: "document", path: row\.document_storage_path/, "documents join the reference check");
  assert.match(cancel, /WHERE id = \$1 AND user_id = \$2 AND status = 'scheduled'/, "cancel still only applies to unclaimed posts");
});

test("scheduling failure cleanup no longer deletes shared references unconditionally", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.doesNotMatch(scheduler, /deleteScheduledImage\(imageStoragePath\)/);
  assert.doesNotMatch(scheduler, /deleteScheduledDocument\(documentFields\.documentStoragePath\)/);
  const mediaCatch = scheduler.slice(
    scheduler.indexOf("const cleanupCandidates: StorageObjectCandidate[] = ["),
    scheduler.indexOf("throw error;\n  }\n}", scheduler.indexOf("const cleanupCandidates: StorageObjectCandidate[] = [")),
  );
  assert.match(mediaCatch, /deleteUnreferencedStorageObjects\(cleanupCandidates\)/);
  assert.match(scheduler, /Reference-counted cleanup: the row inserts rolled back/);
});

test("publishing still retrieves shared media through the stored permanent paths", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /await downloadScheduledImage\(job\.imageStoragePath\)/, "LinkedIn publish download");
  assert.match(scheduler, /await downloadScheduledVideo\(videoItem\.storagePath\)/, "video publish download");
  assert.match(scheduler, /await createScheduledImageUrl\(job\.imageStoragePath\)/, "Meta publish fresh signed URL");
  assert.match(scheduler, /await downloadScheduledDocument\(job\.documentStoragePath\)/, "document publish download");
  assert.doesNotMatch(scheduler, /deleteScheduled.*publishing/, "no publish path deletes storage objects");
});

test("ownership validation and legacy flat paths are preserved", async () => {
  const storage = await readFile(new URL("../src/storage/scheduled-images.ts", import.meta.url), "utf8");
  assert.match(storage, /export function storageOwnerSegment/);
  assert.match(storage, /export function isOwnedStorageObjectPath/);
  assert.match(storage, /export function assertOwnedStorageObjectPath/);
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.match(scheduler, /assertOwnedStorageObjectPath\(imageInput\.storagePath, ownerId\)/, "scheduling input validation unchanged");
  assert.match(scheduler, /assertOwnedStorageObjectPath\(item\.storagePath, ownerId\)/, "media input validation unchanged");
  const helper = scheduler.slice(
    scheduler.indexOf("async function deleteUnreferencedStorageObjects"),
    scheduler.indexOf("export function dedupeStorageCandidates"),
  );
  const cleanup = scheduler.slice(
    scheduler.indexOf("async function deleteUnreferencedStorageObjects"),
    scheduler.indexOf("export async function cancelScheduledPost"),
  );
  assert.doesNotMatch(cleanup, /isOwnedStorageObjectPath|storageFilePattern/, "deletion keys on the stored path string (legacy paths included)");
  assert.doesNotMatch(helper, /isOwnedStorageObjectPath|storageFilePattern/);
});
