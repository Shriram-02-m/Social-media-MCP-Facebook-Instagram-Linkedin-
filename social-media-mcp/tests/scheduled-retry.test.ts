import assert from "node:assert/strict";
import test from "node:test";
import { canSafelyRetryScheduledPost } from "../src/scheduler.js";

test("only pre-publish image or token validation failures can be manually retried safely", () => {
  assert.equal(canSafelyRetryScheduledPost("failed", "image_validation"), true);
  assert.equal(canSafelyRetryScheduledPost("failed", "token_validation"), true);
  assert.equal(canSafelyRetryScheduledPost("failed", "publishing"), false);
  assert.equal(canSafelyRetryScheduledPost("failed", undefined), false);
  assert.equal(canSafelyRetryScheduledPost("scheduled", "image_validation"), false);
  assert.equal(canSafelyRetryScheduledPost("publishing", "image_validation"), false);
  assert.equal(canSafelyRetryScheduledPost("published", "image_validation"), false);
});
