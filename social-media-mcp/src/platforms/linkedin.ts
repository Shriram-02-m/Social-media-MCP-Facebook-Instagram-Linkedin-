import { readFile } from "node:fs/promises";
import { config } from "../config/env.js";
import { loadTokens, saveTokens } from "../auth/token-store.js";
import { apiRequest } from "../utils/http.js";
import { validateLinkedInAuthorUrn } from "../utils/validation.js";
import type { LinkedInPost, PublishedPost, StoredToken } from "./types.js";

interface LinkedInProfile { sub: string; name?: string; email?: string; picture?: string }
interface LinkedInPostList { elements?: LinkedInPost[] }
interface LinkedInTokenResponse { access_token?: string; refresh_token?: string; expires_in?: number }

const restHeaders = {
  "Linkedin-Version": config.linkedinApiVersion,
  "X-Restli-Protocol-Version": "2.0.0",
};
let refreshInFlight: Promise<StoredToken> | undefined;

export async function linkedinTokenForUse(): Promise<StoredToken> {
  const vault = await loadTokens();
  const current = vault.linkedin;
  if (!current) throw new Error("LinkedIn is not connected. Start OAuth first.");
  if (current.expiresAt === undefined || current.expiresAt > Date.now() + 60_000) return current;
  if (!current.refreshToken) {
    throw new Error("LinkedIn access token is expired or about to expire and has no refresh token. Reauthorize LinkedIn.");
  }
  if (!config.linkedinClientId || !config.linkedinClientSecret) {
    throw new Error("LinkedIn token refresh requires LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET.");
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const latestVault = await loadTokens();
    const latest = latestVault.linkedin;
    if (!latest) throw new Error("LinkedIn is not connected. Start OAuth first.");
    if (latest.expiresAt === undefined || latest.expiresAt > Date.now() + 60_000) return latest;
    if (!latest.refreshToken) {
      throw new Error("LinkedIn access token is expired and has no refresh token. Reauthorize LinkedIn.");
    }
    const { data } = await apiRequest<LinkedInTokenResponse>("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: latest.refreshToken,
        client_id: config.linkedinClientId,
        client_secret: config.linkedinClientSecret,
      }),
    });
    if (!data.access_token || !data.expires_in || data.expires_in <= 0) {
      throw new Error("LinkedIn refresh did not return a valid access token and expiry. Reauthorize LinkedIn.");
    }
    const refreshed: StoredToken = {
      ...latest,
      accessToken: data.access_token,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    await saveTokens({ ...latestVault, linkedin: refreshed });
    return refreshed;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

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
  const token = await linkedinTokenForUse();
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
  const token = await linkedinTokenForUse();
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

async function uploadImage(
  token: string,
  author: string,
  imagePath?: string,
  imageData?: { bytes: Buffer; contentType: string },
): Promise<string> {
  const image = imageData?.bytes ?? (imagePath ? await readFile(imagePath) : undefined);
  if (!image) throw new Error("A LinkedIn image path or image buffer is required.");
  if (!image.byteLength) throw new Error("The selected LinkedIn image file is empty.");
  const mimeType = imageData?.contentType ?? (imagePath?.toLowerCase().endsWith(".png")
    ? "image/png"
    : imagePath?.toLowerCase().endsWith(".gif") ? "image/gif" : "image/jpeg");
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
  const imageBody = new ArrayBuffer(image.byteLength);
  new Uint8Array(imageBody).set(image);
  const response = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": mimeType }, body: imageBody });
  if (!response.ok) throw new Error(`LinkedIn image upload failed with HTTP ${response.status}.`);
  return imageUrn;
}

async function publishLinkedInInternal(
  text: string | undefined,
  imagePath: string | undefined,
  requestedAuthor: string | undefined,
  imageData?: { bytes: Buffer; contentType: string },
): Promise<PublishedPost> {
  const token = await linkedinTokenForUse();
  const author = authorUrn(requestedAuthor, token.accountId);
  const writeScope = author.startsWith("urn:li:organization:") ? "w_organization_social" : "w_member_social";
  if (!normalizeLinkedInScopes(token.scopes).includes(writeScope)) {
    throw new Error(`LinkedIn publishing requires the granted ${writeScope} scope. Check your app's approved LinkedIn product and reconnect.`);
  }
  const imageUrn = imagePath || imageData
    ? await uploadImage(token.accessToken, author, imagePath, imageData)
    : undefined;
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

export async function publishLinkedIn(text?: string, imagePath?: string, requestedAuthor?: string): Promise<PublishedPost> {
  return publishLinkedInInternal(text, imagePath, requestedAuthor);
}

export async function publishLinkedInWithImage(
  text: string | undefined,
  bytes: Buffer,
  contentType: string,
  requestedAuthor?: string,
): Promise<PublishedPost> {
  return publishLinkedInInternal(text, undefined, requestedAuthor, { bytes, contentType });
}