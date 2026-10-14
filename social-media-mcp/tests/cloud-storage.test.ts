import assert from "node:assert/strict";
import test from "node:test";

process.env["SUPABASE_URL"] = "https://example-project.supabase.co";
process.env["SUPABASE_SERVICE_ROLE_KEY"] = "test-service-role-key";
process.env["SCHEDULE_IMAGE_TIMEOUT_MS"] = "1000";
process.env["SCHEDULE_IMAGE_MAX_BYTES"] = "1024";
process.env["SCHEDULE_IMAGE_RETRY_BASE_DELAY_MS"] = "0";
process.env["SCHEDULE_IMAGE_RETRY_MAX_DELAY_MS"] = "0";
const storage = await import("../src/storage/scheduled-images.js");

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

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

test("cloud image upload uses configured Supabase Storage and validates image bytes", async () => {
  await withFetch(async (input, init) => {
    assert.match(String(input), /^https:\/\/example-project\.supabase\.co\/storage\/v1\/object\/social-media-images\/scheduled\/.+\.png$/);
    assert.equal((init?.headers as Record<string, string>)["authorization"], "Bearer test-service-role-key");
    assert.equal((init?.headers as Record<string, string>)["content-type"], "image/png");
    return new Response(null, { status: 200 });
  }, async () => {
    const objectPath = await storage.uploadScheduledImage(png, "image/png", ".png");
    assert.match(objectPath, /^scheduled\/[a-f0-9]+\.png$/);
  });

  await assert.rejects(storage.uploadScheduledImage(Buffer.from("<html>"), "image/png", ".png"), /does not match image\/png/);
});

test("cloud image validation checks private object and public signed URL response", async () => {
  let requestNumber = 0;
  await withFetch(async (_input, init) => {
    requestNumber += 1;
    if (requestNumber === 1) {
      assert.equal(init?.method, undefined);
      return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
    }
    if (requestNumber === 2) {
      assert.equal(init?.method, "POST");
      return Response.json({ signedURL: "/storage/v1/object/sign/social-media-images/scheduled/test.png?token=private" });
    }
    assert.match(String(_input), /^https:\/\/example-project\.supabase\.co\/storage\/v1\/object\/sign\//);
    return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
  }, async () => {
    const result = await storage.validateStoredImage("scheduled/test.png", true);
    assert.equal(result.valid, true);
    assert.equal(result.local.bytes, png.length);
    assert.equal(result.public?.valid, true);
    assert.equal(requestNumber, 3);
  });
});

test("cloud image validation distinguishes permanent HTTP 404 from transient network failures", async () => {
  let requestNumber = 0;
  await withFetch(async () => {
    requestNumber += 1;
    if (requestNumber === 1) {
      return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (requestNumber === 2) return Response.json({ signedURL: "https://example-project.supabase.co/signed" });
    return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
  }, async () => {
    const result = await storage.validateStoredImage("scheduled/missing.png", true);
    assert.equal(result.valid, false);
    assert.equal(result.public?.valid, false);
    assert.match(result.error ?? "", /HTTP 404/);
    assert.equal(result.retryable, false);
  });

  test("Storage uploads retry bounded temporary failures using the same object key", async () => {
    let requests = 0;
    let firstUrl = "";
    await withFetch(async (input, init) => {
      requests += 1;
      if (requests === 1) firstUrl = String(input);
      else assert.equal(String(input), firstUrl);
      assert.equal((init?.headers as Record<string, string>)["x-upsert"], "true");
      return new Response(null, { status: requests === 1 ? 503 : 200 });
    }, async () => {
      await storage.uploadScheduledImage(png, "image/png", ".png");
      assert.equal(requests, 2);
    });

    requests = 0;
    await withFetch(async () => {
      requests += 1;
      return new Response(null, { status: 429 });
    }, async () => {
      await assert.rejects(storage.uploadScheduledImage(png, "image/png", ".png"), /HTTP 429/);
      assert.equal(requests, 3);
    });
  });

  await withFetch(async () => {
    throw new TypeError("fetch failed");
  }, async () => {
    const result = await storage.validateStoredImage("scheduled/test.png", false);
    assert.equal(result.valid, false);
    assert.equal(result.retryable, true);
  });
});
