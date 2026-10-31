import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { QueryResultRow } from "pg";
import { config } from "../config/env.js";
import { databasePool } from "../database.js";

// Single-use media upload intents for MCP clients.
//
// The published MCP spec has no client→server file-upload primitive, so remote
// tools never receive attachment bytes. A tool therefore mints a short-lived,
// single-use intent bound to the authenticated better-auth user and returns an
// HTTPS upload endpoint plus a bearer upload token (shown once, hashed at
// rest). The cloud worker's POST /media/upload claims the intent atomically,
// validates the file server-side, stores it in the private Supabase bucket
// under the owner's per-user prefix, and returns the permanent object path.
//
// Cross-runtime note: the web route /api/media/upload keeps its own identical
// MIME/extension map because Vercel and Render deploy independently; both maps
// cover exactly the types accepted by schedulePosts/scheduleMediaPosts.

export type MediaUploadKind = "image" | "video" | "document";

export const mediaUploadExtensionsByContentType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
};

const contentTypesByKind: Record<MediaUploadKind, ReadonlySet<string>> = {
  image: new Set(["image/jpeg", "image/png", "image/gif"]),
  video: new Set(["video/mp4", "video/quicktime"]),
  document: new Set(["application/pdf"]),
};

const kindLabels: Record<MediaUploadKind, string> = {
  image: "image",
  video: "video",
  document: "PDF document",
};

export function isMediaUploadKind(value: string): value is MediaUploadKind {
  return value === "image" || value === "video" || value === "document";
}

export function maxBytesForKind(kind: MediaUploadKind): number {
  return kind === "video"
    ? config.scheduleVideoMaxBytes
    : kind === "document"
      ? config.scheduleDocumentMaxBytes
      : config.scheduleImageMaxBytes;
}

export function extensionForContentType(contentType: string): string | undefined {
  return mediaUploadExtensionsByContentType[contentType];
}

// Filename inference accepts every legal variant (.jpg and .jpeg map to the
// same content type), independent of the canonical object-key extension above.
const contentTypesByExtension: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
};

export function contentTypeForFilename(filename: string): string | undefined {
  const extension = path.extname(filename).toLowerCase();
  return extension ? contentTypesByExtension[extension] : undefined;
}

// Display-only: the object path always comes from scheduledObjectPath(), which
// is random hex under the owner prefix, so the filename can never influence a
// storage key and path traversal is structurally impossible. Still strip
// separators and control characters before persisting the label.
export function sanitizeUploadFilename(filename: string): string {
  const cleaned = filename
    .split(/[\\/]+/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return cleaned.slice(0, 200);
}

export function hashUploadToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newUploadToken(): string {
  return randomBytes(32).toString("hex");
}

// Throws unless the declared content type is supported for the requested kind.
export function assertSupportedMediaUpload(kind: MediaUploadKind, contentType: string): void {
  if (!extensionForContentType(contentType)) {
    throw new Error(
      `Unsupported upload content type: ${contentType || "missing"}. Only JPEG, PNG, or GIF images, MP4 or MOV videos, and PDF documents are supported.`,
    );
  }
  if (!contentTypesByKind[kind].has(contentType)) {
    throw new Error(`Content type ${contentType} is not valid for a ${kindLabels[kind]} upload.`);
  }
}

// A caller-declared size is bounded immediately so an obviously oversized
// intent never ships an upload URL. The actual byte size is re-checked
// server-side (and against the kind limit) at upload time.
export function assertAllowedDeclaredSize(kind: MediaUploadKind, declaredBytes: number): void {
  if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 1) {
    throw new Error("Declared file size must be a positive integer.");
  }
  if (declaredBytes > maxBytesForKind(kind)) {
    throw new Error(`Declared file exceeds the ${maxBytesForKind(kind)}-byte limit for ${kindLabels[kind]} uploads.`);
  }
}

export interface MediaUploadCheckInput {
  kind: MediaUploadKind;
  contentType: string;
  expectedBytes: number;
}

// Pure request validation for the upload endpoint, split out so the wire-level
// handler stays thin and the checks stay unit-testable without a database.
// The caller has already split the header's MIME parameters.
export function evaluateMediaUpload(
  intent: MediaUploadCheckInput,
  contentType: string,
  bytes: Uint8Array,
): { status: number; message: string } | undefined {
  if (!extensionForContentType(contentType)) {
    return { status: 415, message: `Unsupported upload content type: ${contentType || "missing"}.` };
  }
  if (contentType !== intent.contentType) {
    return {
      status: 415,
      message: `Upload declares ${contentType} but the intent was created for ${intent.contentType}. The upload intent is single-use; request a new one.`,
    };
  }
  if (bytes.byteLength === 0) {
    return { status: 400, message: "The upload body is empty." };
  }
  if (bytes.byteLength > maxBytesForKind(intent.kind)) {
    return {
      status: 413,
      message: `The upload exceeds the ${maxBytesForKind(intent.kind)}-byte limit for ${kindLabels[intent.kind]}s.`,
    };
  }
  return undefined;
}

// HTTPS (or loopback for local development) upload endpoint, derived from the
// same public worker origin the MCP clients already trust.
export function assertUploadEndpointUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The media upload endpoint URL must be a valid absolute URL.");
  }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !loopback) {
    throw new Error("The media upload endpoint must use HTTPS outside localhost.");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error("The media upload endpoint must not contain credentials or a fragment.");
  }
  return url;
}

export function mediaUploadEndpointUrl(): string {
  const origin = new URL(config.mcpPublicUrl).origin;
  return assertUploadEndpointUrl(new URL("/media/upload", origin).toString());
}

// Browser fallback for clients that cannot upload bytes (returns undefined in
// local setups without a deployed HTTPS frontend).
export function fallbackMediaUploadPageUrl(): string | undefined {
  if (!config.oauthFrontendBaseUrl) return undefined;
  try {
    const parsed = new URL(config.oauthFrontendBaseUrl);
    if (parsed.protocol !== "https:") return undefined;
    return new URL("/media", parsed.origin).toString();
  } catch {
    return undefined;
  }
}

// --- Rate limiting -----------------------------------------------------------
//
// Sliding-window limiter keyed by authenticated user, per cloud-worker process.
// Intent creation is the only mutation this protects; the upload endpoint is
// already single-use and capped by token.

export interface SlidingWindowRateLimiter {
  allow(key: string, nowMs?: number): boolean;
}

export function createSlidingWindowRateLimiter(options: {
  maxRequests: number;
  windowMs: number;
}): SlidingWindowRateLimiter {
  const { maxRequests, windowMs } = options;
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, nowMs: number = Date.now()): boolean {
      const window = (hits.get(key) ?? []).filter((timestamp) => timestamp > nowMs - windowMs);
      if (window.length >= maxRequests) {
        hits.set(key, window);
        return false;
      }
      window.push(nowMs);
      hits.set(key, window);
      return true;
    },
  };
}

const intentRateLimiter = createSlidingWindowRateLimiter({
  maxRequests: config.mediaUploadIntentRateLimit,
  windowMs: 600_000,
});

export class UploadIntentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadIntentError";
    this.status = status;
  }
}

export interface MediaUploadIntentRow extends QueryResultRow {
  id: string;
  user_id: string;
  client_id: string | null;
  token_hash: string;
  original_filename: string;
  content_type: string;
  expected_bytes: number;
  kind: string;
  status: string;
  storage_path: string | null;
  uploaded_bytes: number | null;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  uploaded_at: Date | null;
}

export interface CreatedMediaUploadIntent {
  intentId: string;
  kind: MediaUploadKind;
  contentType: string;
  filename: string;
  expectedBytes: number;
  maxBytes: number;
  token: string;
  expiresAt: string;
}

export interface CreateMediaUploadIntentInput {
  userId: string;
  kind: MediaUploadKind;
  contentType: string;
  filename?: string;
  expectedBytes?: number;
  clientId?: string;
}

function requireCloudStorageInProcess(): void {
  if (config.scheduledImageStorage !== "supabase" || !config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error(
      "Media upload intents require the cloud storage backend: set SCHEDULED_IMAGE_STORAGE=supabase, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  if (!config.databaseUrl) {
    throw new Error("Media upload intents require DATABASE_URL to store the single-use intent record.");
  }
}

// Best-effort sweep of dead rows whenever a new intent is created. Completed
// rows keep only audit metadata (the storagePath reference never depends on
// this table), so sweeping cannot affect a scheduled post.
async function sweepStaleIntents(ownerId: string): Promise<void> {
  await databasePool().query(
    `DELETE FROM public.mcp_media_upload_intents
     WHERE user_id = $1
       AND (
         expires_at < NOW()
         OR (status = 'uploaded' AND created_at < NOW() - INTERVAL '7 days')
       )`,
    [ownerId],
  );
}

export async function createMediaUploadIntent(
  input: CreateMediaUploadIntentInput,
): Promise<CreatedMediaUploadIntent> {
  const userId = input.userId.trim();
  if (!userId) throw new Error("An authenticated user is required to create an upload intent.");
  const contentType = input.contentType.trim().toLowerCase();
  assertSupportedMediaUpload(input.kind, contentType);
  if (input.expectedBytes !== undefined) assertAllowedDeclaredSize(input.kind, input.expectedBytes);
  requireCloudStorageInProcess();
  if (!intentRateLimiter.allow(userId)) {
    throw new Error(
      "Too many upload intents requested. Wait a few minutes and request a single new upload intent.",
    );
  }
  const token = newUploadToken();
  const id = randomBytes(16).toString("hex");
  const { rows } = await databasePool().query<MediaUploadIntentRow>(
    `INSERT INTO public.mcp_media_upload_intents
       (id, user_id, client_id, token_hash, original_filename, content_type, expected_bytes, kind, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', NOW() + make_interval(secs => $9))
     RETURNING id, expires_at`,
    [
      id,
      userId,
      input.clientId?.trim() || null,
      hashUploadToken(token),
      input.filename ? sanitizeUploadFilename(input.filename) : "",
      contentType,
      input.expectedBytes ?? 0,
      input.kind,
      config.mediaUploadIntentTtlSeconds,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("The upload intent could not be stored. Try again.");
  try {
    await sweepStaleIntents(userId);
  } catch (error) {
    console.error(JSON.stringify({
      event: "media_upload_intent_sweep_failed",
      error: error instanceof Error ? error.message : "Unknown sweep error.",
    }));
  }
  return {
    intentId: row.id,
    kind: input.kind,
    contentType,
    filename: input.filename ? sanitizeUploadFilename(input.filename) : "",
    expectedBytes: input.expectedBytes ?? 0,
    maxBytes: maxBytesForKind(input.kind),
    token,
    expiresAt: row.expires_at.toISOString(),
  };
}

async function findMediaUploadIntentRow(token: string): Promise<MediaUploadIntentRow | undefined> {
  const { rows } = await databasePool().query<MediaUploadIntentRow>(
    "SELECT * FROM public.mcp_media_upload_intents WHERE token_hash = $1",
    [hashUploadToken(token)],
  );
  return rows[0];
}

// Atomic single-use claim. The UPDATE only matches pending, unconsumed,
// unexpired intents, so two concurrent uploads of the same token can never both
// claim it (and replay is structurally impossible: the claim flips the row, and
// re-verifying a spent token lands on the "already used" reply). Failed
// attempts burn the intent — the client must request a new one, which keeps
// "one token, at most one accepted upload" true without a second state machine.
export async function claimPendingMediaUploadIntent(token: string): Promise<MediaUploadIntentRow> {
  const { rows } = await databasePool().query<MediaUploadIntentRow>(
    `UPDATE public.mcp_media_upload_intents
     SET consumed_at = NOW()
     WHERE token_hash = $1
       AND status = 'pending'
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING id, user_id, client_id, original_filename, content_type, expected_bytes, kind, status`,
    [hashUploadToken(token)],
  );
  const claimed = rows[0];
  if (claimed) return claimed;
  const existing = await findMediaUploadIntentRow(token);
  if (!existing) {
    throw new UploadIntentError(404, "Unknown upload token. Request a new upload intent.");
  }
  if (existing.status === "uploaded") {
    throw new UploadIntentError(409, "This upload intent was already used. Request a new upload intent.");
  }
  if (existing.status === "failed" || existing.consumed_at) {
    throw new UploadIntentError(409, "This upload intent has already been consumed. Request a new one.");
  }
  throw new UploadIntentError(410, "This upload intent has expired. Request a new one.");
}

// Atomic finalize. Returns false when the row was not in its claimed state
// (which must not happen after a claim; the endpoint treats it as uncertainty).
export async function completeMediaUploadIntent(
  intentId: string,
  storagePath: string,
  uploadedBytes: number,
): Promise<boolean> {
  const { rowCount } = await databasePool().query(
    `UPDATE public.mcp_media_upload_intents
     SET status = 'uploaded', storage_path = $2, uploaded_bytes = $3, uploaded_at = NOW()
     WHERE id = $1 AND status = 'pending' AND consumed_at IS NOT NULL`,
    [intentId, storagePath, uploadedBytes],
  );
  return rowCount === 1;
}

// Best-effort terminal state after a failed upload. Never throws: the endpoint
// already has a real error to report.
export async function failMediaUploadIntent(intentId: string): Promise<void> {
  try {
    await databasePool().query(
      `UPDATE public.mcp_media_upload_intents
       SET status = 'failed'
       WHERE id = $1 AND status = 'pending'`,
      [intentId],
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "media_upload_intent_failure_record_failed",
      intentId,
      error: error instanceof Error ? error.message : "Unknown failure-record error.",
    }));
  }
}

// Composes the tool-visible instruction payload. The raw token appears here
// exactly once; it is single-use, upload-only, and short-lived (hashed at rest).
export function buildUploadInstructions(intent: CreatedMediaUploadIntent): {
  intentId: string;
  kind: MediaUploadKind;
  contentType: string;
  filename: string;
  declaredSizeBytes: number;
  maxBytes: number;
  upload: {
    method: "POST";
    endpoint: string;
    headers: Record<string, string>;
    body: string;
  };
  uploadToken: string;
  command: string;
  steps: string[];
  fallbackUrl?: string;
  expiresAt: string;
  expiresInMinutes: number;
  note: string;
} {
  const endpoint = mediaUploadEndpointUrl();
  const minutes = Math.max(1, Math.round(config.mediaUploadIntentTtlSeconds / 60));
  const command = [
    `curl -X POST --data-binary "@/path/to/${intent.filename || "file"}" \\`,
    `  -H "Authorization: Bearer ${intent.token}" \\`,
    `  -H "Content-Type: ${intent.contentType}" \\`,
    `  "${endpoint}"`,
  ].join("\n");
  return {
    intentId: intent.intentId,
    kind: intent.kind,
    contentType: intent.contentType,
    filename: intent.filename,
    declaredSizeBytes: intent.expectedBytes,
    maxBytes: intent.maxBytes,
    upload: {
      method: "POST",
      endpoint,
      headers: {
        authorization: `Bearer ${intent.token}`,
        "content-type": intent.contentType,
      },
      body: "The raw file bytes (no multipart wrapper).",
    },
    uploadToken: intent.token,
    command,
    steps: [
      "Run the curl command from an environment that can read the file's bytes. In Claude.ai code execution the chat attachment is available on a local path in the sandbox (for example /mnt/user-data/uploads); in Claude Code the file is on disk. If the sandbox cannot reach the endpoint, use the fallback upload instead.",
      "The response JSON contains a permanent storagePath — pass it as imageStoragePath in social_publish, or as media[].storagePath / documentStoragePath in social_schedule_media or social_schedule_posts. Do not paste any signed URL.",
    ],
    ...(fallbackMediaUploadPageUrl() ? { fallbackUrl: fallbackMediaUploadPageUrl() as string } : {}),
    expiresAt: intent.expiresAt,
    expiresInMinutes: minutes,
    note: "The upload token is single-use, expires at the time shown, and is only valid for one upload of this kind. It is not an MCP access token. If the upload fails or you skip it, request a new intent. Keep the token out of URLs and logs; it is shown here because the sandbox itself must perform the upload.",
  };
}
