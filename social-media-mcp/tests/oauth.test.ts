import assert from "node:assert/strict";
import test from "node:test";
import { instagramPermissionScopes } from "../src/auth/oauth.js";

test("normalizes Instagram permissions returned as a comma-delimited string", () => {
  assert.deepEqual(
    instagramPermissionScopes("instagram_business_basic,instagram_business_content_publish"),
    ["instagram_business_basic", "instagram_business_content_publish"],
  );
});

test("normalizes Instagram permissions returned as an array", () => {
  assert.deepEqual(
    instagramPermissionScopes(["instagram_business_basic", "instagram_business_content_publish"]),
    ["instagram_business_basic", "instagram_business_content_publish"],
  );
});

test("normalizes comma-delimited permissions within an array", () => {
  assert.deepEqual(
    instagramPermissionScopes(["instagram_business_basic, instagram_business_content_publish"]),
    ["instagram_business_basic", "instagram_business_content_publish"],
  );
});

test("returns no scopes when Instagram omits permissions", () => {
  assert.deepEqual(instagramPermissionScopes(undefined), []);
});
