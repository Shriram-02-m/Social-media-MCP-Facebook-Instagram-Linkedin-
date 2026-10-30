import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env["SUPABASE_URL"] = "https://example-project.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-service-role-key";
process.env["SCHEDULE_IMAGE_TIMEOUT_MS"] = "1000";
process.env["SCHEDULE_IMAGE_MAX_BYTES"] = "1024";
process.env["SCHEDULE_VIDEO_MAX_BYTES"] = "1048576";
process.env["SCHEDULE_IMAGE_RETRY_BASE_DELAY_MS"] = "0";
process.env["SCHEDULE_IMAGE_RETRY_MAX_DELAY_MS"] = "0";
process.env["SCHEDULE_SIGNED_URL_TTL_SECONDS"] = "86400";
const storage = await import("../src/storage/scheduled-images.js");
const scheduler = await import("../src/scheduler.js");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const ownerObject = (owner: string, extension = ".png") =>
  `scheduled/${owner}/${"a".repeat(48)}${extension}`;

async function withFetch(
  mock: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("schedules 24 hours and several days ahead, because media is a permanent path", () => {
  const now = Date.UTC(2026, 0, 1, 12, 0, 0);
  const in24Hours = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const inSevenDays = new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString();

  assert.doesNotThrow(() => scheduler.assertFutureScheduleTime(in24Hours, now));
  assert.doesNotThrow(() => scheduler.assertFutureScheduleTime(inSevenDays, now));
  assert.throws(() => scheduler.assertFutureScheduleTime(new Date(now - 1000).toISOString(), now), /future/);
  assert.throws(() => scheduler.assertFutureScheduleTime("not-a-date", now), /future/);
});

test("storage objects are namespaced by user and the segment is always path-safe", () => {
  assert.equal(storage.storageOwnerSegment("alice"), "alice");
  assert.match(storage.storageOwnerSegment("user/../../etc"), /^[a-f0-9]{32}$/);
  assert.match(storage.storageOwnerSegment(""), /^[a-f0-9]{32}$/);

  const owned = ownerObject("alice");
  assert.equal(storage.isOwnedStorageObjectPath(owned, "alice"), true);
  assert.equal(storage.isOwnedStorageObjectPath(owned, "bob"), false);
  assert.throws(() => storage.assertOwnedStorageObjectPath(owned, "bob"), /does not belong to this account/);
});

test("an expiring signed URL can never become the durable media reference", () => {
  const expiredSignedUrl = "https://example-project.supabase.co/storage/v1/object/sign/social-media-images/scheduled/alice/x.png?token=expired";
  assert.equal(storage.isOwnedStorageObjectPath(expiredSignedUrl, "alice"), false);
  assert.throws(() => storage.assertOwnedStorageObjectPath(expiredSignedUrl, "alice"), /does not belong/);

  // Traversal and absolute paths are rejected even with a matching prefix.
  assert.equal(storage.isOwnedStorageObjectPath("scheduled/alice/../bob/x.png", "alice"), false);
  assert.equal(storage.isOwnedStorageObjectPath("/scheduled/alice/" + "a".repeat(48) + ".png", "alice"), false);
});

test("a job scheduled days earlier retrieves the same object and signs a fresh URL at publish time", async () => {
  const objectPath = ownerObject("alice");
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];

  await withFetch(async (input, init) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body });
    if (init?.method === "POST") {
      // A brand-new signed URL is created now, not at scheduling time.
      return Response.json({ signedURL: `/storage/v1/object/sign/social-media-images/${objectPath}?token=fresh` });
    }
    return new Response(png, {
      status: 200,
      headers: { "content-type": "image/png", "content-length": String(png.length) },
    });
  }, async () => {
    const image = await storage.downloadScheduledImage(objectPath);
    assert.equal(image.contentType, "image/png");
    assert.equal(image.bytes.length, png.length);

    // The download used the permanent private object path with server-side
    // credentials; it never carried an expired URL token.
    const download = requests[0]!;
    assert.equal(download.url, `https://example-project.supabase.co/storage/v1/object/social-media-images/${objectPath}`);
    assert.ok(!download.url.includes("token="));

    const url = await storage.createScheduledImageUrl(objectPath);
    assert.match(url, /\?token=fresh$/);
    assert.deepEqual(JSON.parse(String(requests[1]?.body)), { expiresIn: 86400 });
  });
});

test("publish and retry resolve the same permanent storage path", async () => {
  const source = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  // The worker downloads the stored object (server-side credentials) and only
  // creates a signed URL at publish time, for platforms that need one.
  assert.match(source, /downloadScheduledImage\(job\.imageStoragePath\)/);
  assert.match(source, /createScheduledImageUrl\(job\.imageStoragePath\)/);
  assert.match(source, /downloadScheduledVideo\(videoItem\.storagePath\)/);
  assert.match(source, /downloadScheduledDocument\(job\.documentStoragePath\)/);

  // Caller-supplied references are ownership-checked before use.
  assert.match(source, /assertOwnedStorageObjectPath\(imageInput\.storagePath, ownerId\)/);
  assert.match(source, /assertOwnedStorageObjectPath\(item\.storagePath, ownerId\)/);
  assert.match(source, /assertOwnedStorageObjectPath\(document\.storagePath, ownerId\)/);

  // New uploads are namespaced by the authenticated owner.
  assert.match(source, /uploadScheduledImage\(imageBytes, contentType, extension, ownerId\)/);
  assert.match(source, /uploadScheduledVideo\(bytes, item\.contentType, item\.extension\.toLowerCase\(\), ownerId\)/);
  assert.match(source, /uploadScheduledDocument\(documentBytes, documentContentType, "\.pdf", ownerId\)/);

  // The durable reference stored in PostgreSQL is the object path, never a URL.
  assert.match(source, /image_storage_path, content_type/);
  assert.match(source, /storage_path, content_type, created_at/);

  // Retrying reuses the existing row/media and must not clear the reference.
  const retryStart = source.indexOf("export async function retryScheduledPost");
  const retryEnd = source.indexOf("export async function cancelScheduledPost");
  assert.ok(retryStart >= 0 && retryEnd > retryStart);
  const retrySource = source.slice(retryStart, retryEnd);
  assert.doesNotMatch(retrySource, /image_storage_path\s*=\s*NULL|storage_path\s*=\s*NULL/i);
  assert.match(retrySource, /SET status = 'scheduled'/);
});

test("upload API returns the permanent path and scopes the object to the signed-in user", async () => {
  const route = await readFile(
    new URL("../../social-media-web/src/app/api/media/upload/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(route, /const session = await requireApiSession\(\)/);
  assert.match(route, /session\.user\.id/);
  assert.match(route, /uploadScheduledVideo/);
  assert.match(route, /storagePath,/);
  assert.match(route, /expiresInSeconds/);
  assert.doesNotMatch(route, /NEXT_PUBLIC_.*SUPABASE/);
});