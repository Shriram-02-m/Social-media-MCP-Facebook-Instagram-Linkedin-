import assert from "node:assert/strict";
import test from "node:test";
import { REMOTE_MEDIA_HINT, rejectRemoteLocalPaths } from "../src/tools/media-input.js";

// Verified behavior (MCP specification + modelcontextprotocol discussion #1197):
// tool arguments are JSON and the published protocol has no client-to-server
// file-upload primitive. Claude.ai therefore cannot hand the Render worker image
// bytes or a readable local path. Remote tools must accept only HTTPS URLs.

test("remote mode rejects imagePath before any filesystem read", () => {
  assert.throws(
    () => rejectRemoteLocalPaths(true, { imagePath: "/etc/passwd" }),
    /imagePath[\s\S]*remote MCP/i,
  );
});

test("remote mode rejects documentPath", () => {
  assert.throws(
    () => rejectRemoteLocalPaths(true, { documentPath: "C:\\secrets\\report.pdf" }),
    /documentPath[\s\S]*remote MCP/i,
  );
});

test("remote mode rejects any media[].path", () => {
  assert.throws(
    () => rejectRemoteLocalPaths(true, { mediaPaths: [undefined, "/etc/shadow"] }),
    /media\[\]\.path[\s\S]*remote MCP/i,
  );
});

test("remote mode accepts URL-only media arguments", () => {
  assert.doesNotThrow(() => rejectRemoteLocalPaths(true, {}));
  assert.doesNotThrow(() => rejectRemoteLocalPaths(true, {
    imagePath: undefined,
    documentPath: undefined,
    mediaPaths: [undefined, undefined],
  }));
});

test("local stdio mode keeps local file support", () => {
  assert.doesNotThrow(() => rejectRemoteLocalPaths(false, {
    imagePath: "/tmp/image.png",
    documentPath: "/tmp/document.pdf",
    mediaPaths: ["/tmp/image.png", "/tmp/video.mp4"],
  }));
});

test("remote rejection points callers at the HTTPS upload fallback", () => {
  assert.throws(
    () => rejectRemoteLocalPaths(true, { imagePath: "/etc/passwd" }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("HTTPS") && /upload/i.test(message) && message.includes(REMOTE_MEDIA_HINT);
    },
  );
});