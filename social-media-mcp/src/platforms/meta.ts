import { config } from "../config/env.js";
import { loadTokens } from "../auth/token-store.js";
import { apiRequest, explainError } from "../utils/http.js";
import type { MetaPage, MetaPlatform, PublishedPost, StoredToken } from "./types.js";

interface MetaProfile { id?: string; user_id?: string | number; name?: string; username?: string; account_type?: string }
interface MetaMedia { id: string; caption?: string; media_type?: string; permalink?: string; timestamp?: string }
interface MetaList<T> { data?: T[] }
interface InstagramContainerStatus { status_code?: "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED"; }

function facebookGraph(path: string): string {
  return `https://graph.facebook.com/${config.metaGraphVersion}/${path}`;
}

function facebookGraphVideo(path: string): string {
  return `https://graph-video.facebook.com/${config.metaGraphVersion}/${path}`;
}

function instagramGraph(path: string): string {
  return `https://graph.instagram.com/${config.metaGraphVersion}/${path}`;
}

function pageForFacebook(pages: MetaPage[], pageId?: string): MetaPage {
  const selectedId = pageId || config.facebookPageId;
  const page = selectedId ? pages.find((entry) => entry.id === selectedId) : pages[0];
  if (!page) throw new Error("No authorized Facebook Page is available. Connect Facebook and choose an accessible Page ID.");
  if (!page.tasks.some((task) => ["CREATE_CONTENT", "MANAGE"].includes(task))) {
    throw new Error("The connected account lacks a content-management task on this Page.");
  }
  return page;
}

function selectInstagramAccountId(accountId: string | undefined, tokenAccountId: string | undefined): string {
  const selectedId = accountId || tokenAccountId;
  if (!selectedId) throw new Error("No Instagram account ID is available. Reconnect Instagram or provide instagramAccountId.");
  return selectedId;
}

export async function waitForInstagramContainer(containerId: string, accessToken: string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { data } = await apiRequest<InstagramContainerStatus>(
      instagramGraph(`${containerId}?fields=status_code`),
      { accessToken },
    );
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Instagram media container processing ended with status ${data.status_code}.`);
    }
    if (data.status_code !== "IN_PROGRESS") {
      throw new Error("Instagram returned an unknown media container processing status.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Instagram media container did not finish processing within 120 seconds.");
}

export async function metaConnectionStatus(ownerId: string, platform: MetaPlatform): Promise<Record<string, unknown>> {
  const token = (await loadTokens(ownerId))[platform];
  if (!token) return { platform, connected: false, reason: "Authorize this platform using social_authorization_start." };
  const requiredScopes = platform === "facebook"
    ? ["pages_show_list", "pages_read_engagement", "pages_manage_posts"]
    : ["instagram_business_basic", "instagram_business_content_publish"];
  const missingScopes = requiredScopes.filter((scope) => !token.scopes.includes(scope));
  try {
    const profile = platform === "facebook"
      ? await apiRequest<MetaProfile>(facebookGraph("me?fields=id,name"), { accessToken: token.accessToken })
      : await apiRequest<MetaProfile>(instagramGraph("me?fields=user_id,username"), { accessToken: token.accessToken });
    const hasPages = (token.pages ?? []).length > 0;
    return {
      platform,
      connected: true,
      tokenExpired: token.expiresAt !== undefined && token.expiresAt <= Date.now(),
      grantedPermissions: token.scopes,
      missingPermissions: missingScopes,
      ...(platform === "facebook"
        ? { accessiblePageCount: token.pages?.length ?? 0 }
        : { professionalAccountAvailable: Boolean(profile.data.user_id ?? profile.data.id) }),
      ...(platform === "facebook" && !hasPages ? { warning: "No managed Pages were returned during authorization." } : {}),
      ...(platform === "instagram" && !(profile.data.user_id ?? profile.data.id)
        ? { warning: "No Instagram professional account ID was returned by Instagram Login." }
        : {}),
    };
  } catch (error) {
    return { platform, connected: false, reason: explainError(error) };
  }
}

export async function metaAccountInfo(ownerId: string, platform: MetaPlatform): Promise<Record<string, unknown>> {
  const token = (await loadTokens(ownerId))[platform];
  if (!token) throw new Error(`${platform} is not connected. Start OAuth first.`);
  if (platform === "facebook") {
    const { data } = await apiRequest<MetaProfile>(facebookGraph("me?fields=id,name"), { accessToken: token.accessToken });
    return {
      platform,
      id: data.id,
      name: data.name,
      pages: (token.pages ?? []).map((page) => ({ id: page.id, name: page.name, tasks: page.tasks })),
    };
  }
  const { data } = await apiRequest<MetaProfile>(
    instagramGraph("me?fields=user_id,username,account_type"),
    { accessToken: token.accessToken },
  );
  return { platform, ...data, id: data.user_id ?? data.id };
}

export async function readMetaPosts(ownerId: string, platform: MetaPlatform, count: number): Promise<MetaMedia[]> {
  const token = (await loadTokens(ownerId))[platform];
  if (!token) throw new Error(`${platform} is not connected. Start OAuth first.`);
  const requiredScopes = platform === "facebook"
    ? ["pages_show_list", "pages_read_engagement"]
    : ["instagram_business_basic"];
  const missingScopes = requiredScopes.filter((scope) => !token.scopes.includes(scope));
  if (missingScopes.length) throw new Error(`The ${platform} token is missing granted permission(s): ${missingScopes.join(", ")}. Reconnect and grant them.`);
  if (platform === "facebook") {
    const page = pageForFacebook(token.pages ?? []);
    const { data } = await apiRequest<MetaList<MetaMedia>>(
      facebookGraph(`${page.id}/feed?fields=id,message,created_time,permalink_url&limit=${count}`),
      { accessToken: page.accessToken },
    );
    return data.data ?? [];
  }
  const accountId = selectInstagramAccountId(undefined, token.accountId);
  const { data } = await apiRequest<MetaList<MetaMedia>>(
    instagramGraph(`${accountId}/media?fields=id,caption,media_type,permalink,timestamp&limit=${count}`),
    { accessToken: token.accessToken },
  );
  return data.data ?? [];
}

async function requireMetaToken(ownerId: string, platform: MetaPlatform): Promise<StoredToken> {
  const token = (await loadTokens(ownerId))[platform];
  if (!token) throw new Error(`${platform} is not connected. Start OAuth first.`);
  const requiredScopes = platform === "facebook"
    ? ["pages_show_list", "pages_read_engagement", "pages_manage_posts"]
    : ["instagram_business_basic", "instagram_business_content_publish"];
  const missingScopes = requiredScopes.filter((scope) => !token.scopes.includes(scope));
  if (missingScopes.length) throw new Error(`The ${platform} token is missing granted permission(s): ${missingScopes.join(", ")}. Reconnect and grant them.`);
  return token;
}

async function createInstagramContainer(
  accountId: string,
  params: URLSearchParams,
  accessToken: string,
): Promise<string> {
  const container = await apiRequest<{ id?: string }>(instagramGraph(`${accountId}/media`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
    accessToken,
  });
  if (!container.data.id) throw new Error("Instagram did not return a media container ID.");
  return container.data.id;
}

async function publishInstagramContainer(
  accountId: string,
  creationId: string,
  accessToken: string,
): Promise<string> {
  const published = await apiRequest<{ id?: string }>(instagramGraph(`${accountId}/media_publish`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: creationId }),
    accessToken,
  });
  if (!published.data.id) throw new Error("Instagram did not confirm publication with a media ID.");
  return published.data.id;
}

export async function publishFacebookVideo(
  ownerId: string,
  text: string | undefined,
  videoUrl: string,
  pageId?: string,
): Promise<PublishedPost> {
  const token = await requireMetaToken(ownerId, "facebook");
  const page = pageForFacebook(token.pages ?? [], pageId);
  const { data } = await apiRequest<{ id?: string }>(facebookGraphVideo(`${page.id}/videos`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      file_url: videoUrl,
      ...(text ? { description: text, title: text.slice(0, 255) } : {}),
    }),
    accessToken: page.accessToken,
  });
  if (!data.id) throw new Error("Facebook did not return a video ID; publication is unconfirmed.");
  return { platform: "facebook", id: data.id, confirmed: true };
}

export async function publishInstagramReel(
  ownerId: string,
  text: string | undefined,
  videoUrl: string,
  instagramAccountId?: string,
): Promise<PublishedPost> {
  const token = await requireMetaToken(ownerId, "instagram");
  const accountId = selectInstagramAccountId(instagramAccountId, token.accountId);
  const creationId = await createInstagramContainer(
    accountId,
    new URLSearchParams({ media_type: "REELS", video_url: videoUrl, ...(text ? { caption: text } : {}) }),
    token.accessToken,
  );
  await waitForInstagramContainer(creationId, token.accessToken);
  const publishedId = await publishInstagramContainer(accountId, creationId, token.accessToken);
  return { platform: "instagram", id: publishedId, confirmed: true };
}

export async function publishInstagramCarousel(
  ownerId: string,
  text: string | undefined,
  imageUrls: string[],
  instagramAccountId?: string,
): Promise<PublishedPost> {
  if (imageUrls.length < 2 || imageUrls.length > 10) {
    throw new Error("An Instagram carousel must contain between 2 and 10 images.");
  }
  const token = await requireMetaToken(ownerId, "instagram");
  const accountId = selectInstagramAccountId(instagramAccountId, token.accountId);
  const children: string[] = [];
  for (const imageUrl of imageUrls) {
    children.push(await createInstagramContainer(
      accountId,
      new URLSearchParams({ image_url: imageUrl, is_carousel_item: "true" }),
      token.accessToken,
    ));
  }
  const creationId = await createInstagramContainer(
    accountId,
    new URLSearchParams({ media_type: "CAROUSEL", children: children.join(","), ...(text ? { caption: text } : {}) }),
    token.accessToken,
  );
  await waitForInstagramContainer(creationId, token.accessToken);
  const publishedId = await publishInstagramContainer(accountId, creationId, token.accessToken);
  return { platform: "instagram", id: publishedId, confirmed: true };
}

export async function publishMeta(
  ownerId: string,
  platform: MetaPlatform,
  text: string | undefined,
  imageUrl: string | undefined,
  pageId?: string,
  instagramAccountId?: string,
): Promise<PublishedPost> {
  const token = (await loadTokens(ownerId))[platform];
  if (!token) throw new Error(`${platform} is not connected. Start OAuth first.`);
  const requiredScopes = platform === "facebook"
    ? ["pages_show_list", "pages_read_engagement", "pages_manage_posts"]
    : ["instagram_business_basic", "instagram_business_content_publish"];
  const missingScopes = requiredScopes.filter((scope) => !token.scopes.includes(scope));
  if (missingScopes.length) throw new Error(`The ${platform} token is missing granted permission(s): ${missingScopes.join(", ")}. Reconnect and grant them.`);
  if (platform === "facebook") {
    const page = pageForFacebook(token.pages ?? [], pageId);
    if (imageUrl) {
      const { data } = await apiRequest<{ id?: string; post_id?: string }>(facebookGraph(`${page.id}/photos`), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ url: imageUrl, ...(text ? { message: text } : {}) }),
        accessToken: page.accessToken,
      });
      const id = data.post_id ?? data.id;
      if (!id) throw new Error("Facebook did not return a post or photo ID; publication is unconfirmed.");
      return { platform, id, confirmed: true };
    }
    const { data } = await apiRequest<{ id?: string }>(facebookGraph(`${page.id}/feed`), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ message: text ?? "" }),
      accessToken: page.accessToken,
    });
    if (!data.id) throw new Error("Facebook did not return a post ID; publication is unconfirmed.");
    return { platform, id: data.id, confirmed: true };
  }
  if (!imageUrl) throw new Error("Instagram publishing requires a publicly reachable HTTPS image URL.");
  const accountId = selectInstagramAccountId(instagramAccountId, token.accountId);
  const container = await apiRequest<{ id?: string }>(instagramGraph(`${accountId}/media`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ image_url: imageUrl, ...(text ? { caption: text } : {}) }),
    accessToken: token.accessToken,
  });
  if (!container.data.id) throw new Error("Instagram did not return a media container ID.");
  await waitForInstagramContainer(container.data.id, token.accessToken);
  const published = await apiRequest<{ id?: string }>(instagramGraph(`${accountId}/media_publish`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: container.data.id }),
    accessToken: token.accessToken,
  });
  if (!published.data.id) throw new Error("Instagram did not confirm publication with a media ID.");
  return { platform, id: published.data.id, confirmed: true };
}