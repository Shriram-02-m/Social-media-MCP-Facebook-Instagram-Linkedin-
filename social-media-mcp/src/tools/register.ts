import { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { beginAuthorization, getAuthorizationStatus, waitForAuthorization } from "../auth/oauth.js";
import { loadTokens } from "../auth/token-store.js";
import { config } from "../config/env.js";
import { metaAccountInfo, metaConnectionStatus, publishMeta, readMetaPosts } from "../platforms/meta.js";
import {
  linkedinAccountInfo,
  linkedinConnectionStatus,
  publishLinkedIn,
  publishLinkedInWithImage,
  readLinkedInPosts,
} from "../platforms/linkedin.js";
import type { Platform } from "../platforms/types.js";
import {
  cancelScheduledPost,
  retryScheduledPost,
  scheduleMediaPosts,
  schedulePosts,
  scheduledPostStatus,
  type NewScheduledDocument,
  type NewScheduledImage,
  type NewScheduledMedia,
} from "../scheduler.js";
import { explainError } from "../utils/http.js";
import { fetchRemoteMedia } from "../utils/remote-media.js";
import { platformImageRequirements, validateLinkedInAuthorUrn, validatePostContent } from "../utils/validation.js";
import { rejectRemoteLocalPaths } from "./media-input.js";

const imageContentTypes = ["image/jpeg", "image/png", "image/gif"] as const;
const videoContentTypes = ["video/mp4", "video/quicktime"] as const;
const documentContentTypes = ["application/pdf"] as const;

function imageContentTypeFor(extension: string): string {
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  throw new Error("Scheduled images must be PNG, JPEG, or GIF files.");
}

function videoContentTypeFor(extension: string): string {
  if (extension === ".mp4") return "video/mp4";
  if (extension === ".mov") return "video/quicktime";
  throw new Error("Scheduled videos must be MP4 or MOV files.");
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

async function safely(run: () => Promise<unknown>) {
  try {
    return textResult(await run());
  } catch (error) {
    return textResult({ success: false, error: explainError(error) });
  }
}

async function fetchRemoteImage(url: string) {
  return fetchRemoteMedia(url, {
    maxBytes: config.scheduleImageMaxBytes,
    timeoutMs: config.scheduleImageTimeoutMs,
    allowedContentTypes: imageContentTypes,
  });
}

async function fetchRemoteVideo(url: string) {
  return fetchRemoteMedia(url, {
    maxBytes: config.scheduleVideoMaxBytes,
    timeoutMs: config.scheduleImageTimeoutMs,
    allowedContentTypes: videoContentTypes,
  });
}

async function fetchRemoteDocument(url: string) {
  return fetchRemoteMedia(url, {
    maxBytes: config.scheduleDocumentMaxBytes,
    timeoutMs: config.scheduleImageTimeoutMs,
    allowedContentTypes: documentContentTypes,
  });
}

async function remoteDocument(url: string, title?: string): Promise<NewScheduledDocument> {
  const document = await fetchRemoteDocument(url);
  return {
    bytes: document.bytes,
    contentType: document.contentType,
    ...(title ? { title } : {}),
  };
}

export interface RegisterToolsOptions {
  // The authenticated better-auth user for remote MCP requests. The stdio
  // server omits this and keeps using MCP_OWNER_USER_ID.
  userId?: string;
  // Remote mode never starts a local callback listener or reads local media
  // paths; callers use public HTTPS URLs instead.
  remote?: boolean;
}

export function registerTools(server: McpServer, options: RegisterToolsOptions = {}): void {
  const userId = options.userId ?? config.ownerUserId;
  const remote = options.remote === true;

  server.registerTool("social_authorization_start", {
    description: remote
      ? "Start provider OAuth. Open the returned URL in a browser, approve or cancel, then use social_authorization_status or social_authorization_wait with the returned authorizationSessionId. The cloud worker completes the callback; you do not need to keep this MCP server process running."
      : "Start provider OAuth. Open the returned URL in a browser, approve or cancel, then use social_authorization_wait with the returned authorizationSessionId. Keep this MCP server process running until it completes.",
    inputSchema: z.object({ platform: z.enum(["instagram", "facebook", "linkedin"]) }),
  }, async ({ platform }) => safely(async () => {
    const authorization = await beginAuthorization(platform, userId);
    return {
      platform,
      authorizationUrl: authorization.authorizationUrl,
      authorizationSessionId: authorization.sessionId,
      callback: `${config.redirectBaseUrl}/oauth/${platform === "linkedin" ? "linkedin" : "meta"}/callback`,
      expiresAt: new Date(authorization.expiresAt).toISOString(),
      expiresInMinutes: 15,
      note: remote
        ? "Open the URL in a browser and approve or cancel. The cloud worker completes the callback; use social_authorization_status or social_authorization_wait to check progress. The URL contains temporary state; do not share it."
        : "Keep this MCP server process running through browser approval and callback. The URL contains temporary state; do not share it.",
    };
  }));

  server.registerTool("social_authorization_status", {
    description: "Check whether an OAuth authorization session is pending, connected, cancelled, failed, or expired.",
    inputSchema: z.object({ authorizationSessionId: z.string().min(1) }),
  }, async ({ authorizationSessionId }) => safely(async () => getAuthorizationStatus(authorizationSessionId, userId)));

  server.registerTool("social_authorization_wait", {
    description: remote
      ? "Wait briefly for the OAuth callback. Use short waits and call again if it is still pending; the cloud worker completes the callback independently."
      : "Wait briefly for the OAuth callback on this same MCP server process. Use short waits and call again if it is still pending; long tool calls can time out in MCP clients.",
    inputSchema: z.object({
      authorizationSessionId: z.string().min(1),
      timeoutSeconds: z.number().int().min(0).max(20).default(20),
    }),
  }, async ({ authorizationSessionId, timeoutSeconds }) => safely(async () =>
    waitForAuthorization(authorizationSessionId, timeoutSeconds, userId)));

  server.registerTool("social_connection_status", {
    description: "Verify provider authorization and API access without publishing.",
    inputSchema: z.object({ platform: z.enum(["instagram", "facebook", "linkedin"]).optional() }),
  }, async ({ platform }) => safely(async () => {
    const platforms: Platform[] = platform ? [platform] : ["instagram", "facebook", "linkedin"];
    return Promise.all(platforms.map((item) => item === "linkedin" ? linkedinConnectionStatus(userId) : metaConnectionStatus(userId, item)));
  }));

  server.registerTool("social_account_info", {
    description: "Return authenticated Instagram or LinkedIn account details, or Facebook account and accessible Pages.",
    inputSchema: z.object({ platform: z.enum(["instagram", "facebook", "linkedin"]), authorUrn: z.string().optional() }),
  }, async ({ platform, authorUrn }) => safely(async () => platform === "linkedin"
    ? linkedinAccountInfo(userId, authorUrn)
    : metaAccountInfo(userId, platform)));

  server.registerTool("social_recent_posts", {
    description: "Read recent posts allowed by the connected account and granted scopes.",
    inputSchema: z.object({
      platform: z.enum(["instagram", "facebook", "linkedin"]),
      count: z.number().int().min(1).max(100).default(10),
      authorUrn: z.string().optional(),
    }),
  }, async ({ platform, count, authorUrn }) => safely(async () => ({
    platform,
    posts: platform === "linkedin" ? await readLinkedInPosts(userId, count, authorUrn) : await readMetaPosts(userId, platform, Math.min(count, 25)),
  })));

  server.registerTool("social_publish", {
    description: remote
      ? "Validate or publish to selected platforms. Dry-run is the default; real posts require dryRun=false and confirmPublish=true. Remote MCP clients must provide a public HTTPS imageUrl (LinkedIn downloads and validates it server-side). Local imagePath is not accepted in remote mode."
      : "Validate or publish to selected platforms. Dry-run is the default; real posts require dryRun=false and confirmPublish=true. Meta accepts a public HTTPS imageUrl; LinkedIn accepts imageUrl (downloaded server-side) or a local imagePath in stdio mode.",
    inputSchema: z.object({
      platforms: z.array(z.enum(["instagram", "facebook", "linkedin"])).min(1).max(3),
      text: z.string().max(3000).optional(),
      imageUrl: z.string().optional()
        .describe("Public HTTPS image URL. Required for image posts from remote MCP clients."),
      imagePath: z.string().optional()
        .describe("Local image path. Available in stdio mode only; remote MCP clients are rejected."),
      pageId: z.string().optional(),
      instagramAccountId: z.string().optional(),
      authorUrn: z.string().optional(),
      dryRun: z.boolean().default(true),
      confirmPublish: z.boolean().default(false),
    }),
  }, async (input) => safely(async () => {
    // Reject remote local paths before validation, fetching, or any filesystem read.
    rejectRemoteLocalPaths(remote, { imagePath: input.imagePath });
    const platforms = [...new Set(input.platforms)];
    const contentIssues = validatePostContent(input.text, input.imageUrl, input.imagePath);
    const results = await Promise.all(platforms.map(async (platform) => {
      const issues = [
        ...contentIssues,
        ...platformImageRequirements(platform, input.imageUrl, input.imagePath),
        ...(platform === "linkedin" && input.authorUrn
          ? [validateLinkedInAuthorUrn(input.authorUrn)].filter((issue): issue is string => Boolean(issue))
          : []),
      ];
      if (issues.length) return { platform, success: false, published: false, issues };
      if (input.dryRun) return {
        platform,
        success: true,
        published: false,
        dryRun: true,
        note: "Input passed local validation. No provider publish request was made.",
      };
      if (!input.confirmPublish) return {
        platform,
        success: false,
        published: false,
        blocked: true,
        reason: "Set confirmPublish=true in the same call to authorize a real post.",
      };
      try {
        let post;
        if (platform === "linkedin") {
          if (input.imagePath) {
            post = await publishLinkedIn(userId, input.text, input.imagePath, input.authorUrn);
          } else if (input.imageUrl) {
            const image = await fetchRemoteImage(input.imageUrl);
            post = await publishLinkedInWithImage(userId, input.text, image.bytes, image.contentType, input.authorUrn);
          } else {
            post = await publishLinkedIn(userId, input.text, undefined, input.authorUrn);
          }
        } else {
          post = await publishMeta(userId, platform, input.text, input.imageUrl, input.pageId, input.instagramAccountId);
        }
        return { platform, success: true, published: post.confirmed, post };
      } catch (error) {
        return { platform, success: false, published: false, error: explainError(error) };
      }
    }));
    return { results };
  }));

  server.registerTool("social_schedule_posts", {
    description: remote
      ? "Persistently schedule separate posts to connected social platforms. The durable media reference is imageStoragePath (the permanent object path returned by POST /api/media/upload); the worker downloads it with server-side credentials and creates a fresh signed URL only when the platform needs one. A public HTTPS imageUrl is also accepted and is downloaded and re-stored immediately. For a native LinkedIn document, pass documentStoragePath (durable) or a public HTTPS documentUrl. Local imagePath/documentPath are not accepted in remote mode."
      : "Persistently schedule separate posts to connected social platforms. In local mode the MCP scheduler, image server, and public tunnel must remain running; in cloud mode media is stored privately in Supabase Storage and the separate worker publishes it. Provide a permanent imageStoragePath from POST /api/media/upload, a public HTTPS imageUrl, or a local imagePath (stdio). An optional PDF documentStoragePath, documentUrl, or documentPath is attached as a native LinkedIn document post (LinkedIn only).",
    inputSchema: z.object({
      posts: z.array(z.object({
        platform: z.enum(["instagram", "facebook", "linkedin"]),
        scheduledAt: z.string().datetime({ offset: true }),
        text: z.string().min(1).max(63206),
      })).min(1).max(3),
      imageUrl: z.string().optional()
        .describe("Public HTTPS image URL. Downloaded immediately and stored privately for the scheduled post."),
      imageStoragePath: z.string().min(1).optional()
        .describe("Permanent private-storage object path returned by POST /api/media/upload. Preferred for scheduled posts: it never expires and the worker re-signs a URL at publish time."),
      imagePath: z.string().min(1).optional()
        .describe("Local image path. Available in stdio mode only; remote MCP clients are rejected."),
      documentUrl: z.string().optional()
        .describe("Public HTTPS PDF URL for a native LinkedIn document post."),
      documentStoragePath: z.string().min(1).optional()
        .describe("Permanent private-storage PDF object path returned by POST /api/media/upload."),
      documentPath: z.string().min(1).optional()
        .describe("Local PDF path for a native LinkedIn document post. Available in stdio mode only; remote MCP clients are rejected."),
      documentTitle: z.string().min(1).max(200).optional()
        .describe("Title shown on the LinkedIn document. Defaults to the PDF file name."),
    }),
  }, async ({ posts, imageUrl, imageStoragePath, imagePath, documentUrl, documentStoragePath, documentPath, documentTitle }) => safely(async () => {
    // Reject remote local paths before any token lookup, fetch, or filesystem read.
    rejectRemoteLocalPaths(remote, { imagePath, documentPath });
    if ([imageUrl, imageStoragePath, imagePath].filter(Boolean).length !== 1) {
      throw new Error("Provide exactly one of imageUrl, imageStoragePath, or imagePath.");
    }
    if ([documentUrl, documentStoragePath, documentPath].filter(Boolean).length > 1) {
      throw new Error("Provide at most one of documentUrl, documentStoragePath, or documentPath.");
    }
    let image: string | NewScheduledImage;
    if (imagePath) {
      image = imagePath;
    } else if (imageStoragePath) {
      image = { storagePath: imageStoragePath };
    } else {
      const fetched = await fetchRemoteImage(imageUrl!);
      image = { bytes: fetched.bytes, contentType: fetched.contentType, extension: fetched.extension };
    }
    const document = documentUrl
      ? await remoteDocument(documentUrl, documentTitle)
      : documentStoragePath
        ? { storagePath: documentStoragePath, ...(documentTitle ? { title: documentTitle } : {}) }
        : documentPath
          ? { path: documentPath, ...(documentTitle ? { title: documentTitle } : {}) }
          : undefined;
    return {
      scheduled: await schedulePosts(userId, posts, image, document),
    };
  }));

  server.registerTool("social_schedule_media", {
    description: remote
      ? "Schedule image, video, or Instagram carousel posts to connected platforms. The durable media reference is media[].storagePath (the permanent object path returned by POST /api/media/upload); the worker downloads it with server-side credentials and creates a fresh signed URL only when the platform needs one. A public HTTPS url is also accepted and is downloaded and re-stored immediately. For a LinkedIn PDF pass documentStoragePath (durable) or a public HTTPS documentUrl. Local media[].path and documentPath are not accepted in remote mode. Provide one image, one video, two to ten images for an Instagram carousel, or no media for a text-only Facebook/LinkedIn post."
      : "Schedule image, video, or Instagram carousel posts to connected platforms. Provide a permanent media[].storagePath from POST /api/media/upload, a public HTTPS url, or a local path (stdio) for each media item. Provide one image, one video, two to ten images for an Instagram carousel, or no media for a text-only Facebook/LinkedIn post. Cloud mode stores media privately in Supabase Storage; the worker downloads it at publish time.",
    inputSchema: z.object({
      posts: z.array(z.object({
        platform: z.enum(["instagram", "facebook", "linkedin"]),
        scheduledAt: z.string().datetime({ offset: true }),
        text: z.string().min(1).max(63206),
      })).min(1).max(3),
      media: z.array(z.object({
        path: z.string().min(1).optional()
          .describe("Local media path. Available in stdio mode only; remote MCP clients are rejected."),
        storagePath: z.string().min(1).optional()
          .describe("Permanent private-storage object path returned by POST /api/media/upload. Preferred for scheduled posts: it never expires."),
        url: z.string().optional()
          .describe("Public HTTPS media URL. Downloaded immediately and stored privately for the scheduled post."),
        kind: z.enum(["image", "video"]),
      })).max(10).default([]),
      documentUrl: z.string().optional()
        .describe("Public HTTPS PDF URL for a native LinkedIn document post. Cannot be combined with media."),
      documentStoragePath: z.string().min(1).optional()
        .describe("Permanent private-storage PDF object path returned by POST /api/media/upload. Cannot be combined with media."),
      documentPath: z.string().min(1).optional()
        .describe("Local PDF path for a native LinkedIn document post. Available in stdio mode only; remote MCP clients are rejected."),
      documentTitle: z.string().min(1).max(200).optional(),
    }),
  }, async ({ posts, media, documentUrl, documentStoragePath, documentPath, documentTitle }) => safely(async () => {
    // Reject remote local paths before any token lookup, fetch, or filesystem read.
    rejectRemoteLocalPaths(remote, { documentPath, mediaPaths: media.map((item) => item.path) });
    if ([documentUrl, documentStoragePath, documentPath].filter(Boolean).length > 1) {
      throw new Error("Provide at most one of documentUrl, documentStoragePath, or documentPath.");
    }
    const resolved: NewScheduledMedia[] = [];
    for (const item of media) {
      if ([item.path, item.storagePath, item.url].filter(Boolean).length !== 1) {
        throw new Error("Provide exactly one of path, storagePath, or url for each media item.");
      }
      if (item.path) {
        const extension = path.extname(item.path).toLowerCase();
        const contentType = item.kind === "video" ? videoContentTypeFor(extension) : imageContentTypeFor(extension);
        resolved.push({ kind: item.kind, bytes: await readFile(item.path), contentType, extension });
      } else if (item.storagePath) {
        const extension = path.extname(item.storagePath).toLowerCase();
        const contentType = item.kind === "video" ? videoContentTypeFor(extension) : imageContentTypeFor(extension);
        resolved.push({ kind: item.kind, storagePath: item.storagePath, contentType, extension });
      } else {
        const fetched = item.kind === "video" ? await fetchRemoteVideo(item.url!) : await fetchRemoteImage(item.url!);
        resolved.push({ kind: item.kind, bytes: fetched.bytes, contentType: fetched.contentType, extension: fetched.extension });
      }
    }
    const document = documentUrl
      ? await remoteDocument(documentUrl, documentTitle)
      : documentStoragePath
        ? { storagePath: documentStoragePath, ...(documentTitle ? { title: documentTitle } : {}) }
        : documentPath
          ? { path: documentPath, ...(documentTitle ? { title: documentTitle } : {}) }
          : undefined;
    return {
      scheduled: await scheduleMediaPosts(userId, posts, resolved, document),
    };
  }));

  server.registerTool("social_scheduled_posts_status", {
    description: "List scheduled posts, image validation results, retry counts, and failure stages without exposing credentials or image URLs.",
    inputSchema: z.object({}),
  }, async () => safely(async () => ({ scheduledPosts: await scheduledPostStatus(userId) })));

  server.registerTool("social_cancel_scheduled_post", {
    description: "Cancel a scheduled post only if publishing has not started.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
  }, async ({ jobId }) => safely(async () => ({ cancelled: await cancelScheduledPost(userId, jobId) })));

  server.registerTool("social_retry_scheduled_post", {
    description: "Safely requeue a failed scheduled post only after pre-publish token or image validation failed. Publishing-stage failures are blocked to prevent duplicates.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
  }, async ({ jobId }) => safely(async () => ({ scheduled: await retryScheduledPost(userId, jobId) })));

  server.registerTool("social_token_store_status", {
    description: "Show stored token presence, expiry, and scopes without exposing secrets.",
    inputSchema: z.object({}),
  }, async () => safely(async () => {
    const tokens = await loadTokens(userId);
    return Object.fromEntries((["instagram", "facebook", "linkedin"] as const).map((platform) => {
      const token = tokens[platform];
      return [platform, token
        ? { connected: true, expiresAt: token.expiresAt, scopes: token.scopes, pages: token.pages?.map(({ id, name }) => ({ id, name })) }
        : { connected: false }];
    }));
  }));
}
