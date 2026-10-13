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

export function platformImageRequirements(platform: Platform, imageUrl?: string, imagePath?: string): string[] {
  const issues: string[] = [];
  if (platform === "instagram" && !imageUrl) {
    issues.push("Instagram Graph API feed publishing requires an image URL; text-only posts are not supported.");
  }
  if (platform === "linkedin" && imageUrl && !imagePath) {
    issues.push("LinkedIn image posts require a local imagePath for the official image-upload flow.");
  }
  if (platform === "linkedin" && imagePath && imageUrl) {
    issues.push("LinkedIn uses imagePath; imageUrl is for Meta publishing.");
  }
  if (platform !== "linkedin" && imagePath) {
    issues.push("Meta publishing uses imageUrl; local image uploads are not implemented for this platform.");
  }
  if (imageUrl) {
    const issue = validateImageUrl(imageUrl);
    if (issue) issues.push(issue);
  }
  return issues;
}

export function validatePostContent(text?: string, imageUrl?: string, imagePath?: string): string[] {
  return text?.trim() || imageUrl || imagePath ? [] : ["Provide post text, an image URL, or an image path."];
}