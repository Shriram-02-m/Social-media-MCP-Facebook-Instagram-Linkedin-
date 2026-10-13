import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLinkedInScopes } from "../src/platforms/linkedin.js";

test("normalizes LinkedIn scopes returned as a comma-separated string", () => {
  assert.deepEqual(
    normalizeLinkedInScopes(["openid,profile,w_member_social"]),
    ["openid", "profile", "w_member_social"],
  );
});

test("normalizes LinkedIn scopes returned as whitespace-separated values", () => {
  assert.deepEqual(
    normalizeLinkedInScopes(["openid profile w_member_social"]),
    ["openid", "profile", "w_member_social"],
  );
});
