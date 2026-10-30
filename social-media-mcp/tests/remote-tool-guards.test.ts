import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard: every remote media tool must reject local paths, and the
// only local filesystem read in the tool layer must sit behind that guard.

test("all remote media tools call the local-path guard", async () => {
  const register = await readFile(new URL("../src/tools/register.ts", import.meta.url), "utf8");

  const guardCalls = register.match(/rejectRemoteLocalPaths\(remote/g) ?? [];
  assert.equal(
    guardCalls.length,
    3,
    "social_publish, social_schedule_posts, and social_schedule_media must each call the guard",
  );

  for (const field of ["imagePath", "documentPath", "mediaPaths"]) {
    assert.match(register, new RegExp(field), `${field} must be passed to the guard`);
  }
});

test("the only tool-level readFile sits after the remote path guard", async () => {
  const register = await readFile(new URL("../src/tools/register.ts", import.meta.url), "utf8");

  const readFileCalls = register.match(/await readFile\(/g) ?? [];
  assert.equal(readFileCalls.length, 1, "only the stdio media[].path branch may read a file");

  const guardIndex = register.indexOf("rejectRemoteLocalPaths(remote, { documentPath, mediaPaths");
  const readFileIndex = register.indexOf("await readFile(item.path)");
  assert.ok(guardIndex >= 0, "the media tool guard must be present");
  assert.ok(readFileIndex > guardIndex, "readFile must run only after the remote path guard");
});