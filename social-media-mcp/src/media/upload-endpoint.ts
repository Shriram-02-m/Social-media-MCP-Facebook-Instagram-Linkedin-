import { createHash } from "node:crypto";
import { config } from "../config/env.js";
import {
  UploadIntentError,
  claimPendingMediaUploadIntent,
  completeMediaUploadIntent,
  evaluateMediaUpload,
  extensionForContentType,
  failMediaUploadIntent,
  type MediaUploadIntentRow,
} from "../storage/upload-intents.js";
import {
  deleteScheduledDocument,
  deleteScheduledImage,
  deleteScheduledVideo,
  matchesMediaSignature,
  uploadScheduledDocument,
  uploadScheduledImage,
  uploadScheduledVideo,
} from "../storage/scheduled-images.js";

// Single-use upload endpoint for MCP media intents, served by the cloud worker
// at POST /media/upload. The endpoint authenticates with the per-intent bearer
// token (never an MCP OAuth access token and never the Supabase service-role
// key), claims the intent atomically, validates the declared and actual
// content type, size, and file signature server-side, then writes the bytes
// into the private bucket under the claiming user's per-user prefix. The
// response's `storagePath` is the permanent object reference for scheduling
// and publishing; no expiring signed URL is produced or returned here.

// 1 MiB of transport slack above the largest accepted video.
export const mediaUploadBodyLimit = config.scheduleVideoMaxBytes + 1024 * 1024;

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown upload error.";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .slice(0, 500);
}

function jsonResponse(status: number, value: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

// The capability token may arrive as `Authorization: Bearer <token>` (preferred:
// URLs are commonly logged, bearer headers are not) or as a `?token=` query
// parameter fallback for clients that cannot set headers.
export function extractUploadToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  if (match) return match[1]!;
  return new URL(request.url).searchParams.get("token") ?? undefined;
}

function requestContentType(request: Request): string {
  return request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
}

// The intent row is claimed (single-use) before the bytes are accepted, so a
// malformed or hostile upload can never retry against the same token. Any
// rejected or failed attempt burns the intent; the client must request a new
// one. That keeps "one token, at most one accepted upload" unconditional.
export async function mediaUploadResponse(request: Request): Promise<Response> {
  const token = extractUploadToken(request);
  try {
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "Use POST." }, { allow: "POST" });
    }
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey || !config.databaseUrl) {
      return jsonResponse(503, { error: "Media uploads are not configured on this deployment." });
    }
    if (!token || token.length < 32) {
      return jsonResponse(401, { error: "Provide the upload token as an Authorization: Bearer header." });
    }
    const intent = await claimPendingMediaUploadIntent(token);
    const userId = intent.user_id;
    const kind = intent.kind as "image" | "video" | "document";
    const declaredContentType: string = intent.content_type;
    try {
      // Read the body exactly once, bounded by the route-level limit.
      const bytes = Buffer.from(await request.arrayBuffer());
      const problem = evaluateMediaUpload(
        { kind, contentType: declaredContentType, expectedBytes: intent.expected_bytes },
        requestContentType(request),
        bytes,
      );
      if (problem) {
        await failMediaUploadIntent(intent.id);
        console.warn(JSON.stringify({ event: "media_upload_rejected", intentId: intent.id, status: problem.status }));
        return jsonResponse(problem.status, { error: problem.message });
      }
      if (intent.expected_bytes > 0 && bytes.byteLength !== intent.expected_bytes) {
        // Declared size is metadata: log drift, enforce only the kind limit.
        console.warn(JSON.stringify({
          event: "media_upload_size_mismatch",
          intentId: intent.id,
          declared: intent.expected_bytes,
          actual: bytes.byteLength,
        }));
      }
      // The file signature is validated here (against the bytes, not the
      // header) and again by every later download/validate call in the worker.
      if (!matchesMediaSignature(bytes, declaredContentType)) {
        await failMediaUploadIntent(intent.id);
        console.warn(JSON.stringify({ event: "media_upload_bad_signature", intentId: intent.id }));
        return jsonResponse(415, {
          error: `File contents do not match ${declaredContentType}. The upload intent is single-use; request a new one.`,
        });
      }
      const extension = extensionForContentType(declaredContentType)!;
      // Every uploader generates a fresh object path under this user's prefix
      // (scheduled/<owner-segment>/<48-hex><ext>), so the returned reference is
      // owner-scoped and path-traversal-proof by construction.
      const storagePath = kind === "video"
        ? await uploadScheduledVideo(bytes, declaredContentType, extension, userId)
        : kind === "document"
          ? await uploadScheduledDocument(bytes, declaredContentType, extension, userId)
          : await uploadScheduledImage(bytes, declaredContentType, extension, userId);
      let finalized = false;
      try {
        finalized = await completeMediaUploadIntent(intent.id, storagePath, bytes.byteLength);
      } catch (error) {
        console.error(JSON.stringify({
          event: "media_upload_finalize_failed",
          intentId: intent.id,
          kind,
          error: redactError(error),
        }));
      }
      if (!finalized) {
        // The reference must not exist without a confirmed record: clean up the
        // object best-effort, then mark the intent terminal so the same token
        // can never be replayed.
        const cleanup = kind === "video"
          ? deleteScheduledVideo(storagePath)
          : kind === "document"
            ? deleteScheduledDocument(storagePath)
            : deleteScheduledImage(storagePath);
        await cleanup.catch((cleanupError: unknown) => {
          console.error(JSON.stringify({
            event: "media_upload_orphan_cleanup_failed",
            intentId: intent.id,
            storagePath,
            error: redactError(cleanupError),
          }));
        });
        await failMediaUploadIntent(intent.id);
        return jsonResponse(500, {
          error: "The upload completed but could not be confirmed. Request a new upload intent and try again.",
        });
      }
      console.info(JSON.stringify({
        event: "media_upload_completed",
        intentId: intent.id,
        kind,
        bytes: bytes.byteLength,
        tokenFingerprint: hashForLogging(token),
      }));
      return jsonResponse(201, {
        storagePath,
        kind,
        contentType: declaredContentType,
        bytes: bytes.byteLength,
        note: "Pass storagePath as imageStoragePath in social_publish, or as media[].storagePath / documentStoragePath when scheduling. It is permanent; never store a signed URL.",
      });
    } catch (error) {
      await failMediaUploadIntent(intent.id);
      throw error;
    }
  } catch (error) {
    if (error instanceof UploadIntentError) {
      // Deliberately log identity without any token material beyond a short,
      // unsalted digest prefix for tracing — never the raw token itself.
      console.warn(JSON.stringify({
        event: "media_upload_rejected",
        tokenFingerprint: token ? hashForLogging(token) : "missing",
        status: error.status,
      }));
      return jsonResponse(error.status, { error: error.message });
    }
    console.error(JSON.stringify({ event: "media_upload_failed", error: redactError(error) }));
    return jsonResponse(500, { error: "The upload failed. Request a new upload intent and try again." });
  }
}

function hashForLogging(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex").slice(0, 12);
}

// Narrow row shape kept on the wire (no token material is ever returned).
export type { MediaUploadIntentRow };
