import { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { beginAuthorization, getAuthorizationStatus, waitForAuthorization } from "../auth/oauth.js";
import { loadTokens } from "../auth/token-store.js";
import { config } from "../config/env.js";
import { metaAccountInfo, metaConnectionStatus, publishMeta, readMetaPosts } from "../platforms/meta.js";
import { linkedinAccountInfo, linkedinConnectionStatus, publishLinkedIn, readLinkedInPosts } from "../platforms/linkedin.js";
import type { Platform } from "../platforms/types.js";
import { cancelScheduledPost, retryScheduledPost, scheduleMediaPosts, schedulePosts, scheduledPostStatus } from "../scheduler.js";
import { explainError } from "../utils/http.js";
import { platformImageRequirements, validateLinkedInAuthorUrn, validatePostContent } from "../utils/validation.js";

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

export function registerTools(server: McpServer): void {
  server.registerTool("social_authorization_start", {
    description: "Start provider OAuth. Open the returned URL in a browser, approve or cancel, then use social_authorization_wait with the returned authorizationSessionId. Keep this MCP server process running until it completes.",
    inputSchema: z.object({ platform: z.enum(["instagram", "facebook", "linkedin"]) }),
  }, async ({ platform }) => safely(async () => {
    const authorization = await beginAuthorization(platform, config.ownerUserId);
    return {
      platform,
      authorizationUrl: authorization.authorizationUrl,
      authorizationSessionId: authorization.sessionId,
      callback: `${config.redirectBaseUrl}/oauth/${platform === "linkedin" ? "linkedin" : "meta"}/callback`,
      expiresAt: new Date(authorization.expiresAt).toISOString(),
      expiresInMinutes: 15,
      note: "Keep this MCP server process running through browser approval and callback. The URL contains temporary state; do not share it.",
    };
  }));

  server.registerTool("social_authorization_status", {
    description: "Check whether an OAuth authorization session is pending, connected, cancelled, failed, or expired.",
    inputSchema: z.object({ authorizationSessionId: z.string().min(1) }),
  }, async ({ authorizationSessionId }) => safely(async () => getAuthorizationStatus(authorizationSessionId, config.ownerUserId)));

  server.registerTool("social_authorization_wait", {
    description: "Wait briefly for the OAuth callback on this same MCP server process. Use short waits and call again if it is still pending; long tool calls can time out in MCP clients.",
    inputSchema: z.object({
      authorizationSessionId: z.string().min(1),
      timeoutSeconds: z.number().int().min(0).max(20).default(20),
    }),
  }, async ({ authorizationSessionId, timeoutSeconds }) => safely(async () =>
    waitForAuthorization(authorizationSessionId, timeoutSeconds, config.ownerUserId)));

  server.registerTool("social_connection_status", {
    description: "Verify provider authorization and API access without publishing.",
    inputSchema: z.object({ platform: z.enum(["instagram", "facebook", "linkedin"]).optional() }),
  }, async ({ platform }) => safely(async () => {
    const platforms: Platform[] = platform ? [platform] : ["instagram", "facebook", "linkedin"];
    return Promise.all(platforms.map((item) => item === "linkedin" ? linkedinConnectionStatus(config.ownerUserId) : metaConnectionStatus(config.ownerUserId, item)));
  }));

  server.registerTool("social_account_info", {
    description: "Return authenticated Instagram or LinkedIn account details, or Facebook account and accessible Pages.",
    inputSchema: z.object({ platform: z.enum(["instagram", "facebook", "linkedin"]), authorUrn: z.string().optional() }),
  }, async ({ platform, authorUrn }) => safely(async () => platform === "linkedin"
    ? linkedinAccountInfo(config.ownerUserId, authorUrn)
    : metaAccountInfo(config.ownerUserId, platform)));

  server.registerTool("social_recent_posts", {
    description: "Read recent posts allowed by the connected account and granted scopes.",
    inputSchema: z.object({
      platform: z.enum(["instagram", "facebook", "linkedin"]),
      count: z.number().int().min(1).max(100).default(10),
      authorUrn: z.string().optional(),
    }),
  }, async ({ platform, count, authorUrn }) => safely(async () => ({
    platform,
    posts: platform === "linkedin" ? await readLinkedInPosts(config.ownerUserId, count, authorUrn) : await readMetaPosts(config.ownerUserId, platform, Math.min(count, 25)),
  })));

  server.registerTool("social_publish", {
    description: "Validate or publish to selected platforms. Dry-run is the default; real posts require dryRun=false and confirmPublish=true.",
    inputSchema: z.object({
      platforms: z.array(z.enum(["instagram", "facebook", "linkedin"])).min(1).max(3),
      text: z.string().max(3000).optional(),
      imageUrl: z.string().optional(),
      imagePath: z.string().optional(),
      pageId: z.string().optional(),
      instagramAccountId: z.string().optional(),
      authorUrn: z.string().optional(),
      dryRun: z.boolean().default(true),
      confirmPublish: z.boolean().default(false),
    }),
  }, async (input) => safely(async () => {
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
        const post = platform === "linkedin"
          ? await publishLinkedIn(config.ownerUserId, input.text, input.imagePath, input.authorUrn)
          : await publishMeta(config.ownerUserId, platform, input.text, input.imageUrl, input.pageId, input.instagramAccountId);
        return { platform, success: true, published: post.confirmed, post };
      } catch (error) {
        return { platform, success: false, published: false, error: explainError(error) };
      }
    }));
    return { results };
  }));

  server.registerTool("social_schedule_posts", {
    description: "Persistently schedule separate posts to connected social platforms. In local mode the MCP scheduler, image server, and public tunnel must remain running; in cloud mode images and documents are stored privately in Supabase Storage and the separate worker publishes them. An optional PDF documentPath is attached as a native LinkedIn document post (LinkedIn only).",
    inputSchema: z.object({
      posts: z.array(z.object({
        platform: z.enum(["instagram", "facebook", "linkedin"]),
        scheduledAt: z.string().datetime({ offset: true }),
        text: z.string().min(1).max(63206),
      })).min(1).max(3),
      imagePath: z.string().min(1),
      documentPath: z.string().min(1).optional()
        .describe("Local path to a PDF to attach to the LinkedIn post as a native document. Ignored for Instagram and Facebook."),
      documentTitle: z.string().min(1).max(200).optional()
        .describe("Title shown on the LinkedIn document. Defaults to the PDF file name."),
    }),
  }, async ({ posts, imagePath, documentPath, documentTitle }) => safely(async () => ({
    scheduled: await schedulePosts(
      config.ownerUserId,
      posts,
      imagePath,
      documentPath ? { path: documentPath, ...(documentTitle ? { title: documentTitle } : {}) } : undefined,
    ),
  })));

  server.registerTool("social_schedule_media", {
    description: "Schedule image, video, or Instagram carousel posts to connected platforms from local file paths. Provide one image, one video, two to ten images for an Instagram carousel, or no media for a text-only Facebook/LinkedIn post. Cloud mode stores media privately in Supabase Storage; the worker publishes due jobs.",
    inputSchema: z.object({
      posts: z.array(z.object({
        platform: z.enum(["instagram", "facebook", "linkedin"]),
        scheduledAt: z.string().datetime({ offset: true }),
        text: z.string().min(1).max(63206),
      })).min(1).max(3),
      media: z.array(z.object({
        path: z.string().min(1),
        kind: z.enum(["image", "video"]),
      })).max(10).default([]),
      documentPath: z.string().min(1).optional()
        .describe("Local path to a PDF to attach to the LinkedIn post as a native document. Cannot be combined with media."),
      documentTitle: z.string().min(1).max(200).optional(),
    }),
  }, async ({ posts, media, documentPath, documentTitle }) => safely(async () => {
    const resolved = await Promise.all(media.map(async (item) => {
      const extension = path.extname(item.path).toLowerCase();
      const contentType = item.kind === "video" ? videoContentTypeFor(extension) : imageContentTypeFor(extension);
      return { kind: item.kind, bytes: await readFile(item.path), contentType, extension };
    }));
    return {
      scheduled: await scheduleMediaPosts(
        config.ownerUserId,
        posts,
        resolved,
        documentPath ? { path: documentPath, ...(documentTitle ? { title: documentTitle } : {}) } : undefined,
      ),
    };
  }));

  server.registerTool("social_scheduled_posts_status", {
    description: "List scheduled posts, image validation results, retry counts, and failure stages without exposing credentials or image URLs.",
    inputSchema: z.object({}),
  }, async () => safely(async () => ({ scheduledPosts: await scheduledPostStatus(config.ownerUserId) })));

  server.registerTool("social_cancel_scheduled_post", {
    description: "Cancel a scheduled post only if publishing has not started.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
  }, async ({ jobId }) => safely(async () => ({ cancelled: await cancelScheduledPost(config.ownerUserId, jobId) })));

  server.registerTool("social_retry_scheduled_post", {
    description: "Safely requeue a failed scheduled post only after pre-publish token or image validation failed. Publishing-stage failures are blocked to prevent duplicates.",
    inputSchema: z.object({ jobId: z.string().min(1) }),
  }, async ({ jobId }) => safely(async () => ({ scheduled: await retryScheduledPost(config.ownerUserId, jobId) })));

  server.registerTool("social_token_store_status", {
    description: "Show stored token presence, expiry, and scopes without exposing secrets.",
    inputSchema: z.object({}),
  }, async () => safely(async () => {
    const tokens = await loadTokens(config.ownerUserId);
    return Object.fromEntries((["instagram", "facebook", "linkedin"] as const).map((platform) => {
      const token = tokens[platform];
      return [platform, token
        ? { connected: true, expiresAt: token.expiresAt, scopes: token.scopes, pages: token.pages?.map(({ id, name }) => ({ id, name })) }
        : { connected: false }];
    }));
  }));
}