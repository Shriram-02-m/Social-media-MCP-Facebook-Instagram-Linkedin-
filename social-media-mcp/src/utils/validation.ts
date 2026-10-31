import type { Platform } from "../platforms/types.js";

export function validateImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "Image URLs must use HTTPS.";
    if (url.username || url.password) return "Image URLs must not contain embedded credentials.";
    return undefined;
  } catch {
    return "Image URL must be a valid absolute URL.";
  }
}

export function validateLinkedInAuthorUrn(value: string): string | undefined {
  return /^urn:li:(person|organization):[A-Za-z0-9_-]+$/.test(value)
    ? undefined
    : "LinkedIn author must be a person or organization URN.";
}

export function platformImageRequirements(
  platform: Platform,
  imageUrl?: string,
  imagePath?: string,
  imageStoragePath?: string,
): string[] {
  const issues: string[] = [];
  const hasImageReference = Boolean(imageUrl ?? imagePath ?? imageStoragePath);
  if (platform === "instagram" && !hasImageReference) {
    issues.push("Instagram Graph API feed publishing requires an image reference; text-only posts are not supported.");
  }
  if (imageStoragePath && (imageUrl || imagePath)) {
    issues.push("Provide only one image reference: imageUrl, imagePath, or imageStoragePath.");
  }
  if (platform === "linkedin" && imagePath && imageUrl) {
    issues.push("LinkedIn uses either imagePath or imageUrl, not both.");
  }
  if (platform !== "linkedin" && imagePath) {
    issues.push("Meta publishing uses imageUrl or a storage object path; local image uploads are not implemented for this platform.");
  }
  if (imageUrl) {
    const issue = validateImageUrl(imageUrl);
    if (issue) issues.push(issue);
  }
  return issues;
}

export function validatePostContent(
  text?: string,
  imageUrl?: string,
  imagePath?: string,
  imageStoragePath?: string,
): string[] {
  const hasContent = text?.trim() || imageUrl || imagePath || imageStoragePath;
  return hasContent ? [] : ["Provide post text, an image URL, an image path, or an imageStoragePath."];
}