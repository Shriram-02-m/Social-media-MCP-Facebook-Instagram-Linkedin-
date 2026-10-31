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

test("remote image inputs accept only validated HTTPS URLs", () => {
  for (const url of ["https://cdn.example.com/a.png", "https://8.8.8.8/a.jpg"]) {
    assert.equal(validateImageUrl(url), undefined, `${url} should be accepted`);
  }
  for (const url of ["http://cdn.example.com/a.png", "ftp://cdn.example.com/a.png", "file:///etc/passwd"]) {
    assert.match(validateImageUrl(url) ?? "", /HTTPS/, `${url} should be rejected`);
  }
});

test("validates LinkedIn author URNs", () => {
  assert.equal(validateLinkedInAuthorUrn("urn:li:person:abc_123"), undefined);
  assert.equal(validateLinkedInAuthorUrn("urn:li:organization:12345"), undefined);
  assert.match(validateLinkedInAuthorUrn("urn:li:share:123") ?? "", /author/);
});

test("enforces platform image requirements and accepts non-empty text", () => {
  assert.deepEqual(platformImageRequirements("instagram"), [
    "Instagram Graph API feed publishing requires an image reference; text-only posts are not supported.",
  ]);
  assert.deepEqual(platformImageRequirements("linkedin", "https://example.com/a.jpg"), []);
  assert.deepEqual(platformImageRequirements("linkedin", "https://example.com/a.jpg", "C:\\a.jpg"), [
    "LinkedIn uses either imagePath or imageUrl, not both.",
  ]);
  assert.deepEqual(validatePostContent("A test caption"), []);
  assert.deepEqual(validatePostContent(), [
    "Provide post text, an image URL, an image path, or an imageStoragePath.",
  ]);
});

test("permanent storage object paths satisfy platform image requirements exclusively", () => {
  assert.deepEqual(platformImageRequirements("instagram", undefined, undefined, "scheduled/owner/a.jpg"), []);
  assert.deepEqual(platformImageRequirements("facebook", undefined, undefined, "scheduled/owner/a.jpg"), []);
  assert.deepEqual(platformImageRequirements("linkedin", undefined, undefined, "scheduled/owner/a.jpg"), []);
  assert.deepEqual(platformImageRequirements("instagram", "https://example.com/a.jpg", undefined, "scheduled/owner/a.jpg"), [
    "Provide only one image reference: imageUrl, imagePath, or imageStoragePath.",
  ]);
  assert.deepEqual(platformImageRequirements("facebook", undefined, "C:\\a.jpg", "scheduled/owner/a.jpg"), [
    "Provide only one image reference: imageUrl, imagePath, or imageStoragePath.",
    "Meta publishing uses imageUrl or a storage object path; local image uploads are not implemented for this platform.",
  ]);
  assert.deepEqual(validatePostContent(undefined, undefined, undefined, "scheduled/owner/a.jpg"), []);
});