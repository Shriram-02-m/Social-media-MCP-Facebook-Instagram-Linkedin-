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
const storage = await import("../src/storage/scheduled-images.js");

const mp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from("ftypmp42", "ascii"),
  Buffer.alloc(8, 0),
]);

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

test("media schema migration adds media_type, child media table, and video bucket types", async () => {
  const migration = await readFile(new URL("../migrations/006_scheduled_post_media.sql", import.meta.url), "utf8");

  assert.match(migration, /ADD COLUMN IF NOT EXISTS media_type TEXT/i);
  assert.match(migration, /'carousel'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.scheduled_post_media/i);
  assert.match(migration, /REFERENCES public\.scheduled_posts\(id\) ON DELETE CASCADE/i);
  assert.match(migration, /CHECK \(kind IN \('image', 'video'\)\)/i);
  assert.match(migration, /UNIQUE \(post_id, position\)/i);
  assert.match(migration, /video\/mp4/);
  assert.match(migration, /file_size_limit = 52428800/);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN)\b/i);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b/i);
});

test("database migration runner applies the scheduled-post media migration", async () => {
  const runner = await readFile(new URL("../src/database-migrations.ts", import.meta.url), "utf8");
  assert.match(runner, /006_scheduled_post_media\.sql/);
});

test("scheduler schedules media posts and dispatches video and carousel publishing", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.ts", import.meta.url), "utf8");

  assert.match(scheduler, /export async function scheduleMediaPosts/);
  assert.match(scheduler, /INSERT INTO public\.scheduled_post_media/);
  assert.match(scheduler, /publishFacebookVideo/);
  assert.match(scheduler, /publishInstagramReel/);
  assert.match(scheduler, /publishInstagramCarousel/);
  assert.match(scheduler, /publishLinkedInWithVideo/);
  assert.match(scheduler, /media_type/);
  assert.match(scheduler, /validateMediaBeforePublishing/);
});

test("meta platform publishers use documented video and carousel endpoints", async () => {
  const meta = await readFile(new URL("../src/platforms/meta.ts", import.meta.url), "utf8");

  assert.match(meta, /graph-video\.facebook\.com/);
  assert.match(meta, /export async function publishFacebookVideo/);
  assert.match(meta, /media_type: "REELS"/);
  assert.match(meta, /media_type: "CAROUSEL"/);
  assert.match(meta, /is_carousel_item: "true"/);
  assert.match(meta, /export async function publishInstagramCarousel/);
});

test("LinkedIn platform publisher initializes and finalizes video uploads", async () => {
  const linkedin = await readFile(new URL("../src/platforms/linkedin.ts", import.meta.url), "utf8");

  assert.match(linkedin, /rest\/videos\?action=initializeUpload/);
  assert.match(linkedin, /rest\/videos\?action=finalizeUpload/);
  assert.match(linkedin, /uploadedPartIds/);
  assert.match(linkedin, /export async function publishLinkedInWithVideo/);
});

test("isIsoBmffVideo and matchesMediaSignature accept MP4 headers and reject other data", () => {
  assert.equal(storage.isIsoBmffVideo(mp4), true);
  assert.equal(storage.isIsoBmffVideo(Buffer.from("<html>")), false);
  assert.equal(storage.matchesMediaSignature(mp4, "video/mp4"), true);
  assert.equal(storage.matchesMediaSignature(mp4, "image/png"), false);
});

test("cloud video upload stores video/mp4 objects and rejects non-video data", async () => {
  await withFetch(async (input, init) => {
    assert.match(String(input), /^https:\/\/example-project\.supabase\.co\/storage\/v1\/object\/social-media-images\/scheduled\/.+\.mp4$/);
    assert.equal((init?.headers as Record<string, string>)["content-type"], "video/mp4");
    return new Response(null, { status: 200 });
  }, async () => {
    const objectPath = await storage.uploadScheduledVideo(mp4, "video/mp4", ".mp4");
    assert.match(objectPath, /^scheduled\/[a-f0-9]+\.mp4$/);
  });

  await assert.rejects(storage.uploadScheduledVideo(Buffer.from("<html>"), "video/mp4", ".mp4"), /does not match video\/mp4/);
  await assert.rejects(storage.uploadScheduledVideo(mp4, "image/png", ".png"), /Unsupported scheduled video MIME type/);
});

test("cloud video validation reads the private object and validates the public signed URL", async () => {
  let requestNumber = 0;
  await withFetch(async (_input, init) => {
    requestNumber += 1;
    if (requestNumber === 1) {
      return new Response(mp4, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(mp4.length) } });
    }
    if (requestNumber === 2) {
      assert.equal(init?.method, "POST");
      return Response.json({ signedURL: "https://example-project.supabase.co/signed-video" });
    }
    return new Response(mp4, { status: 200, headers: { "content-type": "video/mp4", "content-length": String(mp4.length) } });
  }, async () => {
    const result = await storage.validateStoredVideo("scheduled/clip.mp4", true);
    assert.equal(result.valid, true);
    assert.equal(result.local.bytes, mp4.length);
    assert.equal(result.public?.valid, true);
    assert.equal(requestNumber, 3);
  });
});
