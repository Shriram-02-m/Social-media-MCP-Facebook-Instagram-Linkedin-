import { readFile } from "node:fs/promises";
import { config } from "../config/env.js";
import { loadTokens } from "../auth/token-store.js";
import { apiRequest } from "../utils/http.js";
import { validateLinkedInAuthorUrn } from "../utils/validation.js";
import type { LinkedInPost, PublishedPost } from "./types.js";

interface LinkedInProfile { sub: string; name?: string; email?: string; picture?: string }
interface LinkedInPostList { elements?: LinkedInPost[] }

const restHeaders = {
  "Linkedin-Version": config.linkedinApiVersion,
  "X-Restli-Protocol-Version": "2.0.0",
};

export function normalizeLinkedInScopes(scopes: string[]): string[] {
  return [...new Set(scopes.flatMap((scope) => scope.split(/[,\s]+/)).filter(Boolean))];
}

function authorUrn(input?: string, accountId?: string): string {
  const author = input || config.linkedinAuthorUrn || (accountId ? `urn:li:person:${accountId}` : "");
  if (!author) throw new Error("Set LINKEDIN_AUTHOR_URN or provide an authorUrn.");
  const issue = validateLinkedInAuthorUrn(author);
  if (issue) throw new Error(issue);
  return author;
}

export async function linkedinConnectionStatus(): Promise<Record<string, unknown>> {
  const token = (await loadTokens()).linkedin;
  if (!token) return { platform: "linkedin", connected: false, reason: "Authorize this LinkedIn app first." };
  const scopes = normalizeLinkedInScopes(token.scopes);
  try {
    const { data } = await apiRequest<LinkedInProfile>("https://api.linkedin.com/v2/userinfo", { accessToken: token.accessToken });
    return {
      platform: "linkedin",
      connected: true,
      accountName: data.name ?? token.accountName,
      grantedScopes: scopes,
      expiresAt: token.expiresAt,
      tokenExpired: token.expiresAt !== undefined && token.expiresAt <= Date.now(),
      memberPublishingAvailable: scopes.includes("w_member_social"),
      organizationPublishingAvailable: scopes.includes("w_organization_social"),
      organizationReadingAvailable: scopes.includes("r_organization_social"),
      memberPostReadingAvailable: scopes.includes("r_member_social"),
    };
  } catch (error) {
    return { platform: "linkedin", connected: false, reason: error instanceof Error ? error.message : "Token validation failed." };
  }
}

export async function linkedinAccountInfo(author?: string): Promise<Record<string, unknown>> {
  const token = (await loadTokens()).linkedin;
  if (!token) throw new Error("LinkedIn is not connected. Start OAuth first.");
  const { data } = await apiRequest<LinkedInProfile>("https://api.linkedin.com/v2/userinfo", { accessToken: token.accessToken });
  const scopes = normalizeLinkedInScopes(token.scopes);
  return {
    platform: "linkedin",
    memberId: data.sub,
    name: data.name ?? token.accountName,
    ...(author ? { selectedAuthorUrn: authorUrn(author, data.sub) } : {}),
    grantedScopes: scopes,
  };
}

export async function readLinkedInPosts(count: number, author?: string): Promise<LinkedInPost[]> {
  const token = (await loadTokens()).linkedin;
  if (!token) throw new Error("LinkedIn is not connected. Start OAuth first.");
  const selectedAuthor = authorUrn(author, token.accountId);
  const readScope = selectedAuthor.startsWith("urn:li:organization:") ? "r_organization_social" : "r_member_social";
  if (!normalizeLinkedInScopes(token.scopes).includes(readScope)) {
    throw new Error(`LinkedIn post reading requires ${readScope}, which is not granted to this app. LinkedIn restricts r_member_social to approved users.`);
  }
  const query = new URLSearchParams({
    author: selectedAuthor,
    q: "author",
    count: String(count),
    sortBy: "CREATED",
  });
  const { data } = await apiRequest<LinkedInPostList>(`https://api.linkedin.com/rest/posts?${query}`, {
    accessToken: token.accessToken,
    headers: restHeaders,
  });
  return data.elements ?? [];
}

function confirmedId(response: Response): string {
  const id = response.headers.get("x-restli-id");
  if (!id) throw new Error("LinkedIn returned success without x-restli-id; publication is unconfirmed.");
  return id;
}

async function uploadImage(token: string, author: string, imagePath: string): Promise<string> {
  const image = await readFile(imagePath);
  if (!image.byteLength) throw new Error("The selected LinkedIn image file is empty.");
  const mimeType = imagePath.toLowerCase().endsWith(".png")
    ? "image/png"
    : imagePath.toLowerCase().endsWith(".gif") ? "image/gif" : "image/jpeg";
  const initialized = await apiRequest<{ value?: { uploadUrl?: string; image?: string } }>(
    "https://api.linkedin.com/rest/images?action=initializeUpload",
    {
      method: "POST",
      headers: { ...restHeaders, "content-type": "application/json" },
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
      accessToken: token,
    },
  );
  const uploadUrl = initialized.data.value?.uploadUrl;
  const imageUrn = initialized.data.value?.image;
  if (!uploadUrl || !imageUrn) throw new Error("LinkedIn did not return an image upload URL and image URN.");
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": mimeType }, body: image });
  if (!response.ok) throw new Error(`LinkedIn image upload failed with HTTP ${response.status}.`);
  return imageUrn;
}

export async function publishLinkedIn(text?: string, imagePath?: string, requestedAuthor?: string): Promise<PublishedPost> {
  const token = (await loadTokens()).linkedin;
  if (!token) throw new Error("LinkedIn is not connected. Start OAuth first.");
  const author = authorUrn(requestedAuthor, token.accountId);
  const writeScope = author.startsWith("urn:li:organization:") ? "w_organization_social" : "w_member_social";
  if (!normalizeLinkedInScopes(token.scopes).includes(writeScope)) {
    throw new Error(`LinkedIn publishing requires the granted ${writeScope} scope. Check your app's approved LinkedIn product and reconnect.`);
  }
  const imageUrn = imagePath ? await uploadImage(token.accessToken, author, imagePath) : undefined;
  const post = {
    author,
    commentary: text ?? "",
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(imageUrn ? { content: { media: { id: imageUrn } } } : {}),
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  const { response } = await apiRequest("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: { ...restHeaders, "content-type": "application/json" },
    body: JSON.stringify(post),
    accessToken: token.accessToken,
  });
  return { platform: "linkedin", id: confirmedId(response), confirmed: true };
}