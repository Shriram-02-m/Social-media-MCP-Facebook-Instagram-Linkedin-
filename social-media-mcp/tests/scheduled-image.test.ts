import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  validateScheduledImage,
  validateScheduledImageWithRetries,
} from "../src/utils/scheduled-image.js";

const imageToken = "a".repeat(64);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

async function fixture(): Promise<{ imagePath: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "scheduled-image-test-"));
  const imagePath = path.join(directory, "image.jpg");
  await writeFile(imagePath, jpegBytes);
  return { imagePath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function startServer(handler: (server: Server) => void): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer();
  handler(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not determine test server port.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function imageResponse(bytes: Uint8Array = jpegBytes, contentType = "image/jpeg", status = 200): Response {
  return new Response(bytes, { status, headers: { "content-type": contentType } });
}

test("validates the local route and dynamically configured public image URL", async () => {
  const file = await fixture();
  const requestedUrls: string[] = [];
  try {
    const validation = await validateScheduledImage({
      imagePath: file.imagePath,
      imageToken,
      contentType: "image/jpeg",
      checkPublic: true,
      localBaseUrl: "http://127.0.0.1:43127",
      publicBaseUrl: "https://changed-tunnel.example",
      fetcher: async (input) => {
        requestedUrls.push(String(input));
        return imageResponse();
      },
    });
    assert.equal(validation.valid, true);
    assert.equal(validation.local.status, 200);
    assert.equal(validation.local.bytes, jpegBytes.byteLength);
    assert.equal(validation.public?.valid, true);
    assert.deepEqual(requestedUrls, [
      `http://127.0.0.1:43127/scheduled-media/${imageToken}`,
      `https://changed-tunnel.example/scheduled-media/${imageToken}`,
    ]);
  } finally {
    await file.cleanup();
  }
});

test("reports an incorrect local image-server port as a retryable connection failure", async () => {
  const file = await fixture();
  const unused = await startServer((server) => {
    server.on("request", (_request, response) => response.end());
  });
  await unused.close();
  try {
    const validation = await validateScheduledImage({
      imagePath: file.imagePath,
      imageToken,
      contentType: "image/jpeg",
      checkPublic: false,
      localBaseUrl: unused.baseUrl,
      timeoutMs: 1000,
    });
    assert.equal(validation.valid, false);
    assert.equal(validation.retryable, true);
    assert.match(validation.error ?? "", /connection refused|request failed/i);
  } finally {
    await file.cleanup();
  }
});

test("detects an image route 404 and does not inspect the public tunnel", async () => {
  const file = await fixture();
  const requestedUrls: string[] = [];
  try {
    const validation = await validateScheduledImage({
      imagePath: file.imagePath,
      imageToken,
      contentType: "image/jpeg",
      checkPublic: true,
      localBaseUrl: "http://127.0.0.1:43128",
      publicBaseUrl: "https://old-tunnel.example",
      fetcher: async (input) => {
        requestedUrls.push(String(input));
        return new Response("<html>Not found</html>", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      },
    });
    assert.equal(validation.valid, false);
    assert.equal(validation.local.status, 404);
    assert.equal(validation.retryable, false);
    assert.match(validation.error ?? "", /HTTP 404/);
    assert.equal(requestedUrls.length, 1);
  } finally {
    await file.cleanup();
  }
});

test("rejects HTML, invalid MIME types, and empty image bodies", async () => {
  const file = await fixture();
  try {
    for (const [response, expected] of [
      [new Response("<html>ngrok error</html>", { headers: { "content-type": "text/html" } }), /invalid image MIME type/],
      [imageResponse(jpegBytes, "image/webp"), /invalid image MIME type/],
      [imageResponse(Buffer.alloc(0)), /empty image response/],
      [imageResponse(Buffer.from("<html>error</html>")), /not valid image\/jpeg image data/],
    ] as const) {
      const validation = await validateScheduledImage({
        imagePath: file.imagePath,
        imageToken,
        contentType: "image/jpeg",
        checkPublic: false,
        localBaseUrl: "http://127.0.0.1:43129",
        fetcher: async () => response.clone(),
      });
      assert.equal(validation.valid, false);
      assert.match(validation.error ?? "", expected);
    }
  } finally {
    await file.cleanup();
  }
});

test("bounds image response size and identifies request timeouts", async () => {
  const file = await fixture();
  try {
    const oversized = await validateScheduledImage({
      imagePath: file.imagePath,
      imageToken,
      contentType: "image/jpeg",
      checkPublic: false,
      localBaseUrl: "http://127.0.0.1:43130",
      maxBytes: 5,
      fetcher: async () => imageResponse(),
    });
    assert.match(oversized.error ?? "", /exceeds the configured 5-byte size limit/);
    assert.equal(oversized.retryable, false);

    const timeout = await validateScheduledImage({
      imagePath: file.imagePath,
      imageToken,
      contentType: "image/jpeg",
      checkPublic: false,
      localBaseUrl: "http://127.0.0.1:43131",
      fetcher: async () => { throw new DOMException("Timed out", "TimeoutError"); },
    });
    assert.match(timeout.error ?? "", /timed out/i);
    assert.equal(timeout.retryable, true);
  } finally {
    await file.cleanup();
  }
});

test("retries temporary tunnel failures with exponential backoff and stops after recovery", async () => {
  const file = await fixture();
  let publicRequests = 0;
  const delays: number[] = [];
  try {
    const result = await validateScheduledImageWithRetries(
      {
        imagePath: file.imagePath,
        imageToken,
        contentType: "image/jpeg",
        checkPublic: true,
        localBaseUrl: "http://127.0.0.1:43132",
        publicBaseUrl: "https://new-tunnel.example",
        fetcher: async (input) => {
          if (String(input).startsWith("https://")) {
            publicRequests += 1;
            return publicRequests < 3
              ? new Response("temporarily unavailable", { status: 503 })
              : imageResponse();
          }
          return imageResponse();
        },
      },
      3,
      10,
      () => undefined,
      30000,
      async (delayMs) => { delays.push(delayMs); },
    );
    assert.equal(result.validation.valid, true);
    assert.equal(result.retries, 2);
    assert.equal(publicRequests, 3);
    assert.deepEqual(delays, [10, 20]);
  } finally {
    await file.cleanup();
  }
});

test("bounds retries for ngrok 404 failures from an unavailable or outdated public URL", async () => {
  const file = await fixture();
  let publicRequests = 0;
  const delays: number[] = [];
  try {
    await assert.rejects(
      validateScheduledImageWithRetries(
        {
          imagePath: file.imagePath,
          imageToken,
          contentType: "image/jpeg",
          checkPublic: true,
          localBaseUrl: "http://127.0.0.1:43133",
          publicBaseUrl: "https://stale-tunnel.example",
          fetcher: async (input) => {
            if (String(input).startsWith("https://")) {
              publicRequests += 1;
              return new Response("<html>ngrok 404</html>", {
                status: 404,
                headers: { "content-type": "text/html" },
              });
            }
            return imageResponse();
          },
        },
        3,
        10,
        () => undefined,
        30000,
        async (delayMs) => { delays.push(delayMs); },
      ),
      /failed after 3 attempt\(s\).*HTTP 404/,
    );
    assert.equal(publicRequests, 3);
    assert.deepEqual(delays, [10, 20]);
  } finally {
    await file.cleanup();
  }
});

test("checks an actual local image route bound to the configured local port", async () => {
  const file = await fixture();
  const requestedPaths: string[] = [];
  const local = await startServer((server) => {
    server.on("request", (request, response) => {
      requestedPaths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "image/jpeg" });
      response.end(jpegBytes);
    });
  });
  try {
    const validation = await validateScheduledImage({
      imagePath: file.imagePath,
      imageToken,
      contentType: "image/jpeg",
      checkPublic: false,
      localBaseUrl: local.baseUrl,
    });
    assert.equal(validation.valid, true);
    assert.deepEqual(requestedPaths, [`/scheduled-media/${imageToken}`]);
  } finally {
    await local.close();
    await file.cleanup();
  }
});
