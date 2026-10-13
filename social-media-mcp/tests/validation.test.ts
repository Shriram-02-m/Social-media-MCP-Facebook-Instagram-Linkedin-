import assert from "node:assert/strict";
import test from "node:test";
import {
  platformImageRequirements,
  validateImageUrl,
  validateLinkedInAuthorUrn,
  validatePostContent,
} from "../src/utils/validation.js";

test("requires publicly fetchable HTTPS media URLs", () => {
  assert.equal(validateImageUrl("https://cdn.example.com/image.jpg"), undefined);
  assert.match(validateImageUrl("http://cdn.example.com/image.jpg") ?? "", /HTTPS/);
  assert.match(validateImageUrl("not-a-url") ?? "", /absolute URL/);
});

test("validates LinkedIn author URNs", () => {
  assert.equal(validateLinkedInAuthorUrn("urn:li:person:abc_123"), undefined);
  assert.equal(validateLinkedInAuthorUrn("urn:li:organization:12345"), undefined);
  assert.match(validateLinkedInAuthorUrn("urn:li:share:123") ?? "", /author/);
});

test("enforces platform image requirements and accepts non-empty text", () => {
  assert.deepEqual(platformImageRequirements("instagram"), [
    "Instagram Graph API feed publishing requires an image URL; text-only posts are not supported.",
  ]);
  assert.deepEqual(platformImageRequirements("linkedin", "https://example.com/a.jpg"), [
    "LinkedIn image posts require a local imagePath for the official image-upload flow.",
  ]);
  assert.deepEqual(validatePostContent("A test caption"), []);
  assert.deepEqual(validatePostContent(), ["Provide post text, an image URL, or an image path."]);
});