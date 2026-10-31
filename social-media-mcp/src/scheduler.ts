import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config/env.js";
import { databasePool } from "./database.js";
import { ensureDatabaseMigrations } from "./database-migrations.js";
import { loadTokens } from "./auth/token-store.js";
import { registerScheduledMedia, unregisterScheduledMedia } from "./auth/oauth.js";
import { publishMeta, publishFacebookVideo, publishInstagramReel, publishInstagramCarousel } from "./platforms/meta.js";
import { linkedinTokenForUse, publishLinkedIn, publishLinkedInWithDocument, publishLinkedInWithImage, publishLinkedInWithVideo } from "./platforms/linkedin.js";
import type { MetaPlatform, Platform, PublishedPost } from "./platforms/types.js";
import {
  assertOwnedStorageObjectPath,
  createScheduledImageUrl,
  deleteScheduledDocument,
  deleteScheduledImage,
  deleteScheduledVideo,
  downloadScheduledDocument,
  downloadScheduledImage,
  downloadScheduledVideo,
  isIsoBmffVideo,
  isPdf,
  matchesMediaSignature,
  uploadScheduledDocument,
  uploadScheduledImage,
  uploadScheduledVideo,
  validateStoredDocument,
  validateStoredImage,
  validateStoredVideo,
} from "./storage/scheduled-images.js";
import {
  validateScheduledImageWithRetries,
  type ScheduledImageValidation,
} from "./utils/scheduled-image.js";

export interface NewScheduledPost {
  platform: Platform;
  scheduledAt: string;
  text: string;
}

export interface NewScheduledDocument {
  // Local stdio callers pass a path; remote MCP callers pass already-fetched
  // bytes so Render never needs access to the client's filesystem. Callers may
  // also pass a permanent private-storage object path returned by the upload
  // API, which is stored as-is and re-downloaded at publish time.
  path?: string;
  bytes?: Buffer;
  contentType?: string;
  title?: string;
  storagePath?: string;
}

export interface NewScheduledImage {
  path?: string;
  bytes?: Buffer;
  contentType?: string;
  extension?: string;
  // Permanent object path in the private bucket. When present the scheduler
  // records it directly instead of uploading bytes again.
  storagePath?: string;
}

export type MediaType = "none" | "image" | "video" | "carousel" | "document";

export interface NewScheduledMedia {
  kind: "image" | "video";
  // Exactly one of `bytes` or `storagePath` is required.
  bytes?: Buffer;
  contentType: string;
  extension: string;
  storagePath?: string;
}

interface ScheduledMediaItem {
  kind: "image" | "video";
  position: number;
  imageToken: string;
  imagePath: string;
  storagePath?: string;
  contentType: string;
}

export function canSafelyRetryScheduledPost(
  status: ScheduledPost["status"],
  failureStage: ScheduledPost["failureStage"],
): boolean {
  return status === "failed"
    && (failureStage === "image_validation" || failureStage === "document_validation" || failureStage === "token_validation");
}

export function canRescheduleScheduledPost(status: ScheduledPost["status"]): boolean {
  // Only posts that have not started publishing can be moved. Once a job is
  // publishing/published (or already cancelled/terminal) its schedule is fixed.
  return status === "scheduled";
}

export function normalizeRescheduledTime(scheduledAt: string, now: number = Date.now()): string {
  const parsed = Date.parse(scheduledAt);
  if (!Number.isFinite(parsed)) {
    throw new Error("Choose a valid date and time for the new schedule.");
  }
  if (parsed <= now) {
    throw new Error("The new schedule time must be in the future.");
  }
  return new Date(parsed).toISOString();
}

// Scheduling has no upper time horizon: a post may be queued hours, days, or
// weeks ahead. Only "must be in the future" is enforced, because the media
// reference is a permanent storage object path rather than an expiring URL.
export function assertFutureScheduleTime(scheduledAt: string, now: number = Date.now()): void {
  const scheduledTime = Date.parse(scheduledAt);
  if (!Number.isFinite(scheduledTime) || scheduledTime <= now) {
    throw new Error("Schedule time must be a valid future ISO-8601 timestamp.");
  }
}

interface ScheduledPost extends NewScheduledPost {
  id: string;
  userId: string;
  imageToken: string;
  imagePath: string;
  imageStoragePath?: string;
  contentType: string;
  documentPath: string;
  documentStoragePath?: string;
  documentContentType?: string;
  documentTitle?: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  createdAt: string;
  publishedAt?: string;
  result?: PublishedPost;
  error?: string;
  retryCount: number;
  mediaType: MediaType;
  failureStage?: "token_validation" | "image_validation" | "document_validation" | "publishing";
  imageValidation?: ScheduledImageValidation;
  media?: ScheduledMediaItem[];
}

interface ScheduledPostRow extends QueryResultRow {
  id: string;
  user_id: string;
  platform: Platform;
  scheduled_at: Date;
  text: string;
  image_token: string;
  image_path: string;
  image_storage_path: string | null;
  content_type: string;
  document_path: string | null;
  document_storage_path: string | null;
  document_content_type: string | null;
  document_title: string | null;
  media_type: string | null;
  status: ScheduledPost["status"];
  created_at: Date;
  published_at: Date | null;
  result: PublishedPost | null;
  error: string | null;
  retry_count: number;
  failure_stage: "token_validation" | "image_validation" | "document_validation" | "publishing" | null;
  image_validation: ScheduledImageValidation | null;
}

interface ScheduledMediaRow extends QueryResultRow {
  id: string;
  post_id: string;
  position: number;
  kind: "image" | "video";
  image_token: string;
  image_path: string;
  storage_path: string | null;
  content_type: string;
  created_at: Date;
}

function inferMediaType(row: ScheduledPostRow): MediaType {
  if (row.media_type) return row.media_type as MediaType;
  if (row.document_storage_path || row.document_path) return "document";
  if (!row.image_path && !row.image_storage_path) return "none";
  return "image";
}

const schedulerDirectory = path.dirname(config.tokenFile);
const mediaDirectory = path.join(schedulerDirectory, "scheduled-media");
const textLimits: Record<Platform, number> = { instagram: 2200, facebook: 63206, linkedin: 3000 };
let initialization: Promise<void> | undefined;
let tickTimer: NodeJS.Timeout | undefined;
let workerRunning = false;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown publishing error.";
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]")
    .replace(/(client_secret|access_token|refresh_token|authorization_code|code)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/https:\/\/[^\s"'<>]+\/storage\/v1\/object\/sign\/[^\s"'<>]+/gi, "[signed image URL redacted]")
    .slice(0, 700);
}

async function ensureScheduleStore(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      await ensureDatabaseMigrations();
    })().catch((error: unknown) => {
      initialization = undefined;
      const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
      console.error(JSON.stringify({
        event: "database_scheduler_initialization_failed",
        code,
        message: safeError(error),
      }));
      throw new Error(`Could not initialize the PostgreSQL scheduler store (database error ${code}). Check DATABASE_URL, Supabase connectivity/SSL, and migration permissions.`);
    });
  }
  await initialization;
}

function fromRow(row: ScheduledPostRow): ScheduledPost {
  return {
    id: row.id,
    userId: row.user_id,
    platform: row.platform,
    scheduledAt: row.scheduled_at.toISOString(),
    text: row.text,
    imageToken: row.image_token,
    imagePath: row.image_path,
    ...(row.image_storage_path ? { imageStoragePath: row.image_storage_path } : {}),
    contentType: row.content_type,
    documentPath: row.document_path ?? "",
    ...(row.document_storage_path ? { documentStoragePath: row.document_storage_path } : {}),
    ...(row.document_content_type ? { documentContentType: row.document_content_type } : {}),
    ...(row.document_title ? { documentTitle: row.document_title } : {}),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    ...(row.published_at ? { publishedAt: row.published_at.toISOString() } : {}),
    ...(row.result ? { result: row.result } : {}),
    ...(row.error ? { error: row.error } : {}),
    retryCount: row.retry_count,
    mediaType: inferMediaType(row),
    ...(row.failure_stage ? { failureStage: row.failure_stage } : {}),
    ...(row.image_validation ? { imageValidation: row.image_validation } : {}),
  };
}

async function attachMediaToJobs(jobs: ScheduledPost[]): Promise<void> {
  if (!jobs.length) return;
  const ids = jobs.map((job) => job.id);
  const { rows } = await databasePool().query<ScheduledMediaRow>(
    "SELECT * FROM public.scheduled_post_media WHERE post_id = ANY($1::text[]) ORDER BY post_id, position",
    [ids],
  );
  const byPost = new Map<string, ScheduledMediaItem[]>();
  for (const row of rows) {
    const list = byPost.get(row.post_id) ?? [];
    list.push({
      kind: row.kind,
      position: row.position,
      imageToken: row.image_token,
      imagePath: row.image_path,
      ...(row.storage_path ? { storagePath: row.storage_path } : {}),
      contentType: row.content_type,
    });
    byPost.set(row.post_id, list);
  }
  for (const job of jobs) {
    const items = byPost.get(job.id);
    if (items && items.length) job.media = items;
  }
}

async function loadJobs(ownerId: string): Promise<ScheduledPost[]> {
  await ensureScheduleStore();
  const { rows } = await databasePool().query<ScheduledPostRow>(
    "SELECT * FROM public.scheduled_posts WHERE user_id = $1 ORDER BY created_at, id",
    [ownerId],
  );
  const jobs = rows.map(fromRow);
  await attachMediaToJobs(jobs);
  return jobs;
}

async function loadAllJobs(): Promise<ScheduledPost[]> {
  await ensureScheduleStore();
  const { rows } = await databasePool().query<ScheduledPostRow>(
    "SELECT * FROM public.scheduled_posts ORDER BY created_at, id",
  );
  const jobs = rows.map(fromRow);
  await attachMediaToJobs(jobs);
  return jobs;
}

async function saveJob(job: ScheduledPost): Promise<void> {
  await ensureScheduleStore();
  const { rowCount } = await databasePool().query(
    `UPDATE public.scheduled_posts
     SET status = $2, published_at = $3, result = $4::jsonb, error = $5,
         retry_count = $6, failure_stage = $7, image_validation = $8::jsonb,
         claimed_at = CASE WHEN $2 = 'publishing' THEN claimed_at ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $9`,
    [
      job.id,
      job.status,
      job.publishedAt ?? null,
      job.result ? JSON.stringify(job.result) : null,
      job.error ?? null,
      job.retryCount,
      job.failureStage ?? null,
      job.imageValidation ? JSON.stringify(job.imageValidation) : null,
      job.userId,
    ],
  );
  if (rowCount !== 1) throw new Error(`Scheduled post ${job.id} was not found while saving its status.`);
}

function contentTypeFor(imagePath: string): string {
  return contentTypeForExtension(path.extname(imagePath).toLowerCase());
}

function contentTypeForExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === ".png") return "image/png";
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".gif") return "image/gif";
  throw new Error("Scheduled images must be PNG, JPEG, or GIF files.");
}

// A caller-supplied permanent storage reference is only valid in the cloud
// storage mode. Local mode has no Supabase bucket to resolve it against.
// Exported for the tool layer (social_publish imageStoragePath support uses the
// same guard as scheduling).
export function requireCloudStorageForReference(): void {
  if (config.scheduledImageStorage !== "supabase") {
    throw new Error("Storage object paths require SCHEDULED_IMAGE_STORAGE=supabase.");
  }
}

async function registerPendingMedia(): Promise<void> {
  const currentJobs = await loadAllJobs();
  for (const job of currentJobs) {
    if (job.status === "scheduled" && job.imagePath) {
      await registerScheduledMedia(job.imageToken, job.imagePath, job.contentType);
    }
  }
}

async function publishJob(job: ScheduledPost): Promise<void> {
  try {
    job.failureStage = "token_validation";
    await saveJob(job);
    if (job.platform === "linkedin") {
      await linkedinTokenForUse(job.userId);
    } else {
      const token = (await loadTokens(job.userId))[job.platform];
      if (!token) throw new Error(`${job.platform} is not connected. Authorize it before retrying this scheduled post.`);
      if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) {
        throw new Error(`${job.platform} access token is expired. Reauthorize the account, then safely retry this post.`);
      }
    }
    delete job.failureStage;
    let result: PublishedPost;
    const media = job.media ?? [];
    const videoItem = job.mediaType === "video" && media.length === 1 ? media[0]! : undefined;
    const carouselItems = job.mediaType === "carousel" ? media : undefined;
    if (job.platform === "linkedin") {
      if (job.documentStoragePath || job.documentPath) {
        await validateDocumentBeforePublishing(job);
        job.failureStage = "publishing";
        await saveJob(job);
        const document = job.documentStoragePath
          ? await downloadScheduledDocument(job.documentStoragePath)
          : { bytes: await readFile(job.documentPath), contentType: job.documentContentType ?? "application/pdf" };
        result = await publishLinkedInWithDocument(
          job.userId,
          job.text,
          document.bytes,
          document.contentType,
          job.documentTitle ?? "Document",
        );
      } else if (videoItem) {
        await validateMediaBeforePublishing(job, [videoItem], false);
        job.failureStage = "publishing";
        await saveJob(job);
        const video = videoItem.storagePath
          ? await downloadScheduledVideo(videoItem.storagePath)
          : { bytes: await readFile(videoItem.imagePath), contentType: videoItem.contentType };
        result = await publishLinkedInWithVideo(job.userId, job.text, video.bytes, video.contentType);
      } else {
        if (!job.imageStoragePath && !job.imagePath) {
          job.failureStage = "publishing";
          await saveJob(job);
          result = await publishLinkedIn(job.userId, job.text);
        } else {
          await validateBeforePublishing(job, false);
          job.failureStage = "publishing";
          await saveJob(job);
          if (job.imageStoragePath) {
            const image = await downloadScheduledImage(job.imageStoragePath);
            result = await publishLinkedInWithImage(job.userId, job.text, image.bytes, image.contentType);
          } else {
            result = await publishLinkedIn(job.userId, job.text, job.imagePath);
          }
        }
      }
    } else if (carouselItems) {
      await validateMediaBeforePublishing(job, carouselItems, true);
      job.failureStage = "publishing";
      await saveJob(job);
      const imageUrls: string[] = [];
      for (const item of carouselItems) imageUrls.push(await mediaPublicUrl(item));
      result = await publishInstagramCarousel(job.userId, job.text, imageUrls);
    } else if (videoItem) {
      await validateMediaBeforePublishing(job, [videoItem], true);
      job.failureStage = "publishing";
      await saveJob(job);
      const videoUrl = await mediaPublicUrl(videoItem);
      result = job.platform === "facebook"
        ? await publishFacebookVideo(job.userId, job.text, videoUrl)
        : await publishInstagramReel(job.userId, job.text, videoUrl);
    } else {
      if (!job.imageStoragePath && !job.imagePath) {
        job.failureStage = "publishing";
        await saveJob(job);
          result = await publishMeta(job.userId, job.platform as MetaPlatform, job.text, undefined);
      } else {
        await validateBeforePublishing(job, true);
        const imageUrl = job.imageStoragePath
          ? await createScheduledImageUrl(job.imageStoragePath)
          : `${config.imagePublicBaseUrl}/scheduled-media/${job.imageToken}`;
        job.failureStage = "publishing";
        await saveJob(job);
        result = await publishMeta(job.userId, job.platform as MetaPlatform, job.text, imageUrl);
      }
    }
    job.status = "published";
    job.publishedAt = new Date().toISOString();
    job.result = result;
    delete job.failureStage;
    console.info(JSON.stringify({
      event: "scheduled_post_published",
      jobId: job.id,
      platform: job.platform,
      retryCount: job.retryCount,
      status: job.status,
    }));
  } catch (error) {
    job.status = "failed";
    job.error = safeError(error);
    if (!job.failureStage) job.failureStage = "publishing";
    console.error(JSON.stringify({
      event: "scheduled_post_failed",
      jobId: job.id,
      platform: job.platform,
      retryCount: job.retryCount,
      failureStage: job.failureStage,
      error: job.error,
      status: job.status,
    }));
  }
  await saveJob(job);
}

async function validateBeforePublishing(job: ScheduledPost, checkPublic: boolean): Promise<void> {
  const startingRetryCount = job.retryCount;
  job.failureStage = "image_validation";
  await saveJob(job);
  if (job.imageStoragePath) {
    for (let attempt = 1; attempt <= config.scheduleImageMaxAttempts; attempt += 1) {
      const validation = await validateStoredImage(job.imageStoragePath, checkPublic);
      const willRetry = !validation.valid && validation.retryable && attempt < config.scheduleImageMaxAttempts;
      job.imageValidation = validation;
      job.retryCount = startingRetryCount + attempt - 1;
      if (validation.error) job.error = validation.error;
      else delete job.error;
      console.info(JSON.stringify({
        event: "scheduled_image_validation",
        jobId: job.id,
        platform: job.platform,
        imageUrl: checkPublic ? "private Supabase Storage signed URL (redacted)" : "private Supabase Storage object",
        validation,
        attempt,
        retryCount: job.retryCount,
      }));
      if (validation.valid) {
        delete job.failureStage;
        delete job.error;
        return;
      }
      if (!willRetry) throw new Error(validation.error ?? "Scheduled image validation failed.");
      job.retryCount += 1;
      await saveJob(job);
      const delayMs = Math.min(
        config.scheduleImageRetryBaseDelayMs * 2 ** (attempt - 1),
        config.scheduleImageRetryMaxDelayMs,
      );
      console.warn(JSON.stringify({
        event: "scheduled_image_validation_retry",
        jobId: job.id,
        platform: job.platform,
        retryCount: job.retryCount,
        delayMs,
        error: validation.error,
      }));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error("Scheduled image retry loop ended unexpectedly.");
  }
  const { validation, retries } = await validateScheduledImageWithRetries({
      imagePath: job.imagePath,
      imageToken: job.imageToken,
      contentType: job.contentType,
      checkPublic,
    },
    config.scheduleImageMaxAttempts,
    config.scheduleImageRetryBaseDelayMs,
    async ({ validation: attemptValidation, attempt, retries: attemptRetries, willRetry, delayMs }) => {
      job.imageValidation = attemptValidation;
      job.retryCount = startingRetryCount + attemptRetries;
      console.info(JSON.stringify({
        event: "scheduled_image_validation",
        jobId: job.id,
        platform: job.platform,
        imageUrl: checkPublic ? "configured IMAGE_PUBLIC_BASE_URL/scheduled-media/[redacted]" : "local scheduled-media route",
        validation: attemptValidation,
        attempt,
        retryCount: job.retryCount,
      }));

      if (attemptValidation.valid) {
        delete job.failureStage;
        return;
      }
      job.failureStage = "image_validation";
      job.error = attemptValidation.error ?? "Scheduled image validation failed.";
      if (willRetry) {
        job.retryCount = startingRetryCount + attemptRetries + 1;
        await saveJob(job);
        console.warn(JSON.stringify({
          event: "scheduled_image_validation_retry",
          jobId: job.id,
          platform: job.platform,
          retryCount: job.retryCount,
          delayMs,
          error: job.error,
        }));
      }
    },
    config.scheduleImageRetryMaxDelayMs,
  );
  job.imageValidation = validation;
  job.retryCount = startingRetryCount + retries;
  delete job.failureStage;
}

interface DocumentValidationResult {
  valid: boolean;
  contentType?: string;
  bytes?: number;
  error?: string;
  retryable: boolean;
}

async function validateStoredOrLocalDocument(job: ScheduledPost): Promise<DocumentValidationResult> {
  if (job.documentStoragePath) return validateStoredDocument(job.documentStoragePath);
  try {
    const bytes = await readFile(job.documentPath);
    if (!bytes.byteLength) return { valid: false, error: "Scheduled document file is empty.", retryable: false };
    if (bytes.byteLength > config.scheduleDocumentMaxBytes) {
      return { valid: false, error: "Scheduled document exceeds SCHEDULE_DOCUMENT_MAX_BYTES.", retryable: false };
    }
    if (!isPdf(bytes)) return { valid: false, error: "Scheduled document is not a valid PDF file.", retryable: false };
    return { valid: true, contentType: "application/pdf", bytes: bytes.byteLength, retryable: false };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    const error_message = code === "ENOENT"
      ? "Scheduled document file is missing from local scheduler storage."
      : "Scheduled document file could not be read from local scheduler storage.";
    return { valid: false, error: error_message, retryable: false };
  }
}

async function validateDocumentBeforePublishing(job: ScheduledPost): Promise<void> {
  const startingRetryCount = job.retryCount;
  job.failureStage = "document_validation";
  await saveJob(job);
  for (let attempt = 1; attempt <= config.scheduleImageMaxAttempts; attempt += 1) {
    const validation = await validateStoredOrLocalDocument(job);
    const willRetry = !validation.valid && validation.retryable && attempt < config.scheduleImageMaxAttempts;
    job.retryCount = startingRetryCount + attempt - 1;
    if (validation.error) job.error = validation.error;
    else delete job.error;
    console.info(JSON.stringify({
      event: "scheduled_document_validation",
      jobId: job.id,
      platform: job.platform,
      document: job.documentStoragePath ? "private Supabase Storage object" : "local scheduled-document file",
      validation,
      attempt,
      retryCount: job.retryCount,
    }));
    if (validation.valid) {
      delete job.failureStage;
      delete job.error;
      return;
    }
    if (!willRetry) throw new Error(validation.error ?? "Scheduled document validation failed.");
    job.retryCount += 1;
    await saveJob(job);
    const delayMs = Math.min(
      config.scheduleImageRetryBaseDelayMs * 2 ** (attempt - 1),
      config.scheduleImageRetryMaxDelayMs,
    );
    console.warn(JSON.stringify({
      event: "scheduled_document_validation_retry",
      jobId: job.id,
      platform: job.platform,
      retryCount: job.retryCount,
      delayMs,
      error: validation.error,
    }));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Scheduled document retry loop ended unexpectedly.");
}

async function mediaPublicUrl(item: ScheduledMediaItem): Promise<string> {
  if (item.storagePath) return createScheduledImageUrl(item.storagePath);
  return `${config.imagePublicBaseUrl}/scheduled-media/${item.imageToken}`;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error("Media endpoint returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Media endpoint exceeded the configured maximum size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function publicRetryable(status?: number): boolean {
  if (status === undefined) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function validatePublicMediaRoute(
  url: string,
  expectedType: string,
  maxBytes: number,
): Promise<{ valid: boolean; status?: number; error?: string; retryable: boolean }> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(config.scheduleImageTimeoutMs) });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Scheduled media URL validation timed out."
      : "Scheduled media URL is not reachable.";
    return { valid: false, error: message, retryable: true };
  }
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel();
    return { valid: false, status, error: `Scheduled media URL returned HTTP ${status}.`, retryable: publicRetryable(status) };
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType !== expectedType) {
    await response.body?.cancel();
    return { valid: false, error: `Scheduled media URL returned invalid MIME type: ${contentType || "missing"}.`, retryable: false };
  }
  try {
    const bytes = await readBoundedResponse(response, maxBytes);
    if (!bytes.byteLength) return { valid: false, error: "Scheduled media URL returned empty data.", retryable: false };
    if (!matchesMediaSignature(bytes, contentType)) {
      return { valid: false, error: `Scheduled media URL did not contain valid ${contentType} data.`, retryable: false };
    }
    return { valid: true, retryable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled media URL validation failed.";
    return { valid: false, error: message, retryable: /timed out|exceeded|not reachable/i.test(message) };
  }
}

async function validateLocalMediaItem(
  item: ScheduledMediaItem,
  checkPublic: boolean,
): Promise<ScheduledImageValidation> {
  const checkedAt = new Date().toISOString();
  const maxBytes = item.kind === "video" ? config.scheduleVideoMaxBytes : config.scheduleImageMaxBytes;
  try {
    const bytes = await readFile(item.imagePath);
    if (!bytes.byteLength) throw new Error("Scheduled media file is empty.");
    if (bytes.byteLength > maxBytes) throw new Error("Scheduled media file exceeds its configured maximum size.");
    if (!matchesMediaSignature(bytes, item.contentType)) {
      throw new Error(`Scheduled media file is not valid ${item.contentType} data.`);
    }
    const local: { valid: boolean; contentType?: string; bytes?: number } = {
      valid: true,
      contentType: item.contentType,
      bytes: bytes.byteLength,
    };
    if (!checkPublic) return { valid: true, checkedAt, local, retryable: false };
    const publicResult = await validatePublicMediaRoute(
      `${config.imagePublicBaseUrl}/scheduled-media/${item.imageToken}`,
      item.contentType,
      maxBytes,
    );
    if (publicResult.valid) {
      return {
        valid: true,
        checkedAt,
        local,
        public: { valid: true, contentType: item.contentType, bytes: bytes.byteLength },
        retryable: false,
      };
    }
    return {
      valid: false,
      checkedAt,
      local,
      public: publicResult,
      ...(publicResult.error ? { error: publicResult.error } : {}),
      retryable: publicResult.retryable,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scheduled media file validation failed.";
    return { valid: false, checkedAt, local: { valid: false, error: message, retryable: false }, error: message, retryable: false };
  }
}

async function validateMediaItem(item: ScheduledMediaItem, checkPublic: boolean): Promise<ScheduledImageValidation> {
  if (item.storagePath) {
    return item.kind === "video"
      ? validateStoredVideo(item.storagePath, checkPublic)
      : validateStoredImage(item.storagePath, checkPublic);
  }
  return validateLocalMediaItem(item, checkPublic);
}

async function validateMediaBeforePublishing(
  job: ScheduledPost,
  items: ScheduledMediaItem[],
  checkPublic: boolean,
): Promise<void> {
  const startingRetryCount = job.retryCount;
  job.failureStage = "image_validation";
  await saveJob(job);
  for (let attempt = 1; attempt <= config.scheduleImageMaxAttempts; attempt += 1) {
    const validations: ScheduledImageValidation[] = [];
    for (const item of items) validations.push(await validateMediaItem(item, checkPublic));
    const firstInvalid = validations.find((validation) => !validation.valid);
    if (validations[0]) job.imageValidation = validations[0];
    job.retryCount = startingRetryCount + attempt - 1;
    if (firstInvalid?.error) job.error = firstInvalid.error;
    else delete job.error;
    console.info(JSON.stringify({
      event: "scheduled_media_validation",
      jobId: job.id,
      platform: job.platform,
      mediaType: job.mediaType,
      itemCount: items.length,
      validations,
      attempt,
      retryCount: job.retryCount,
    }));
    if (!firstInvalid) {
      delete job.failureStage;
      delete job.error;
      return;
    }
    const willRetry = firstInvalid.retryable && attempt < config.scheduleImageMaxAttempts;
    if (!willRetry) throw new Error(firstInvalid.error ?? "Scheduled media validation failed.");
    job.retryCount += 1;
    await saveJob(job);
    const delayMs = Math.min(
      config.scheduleImageRetryBaseDelayMs * 2 ** (attempt - 1),
      config.scheduleImageRetryMaxDelayMs,
    );
    console.warn(JSON.stringify({
      event: "scheduled_media_validation_retry",
      jobId: job.id,
      platform: job.platform,
      retryCount: job.retryCount,
      delayMs,
      error: firstInvalid.error,
    }));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Scheduled media retry loop ended unexpectedly.");
}

export async function processDueJobs(): Promise<number> {
  if (workerRunning) return 0;
  workerRunning = true;
  try {
    await ensureScheduleStore();
    await databasePool().query(`
      UPDATE public.scheduled_posts
      SET status = 'failed',
          error = 'Worker stopped during publishing. Check the platform before retrying to avoid a duplicate post.',
          failure_stage = COALESCE(failure_stage, 'publishing'),
          claimed_at = NULL,
          updated_at = NOW()
      WHERE status = 'publishing'
        AND (claimed_at IS NULL OR claimed_at < NOW() - INTERVAL '30 minutes')
    `);
    const { rows } = await databasePool().query<ScheduledPostRow>(`
      WITH due AS (
        SELECT id
        FROM public.scheduled_posts
        WHERE status = 'scheduled' AND scheduled_at <= NOW()
        ORDER BY scheduled_at
        FOR UPDATE SKIP LOCKED
        LIMIT 10
      )
      UPDATE public.scheduled_posts AS post
      SET status = 'publishing', claimed_at = NOW(), updated_at = NOW(), error = NULL
      FROM due
      WHERE post.id = due.id
      RETURNING post.*
    `);
    const jobs = rows.map(fromRow);
    await attachMediaToJobs(jobs);
    await Promise.all(jobs.map((job) => publishJob(job)));
    return rows.length;
  } finally {
    workerRunning = false;
  }
}

export async function startScheduleRunner(): Promise<void> {
  await ensureScheduleStore();
  const currentJobs = await loadAllJobs();
  if (config.scheduledImageStorage === "local" && currentJobs.some((job) => job.status === "scheduled")) {
    await registerPendingMedia();
  }
  if (config.schedulerMode !== "local") return;
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void processDueJobs().catch((error: unknown) => {
      console.error("Scheduled publishing worker failed:", safeError(error));
    });
  }, 1000);
  tickTimer.unref();
}

export async function schedulePosts(
  ownerId: string,
  posts: NewScheduledPost[],
  image: string | NewScheduledImage,
  document?: NewScheduledDocument,
): Promise<Array<Pick<ScheduledPost, "id" | "platform" | "scheduledAt" | "status">>> {
  const imageInput: NewScheduledImage = typeof image === "string" ? { path: image } : image;
  if (imageInput.storagePath && (imageInput.path || imageInput.bytes)) {
    throw new Error("Provide only one of imagePath, image bytes, or imageStoragePath.");
  }
  const sourceImagePath = imageInput.path ? path.resolve(imageInput.path) : undefined;
  const imageStorageRef = imageInput.storagePath
    ? assertOwnedStorageObjectPath(imageInput.storagePath, ownerId)
    : undefined;
  if (imageStorageRef) requireCloudStorageForReference();
  const extension = (imageInput.extension
    ?? (imageStorageRef
      ? path.extname(imageStorageRef)
      : sourceImagePath
        ? path.extname(sourceImagePath)
        : "")).toLowerCase();
  const contentType = imageInput.contentType
    ?? (imageStorageRef
      ? contentTypeForExtension(extension)
      : sourceImagePath
        ? contentTypeFor(sourceImagePath)
        : "");
  if (!contentType || !extension) {
    throw new Error("Scheduled image requires a path, bytes, or storage object path with a content type and extension.");
  }
  const currentTime = Date.now();
  for (const post of posts) {
    if (config.scheduledImageStorage === "local" && post.platform !== "linkedin" && !config.imagePublicBaseUrl.startsWith("https://")) {
      throw new Error("Scheduled Instagram and Facebook image publishing requires IMAGE_PUBLIC_BASE_URL to be a public HTTPS tunnel URL.");
    }
    try {
      assertFutureScheduleTime(post.scheduledAt, currentTime);
    } catch {
      throw new Error(`The ${post.platform} schedule must be a valid future ISO-8601 timestamp.`);
    }
    if (post.text.length > textLimits[post.platform]) {
      throw new Error(`${post.platform} post text exceeds the ${textLimits[post.platform]}-character limit.`);
    }
  }
  if (document && !posts.some((post) => post.platform === "linkedin")) {
    throw new Error("Documents can only be attached to LinkedIn scheduled posts.");
  }
  const tokens = await loadTokens(ownerId);
  for (const post of posts) {
    if (!tokens[post.platform]) throw new Error(`${post.platform} is not connected; authorize it before scheduling.`);
  }

  await ensureScheduleStore();
  let storedImagePath = "";
  let imageStoragePath: string | undefined;
  if (imageStorageRef) {
    // Permanent private-storage reference from the upload API: record it as-is
    // and let the worker download it at publish time. No expiring URL is stored.
    imageStoragePath = imageStorageRef;
  } else {
    const imageBytes = imageInput.bytes ?? (sourceImagePath ? await readFile(sourceImagePath) : undefined);
    if (!imageBytes) throw new Error("The selected schedule image file is empty.");
    if (!imageBytes.byteLength) throw new Error("The selected schedule image file is empty.");
    if (imageBytes.byteLength > config.scheduleImageMaxBytes) {
      throw new Error("Scheduled image exceeds SCHEDULE_IMAGE_MAX_BYTES.");
    }
    if (config.scheduledImageStorage === "supabase") {
      imageStoragePath = await uploadScheduledImage(imageBytes, contentType, extension, ownerId);
    } else {
      await mkdir(mediaDirectory, { recursive: true });
      storedImagePath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}${extension}`);
      await writeFile(storedImagePath, imageBytes, { mode: 0o600, flag: "wx" });
    }
  }

  let documentFields: Pick<ScheduledPost, "documentPath" | "documentStoragePath" | "documentContentType" | "documentTitle"> = {
    documentPath: "",
  };
  if (document) {
    if (document.storagePath && (document.path || document.bytes)) {
      throw new Error("Provide only one of documentPath, document bytes, or documentStoragePath.");
    }
    const sourceDocumentPath = document.path ? path.resolve(document.path) : undefined;
    if (sourceDocumentPath && path.extname(sourceDocumentPath).toLowerCase() !== ".pdf") {
      throw new Error("Scheduled documents must be PDF files.");
    }
    const documentStorageRef = document.storagePath
      ? assertOwnedStorageObjectPath(document.storagePath, ownerId)
      : undefined;
    if (documentStorageRef) requireCloudStorageForReference();
    const documentContentType = document.contentType ?? "application/pdf";
    if (documentContentType !== "application/pdf") {
      throw new Error("Scheduled documents must be PDF files.");
    }
    const documentTitle = document.title?.trim()
      || (sourceDocumentPath ? path.basename(sourceDocumentPath, path.extname(sourceDocumentPath)) : "Document");
    let storedDocumentPath = "";
    let documentStoragePath: string | undefined;
    if (documentStorageRef) {
      documentStoragePath = documentStorageRef;
    } else {
      const documentBytes = document.bytes ?? (sourceDocumentPath ? await readFile(sourceDocumentPath) : undefined);
      if (!documentBytes) throw new Error("The selected schedule document file is empty.");
      if (!documentBytes.byteLength) throw new Error("The selected schedule document file is empty.");
      if (documentBytes.byteLength > config.scheduleDocumentMaxBytes) {
        throw new Error("Scheduled document exceeds SCHEDULE_DOCUMENT_MAX_BYTES.");
      }
      if (!isPdf(documentBytes)) throw new Error("The selected schedule document is not a valid PDF file.");
      if (config.scheduledImageStorage === "supabase") {
        documentStoragePath = await uploadScheduledDocument(documentBytes, documentContentType, ".pdf", ownerId);
      } else {
        await mkdir(mediaDirectory, { recursive: true });
        storedDocumentPath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}.pdf`);
        await writeFile(storedDocumentPath, documentBytes, { mode: 0o600, flag: "wx" });
      }
    }
    documentFields = {
      documentPath: storedDocumentPath,
      ...(documentStoragePath ? { documentStoragePath } : {}),
      documentContentType,
      documentTitle,
    };
  }

  const createdAt = new Date().toISOString();
  const createdJobs: ScheduledPost[] = posts.map((post) => ({
    ...post,
    id: randomBytes(16).toString("hex"),
    userId: ownerId,
    imageToken: randomBytes(32).toString("hex"),
    imagePath: storedImagePath,
    ...(imageStoragePath ? { imageStoragePath } : {}),
    contentType,
    mediaType: document ? "document" : "image",
    ...(post.platform === "linkedin" ? documentFields : { documentPath: "" }),
    status: "scheduled",
    createdAt,
    retryCount: 0,
  }));
  let client: PoolClient | undefined;
  let transactionStarted = false;
  let commitAttempted = false;
  try {
    client = await databasePool().connect();
    for (const job of createdJobs) {
      if (job.imagePath) await registerScheduledMedia(job.imageToken, job.imagePath, job.contentType);
    }
    await client.query("BEGIN");
    transactionStarted = true;
    for (const job of createdJobs) {
      await client.query(
        `INSERT INTO public.scheduled_posts
          (user_id, id, platform, scheduled_at, text, image_token, image_path, image_storage_path, content_type,
           document_path, document_storage_path, document_content_type, document_title, media_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
        [
          ownerId, job.id, job.platform, job.scheduledAt, job.text, job.imageToken, job.imagePath,
          job.imageStoragePath ?? null, job.contentType,
          job.documentPath, job.documentStoragePath ?? null, job.documentContentType ?? null, job.documentTitle ?? null,
          job.mediaType, job.status, job.createdAt,
        ],
      );
    }
    commitAttempted = true;
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client?.query("ROLLBACK").catch(() => undefined);
    if (!commitAttempted) {
      for (const job of createdJobs) unregisterScheduledMedia(job.imageToken);
    }
    if (!commitAttempted && storedImagePath) await unlink(storedImagePath).catch(() => undefined);
    if (!commitAttempted && imageStoragePath) {
      await deleteScheduledImage(imageStoragePath).catch((cleanupError: unknown) => {
        console.error(JSON.stringify({
          event: "scheduled_image_orphan_cleanup_failed",
          error: safeError(cleanupError),
        }));
      });
    }
    if (!commitAttempted && documentFields.documentPath) await unlink(documentFields.documentPath).catch(() => undefined);
    if (!commitAttempted && documentFields.documentStoragePath) {
      await deleteScheduledDocument(documentFields.documentStoragePath).catch((cleanupError: unknown) => {
        console.error(JSON.stringify({
          event: "scheduled_document_orphan_cleanup_failed",
          error: safeError(cleanupError),
        }));
      });
    }
    if (commitAttempted) {
      console.error(JSON.stringify({
        event: "scheduled_post_commit_uncertain",
        jobIds: createdJobs.map((job) => job.id),
        message: "The database commit outcome is uncertain; uploaded media was retained to avoid breaking possibly committed jobs.",
      }));
    }
    throw error;
  } finally {
    client?.release();
  }
  await startScheduleRunner();
  return createdJobs.map(({ id, platform, scheduledAt, status }) => ({ id, platform, scheduledAt, status }));
}

const imageMediaContentTypes = new Set(["image/jpeg", "image/png", "image/gif"]);
const videoMediaContentTypes = new Set(["video/mp4", "video/quicktime"]);
const extensionsByContentType: Record<string, string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
};

function mediaTypeFor(media: NewScheduledMedia[]): MediaType {
  if (media.length === 0) return "none";
  if (media.length === 1) return media[0]!.kind === "video" ? "video" : "image";
  if (media.every((item) => item.kind === "image")) return "carousel";
  throw new Error("Scheduled media must be a single video or a set of images.");
}

function validateMediaTypeAndExtension(kind: "image" | "video", contentType: string, extension: string): void {
  const normalizedExtension = extension.toLowerCase();
  const allowed = extensionsByContentType[contentType];
  if (kind === "image") {
    if (!imageMediaContentTypes.has(contentType)) throw new Error(`Unsupported scheduled image MIME type: ${contentType}.`);
    if (!allowed?.includes(normalizedExtension)) throw new Error(`Scheduled image extension ${normalizedExtension} does not match ${contentType}.`);
  } else {
    if (!videoMediaContentTypes.has(contentType)) throw new Error(`Unsupported scheduled video MIME type: ${contentType}.`);
    if (!allowed?.includes(normalizedExtension)) throw new Error(`Scheduled video extension ${normalizedExtension} does not match ${contentType}.`);
  }
}

function validateMediaInput(media: NewScheduledMedia): void {
  if (media.storagePath && media.bytes) {
    throw new Error("Provide only one of media bytes or mediaStoragePath for each media item.");
  }
  validateMediaTypeAndExtension(media.kind, media.contentType, media.extension);
  // A permanent storage reference is validated (bytes, MIME type, signature) by
  // the worker when it downloads the object at publish time.
  if (media.storagePath) return;
  if (!media.bytes) throw new Error("A scheduled media item requires bytes or a storage object path.");
  if (media.kind === "image") {
    if (!media.bytes.byteLength) throw new Error("A scheduled image file is empty.");
    if (media.bytes.byteLength > config.scheduleImageMaxBytes) throw new Error("A scheduled image exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  } else {
    if (!media.bytes.byteLength) throw new Error("A scheduled video file is empty.");
    if (media.bytes.byteLength > config.scheduleVideoMaxBytes) throw new Error("A scheduled video exceeds SCHEDULE_VIDEO_MAX_BYTES.");
  }
}

export async function scheduleMediaPosts(
  ownerId: string,
  posts: NewScheduledPost[],
  media: NewScheduledMedia[],
  document?: NewScheduledDocument,
): Promise<Array<Pick<ScheduledPost, "id" | "platform" | "scheduledAt" | "status">>> {
  if (!posts.length) throw new Error("Select at least one platform to schedule.");
  const currentTime = Date.now();
  for (const post of posts) {
    try {
      assertFutureScheduleTime(post.scheduledAt, currentTime);
    } catch {
      throw new Error(`The ${post.platform} schedule must be a valid future ISO-8601 timestamp.`);
    }
    if (post.text.length > textLimits[post.platform]) {
      throw new Error(`${post.platform} post text exceeds the ${textLimits[post.platform]}-character limit.`);
    }
  }
  if (media.length > config.scheduleMediaMaxItems) {
    throw new Error(`A scheduled post can include at most ${config.scheduleMediaMaxItems} media items.`);
  }
  if (document && media.length) throw new Error("Document posts cannot also include image or video media.");
  if (document && !posts.some((post) => post.platform === "linkedin")) {
    throw new Error("Documents can only be attached to LinkedIn scheduled posts.");
  }
  const mediaType = document ? "document" : mediaTypeFor(media);
  const platforms = new Set(posts.map((post) => post.platform));
  if (mediaType === "none" && platforms.has("instagram")) {
    throw new Error("Instagram requires at least one image or video.");
  }
  if (mediaType === "carousel") {
    if (media.length < 2) throw new Error("An Instagram carousel requires at least two images.");
    for (const platform of platforms) {
      if (platform !== "instagram") throw new Error("Instagram carousels can only be published to Instagram.");
    }
  }
  for (const item of media) validateMediaInput(item);
  if (config.scheduledImageStorage === "local") {
    const needsPublicUrl = [...platforms].some((platform) => platform !== "linkedin");
    if (needsPublicUrl && !config.imagePublicBaseUrl.startsWith("https://")) {
      throw new Error("Scheduled Instagram and Facebook publishing requires IMAGE_PUBLIC_BASE_URL to be a public HTTPS tunnel URL.");
    }
  }
  const tokens = await loadTokens(ownerId);
  for (const post of posts) {
    if (!tokens[post.platform]) throw new Error(`${post.platform} is not connected; authorize it before scheduling.`);
  }

  await ensureScheduleStore();

  const storedItems: ScheduledMediaItem[] = [];
  const localFiles: string[] = [];
  const storageObjects: Array<{ path: string; kind: "image" | "video" }> = [];
  let commitAttempted = false;
  let documentFields: Pick<ScheduledPost, "documentPath" | "documentStoragePath" | "documentContentType" | "documentTitle"> = {
    documentPath: "",
  };
  const createdAt = new Date().toISOString();
  try {
    for (let index = 0; index < media.length; index += 1) {
      const item = media[index]!;
      if (item.storagePath) {
        requireCloudStorageForReference();
        const storagePath = assertOwnedStorageObjectPath(item.storagePath, ownerId);
        storedItems.push({ kind: item.kind, position: index, imageToken: "", imagePath: "", storagePath, contentType: item.contentType });
      } else if (config.scheduledImageStorage === "supabase") {
        const bytes = item.bytes!;
        const storagePath = item.kind === "video"
          ? await uploadScheduledVideo(bytes, item.contentType, item.extension.toLowerCase(), ownerId)
          : await uploadScheduledImage(bytes, item.contentType, item.extension.toLowerCase(), ownerId);
        storageObjects.push({ path: storagePath, kind: item.kind });
        storedItems.push({ kind: item.kind, position: index, imageToken: "", imagePath: "", storagePath, contentType: item.contentType });
      } else {
        const bytes = item.bytes!;
        await mkdir(mediaDirectory, { recursive: true });
        const token = randomBytes(32).toString("hex");
        const filePath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}${item.extension.toLowerCase()}`);
        await writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
        localFiles.push(filePath);
        await registerScheduledMedia(token, filePath, item.contentType);
        storedItems.push({ kind: item.kind, position: index, imageToken: token, imagePath: filePath, contentType: item.contentType });
      }
    }

    if (document) {
      if (document.storagePath && (document.path || document.bytes)) {
        throw new Error("Provide only one of documentPath, document bytes, or documentStoragePath.");
      }
      const sourceDocumentPath = document.path ? path.resolve(document.path) : undefined;
      if (sourceDocumentPath && path.extname(sourceDocumentPath).toLowerCase() !== ".pdf") {
        throw new Error("Scheduled documents must be PDF files.");
      }
      const documentStorageRef = document.storagePath
        ? assertOwnedStorageObjectPath(document.storagePath, ownerId)
        : undefined;
      if (documentStorageRef) requireCloudStorageForReference();
      const documentContentType = document.contentType ?? "application/pdf";
      if (documentContentType !== "application/pdf") {
        throw new Error("Scheduled documents must be PDF files.");
      }
      const documentTitle = document.title?.trim()
        || (sourceDocumentPath ? path.basename(sourceDocumentPath, path.extname(sourceDocumentPath)) : "Document");
      let storedDocumentPath = "";
      let documentStoragePath: string | undefined;
      if (documentStorageRef) {
        documentStoragePath = documentStorageRef;
      } else {
        const documentBytes = document.bytes ?? (sourceDocumentPath ? await readFile(sourceDocumentPath) : undefined);
        if (!documentBytes) throw new Error("The selected schedule document file is empty.");
        if (!documentBytes.byteLength) throw new Error("The selected schedule document file is empty.");
        if (documentBytes.byteLength > config.scheduleDocumentMaxBytes) {
          throw new Error("Scheduled document exceeds SCHEDULE_DOCUMENT_MAX_BYTES.");
        }
        if (!isPdf(documentBytes)) throw new Error("The selected schedule document is not a valid PDF file.");
        if (config.scheduledImageStorage === "supabase") {
          documentStoragePath = await uploadScheduledDocument(documentBytes, documentContentType, ".pdf", ownerId);
        } else {
          await mkdir(mediaDirectory, { recursive: true });
          storedDocumentPath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}.pdf`);
          await writeFile(storedDocumentPath, documentBytes, { mode: 0o600, flag: "wx" });
          localFiles.push(storedDocumentPath);
        }
      }
      documentFields = {
        documentPath: storedDocumentPath,
        ...(documentStoragePath ? { documentStoragePath } : {}),
        documentContentType,
        documentTitle,
      };
    }

    const first = storedItems[0];
    const parentImage = first
      ? {
          imageToken: first.imageToken || randomBytes(32).toString("hex"),
          imagePath: first.imagePath,
          ...(first.storagePath ? { imageStoragePath: first.storagePath } : {}),
          contentType: first.contentType,
        }
      : { imageToken: randomBytes(32).toString("hex"), imagePath: "", contentType: "application/octet-stream" };

    const createdJobs: ScheduledPost[] = posts.map((post) => ({
      ...post,
      id: randomBytes(16).toString("hex"),
      userId: ownerId,
      imageToken: parentImage.imageToken,
      imagePath: parentImage.imagePath,
      ...(parentImage.imageStoragePath ? { imageStoragePath: parentImage.imageStoragePath } : {}),
      contentType: parentImage.contentType,
      mediaType,
      ...(post.platform === "linkedin" ? documentFields : { documentPath: "" }),
      status: "scheduled",
      createdAt,
      retryCount: 0,
    }));
    let client: PoolClient | undefined;
    let transactionStarted = false;
    try {
      client = await databasePool().connect();
      await client.query("BEGIN");
      transactionStarted = true;
      for (const job of createdJobs) {
        await client.query(
          `INSERT INTO public.scheduled_posts
            (user_id, id, platform, scheduled_at, text, image_token, image_path, image_storage_path, content_type,
             document_path, document_storage_path, document_content_type, document_title, media_type, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16)`,
          [
            ownerId, job.id, job.platform, job.scheduledAt, job.text, job.imageToken, job.imagePath,
            job.imageStoragePath ?? null, job.contentType,
            job.documentPath, job.documentStoragePath ?? null, job.documentContentType ?? null, job.documentTitle ?? null,
            job.mediaType, job.status, job.createdAt,
          ],
        );
        for (const item of storedItems) {
          await client.query(
            `INSERT INTO public.scheduled_post_media
              (id, post_id, position, kind, image_token, image_path, storage_path, content_type, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              randomBytes(16).toString("hex"), job.id, item.position, item.kind,
              item.imageToken, item.imagePath, item.storagePath ?? null, item.contentType, createdAt,
            ],
          );
        }
      }
      commitAttempted = true;
      await client.query("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await client?.query("ROLLBACK").catch(() => undefined);
      if (commitAttempted) {
        console.error(JSON.stringify({
          event: "scheduled_post_commit_uncertain",
          jobIds: createdJobs.map((job) => job.id),
          message: "The database commit outcome is uncertain; uploaded media was retained to avoid breaking possibly committed jobs.",
        }));
      }
      throw error;
    } finally {
      client?.release();
    }
    await startScheduleRunner();
    return createdJobs.map(({ id, platform, scheduledAt, status }) => ({ id, platform, scheduledAt, status }));
  } catch (error) {
    if (!commitAttempted) {
      for (const item of storedItems) {
        if (!item.storagePath) unregisterScheduledMedia(item.imageToken);
      }
      for (const file of localFiles) await unlink(file).catch(() => undefined);
      for (const object of storageObjects) {
        const cleanup = object.kind === "video" ? deleteScheduledVideo : deleteScheduledImage;
        await cleanup(object.path).catch(() => undefined);
      }
      if (documentFields.documentStoragePath) await deleteScheduledDocument(documentFields.documentStoragePath).catch(() => undefined);
    }
    throw error;
  }
}

export async function scheduledPostStatus(ownerId: string): Promise<Array<{
  id: string;
  platform: Platform;
  text: string;
  scheduledAt: string;
  status: ScheduledPost["status"];
  publishedAt?: string;
  result?: PublishedPost;
  error?: string;
  retryCount: number;
  mediaType: MediaType;
  failureStage?: "token_validation" | "image_validation" | "document_validation" | "publishing";
  imageValidation?: ScheduledImageValidation;
  document?: { title: string; contentType: string };
  media?: Array<{ kind: "image" | "video"; contentType: string }>;
}>> {
  const currentJobs = await loadJobs(ownerId);
  return currentJobs.map((job) => ({
    id: job.id,
    platform: job.platform,
    text: job.text,
    scheduledAt: job.scheduledAt,
    status: job.status,
    mediaType: job.mediaType,
    ...(job.publishedAt ? { publishedAt: job.publishedAt } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    retryCount: job.retryCount,
    ...(job.failureStage ? { failureStage: job.failureStage } : {}),
    ...(job.imageValidation ? { imageValidation: job.imageValidation } : {}),
    ...(job.documentPath || job.documentStoragePath
      ? { document: { title: job.documentTitle ?? "Document", contentType: job.documentContentType ?? "application/pdf" } }
      : {}),
    ...(job.media && job.media.length
      ? { media: job.media.map((item) => ({ kind: item.kind, contentType: item.contentType })) }
      : {}),
  }));
}

export async function retryScheduledPost(ownerId: string, jobId: string): Promise<{
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: "scheduled";
}> {
  await ensureScheduleStore();
  const client = await databasePool().connect();
  let transactionStarted = false;
  let result: { id: string; platform: Platform; scheduledAt: string; status: "scheduled" };
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const { rows } = await client.query<ScheduledPostRow>(
      "SELECT * FROM public.scheduled_posts WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [jobId, ownerId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Scheduled post ${jobId} was not found.`);
    if (row.status !== "failed") throw new Error(`Only failed posts can be retried; this post is ${row.status}.`);
    if (!canSafelyRetryScheduledPost(row.status, row.failure_stage ?? undefined)) {
      throw new Error("This post failed during publishing, so its outcome may be uncertain. Verify the platform before scheduling a new post; automatic retry is blocked to prevent duplicates.");
    }
    if (row.image_path && !row.image_storage_path) {
      await registerScheduledMedia(row.image_token, row.image_path, row.content_type);
    }
    const { rows: mediaRows } = await client.query<ScheduledMediaRow>(
      "SELECT * FROM public.scheduled_post_media WHERE post_id = $1 ORDER BY position",
      [jobId],
    );
    for (const item of mediaRows) {
      if (item.image_path && !item.storage_path) {
        await registerScheduledMedia(item.image_token, item.image_path, item.content_type);
      }
    }
    const scheduledAt = new Date().toISOString();
    await client.query(
      `UPDATE public.scheduled_posts
       SET status = 'scheduled', scheduled_at = $2, error = NULL,
           failure_stage = NULL, retry_count = 0, image_validation = NULL,
           claimed_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [jobId, scheduledAt],
    );
    await client.query("COMMIT");
    transactionStarted = false;
    result = { id: row.id, platform: row.platform, scheduledAt, status: "scheduled" };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await startScheduleRunner();
  return result;
}

export async function cancelScheduledPost(ownerId: string, jobId: string): Promise<{
  id: string;
  platform: Platform;
  status: "cancelled";
}> {
  await ensureScheduleStore();
  const { rows } = await databasePool().query<ScheduledPostRow>(
    `UPDATE public.scheduled_posts
     SET status = 'cancelled', error = 'Cancelled before publishing.', claimed_at = NULL, updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'scheduled'
     RETURNING *`,
    [jobId, ownerId],
  );
  const row = rows[0];
  if (!row) {
    const existing = await databasePool().query<{ status: ScheduledPost["status"] }>(
      "SELECT status FROM public.scheduled_posts WHERE id = $1 AND user_id = $2",
      [jobId, ownerId],
    );
    if (!existing.rowCount) throw new Error(`Scheduled post ${jobId} was not found.`);
    throw new Error(`Only posts that have not started publishing can be cancelled; this post is ${existing.rows[0]!.status}.`);
  }
  unregisterScheduledMedia(row.image_token);
  const { rows: mediaRows } = await databasePool().query<ScheduledMediaRow>(
    "SELECT * FROM public.scheduled_post_media WHERE post_id = $1",
    [jobId],
  );
  const storageObjects: Array<{ kind: "image" | "video"; path: string }> = [];
  const localFiles: string[] = [];
  for (const item of mediaRows) {
    if (item.image_token) unregisterScheduledMedia(item.image_token);
    if (item.storage_path) storageObjects.push({ kind: item.kind, path: item.storage_path });
    else if (item.image_path) localFiles.push(item.image_path);
  }
  if (row.image_storage_path && !mediaRows.some((item) => item.storage_path === row.image_storage_path)) {
    storageObjects.push({ kind: "image", path: row.image_storage_path });
  } else if (!row.image_storage_path && row.image_path && !mediaRows.some((item) => item.image_path === row.image_path)) {
    localFiles.push(row.image_path);
  }
  for (const file of localFiles) await unlink(file).catch(() => undefined);
  for (const object of storageObjects) {
    const cleanup = object.kind === "video" ? deleteScheduledVideo : deleteScheduledImage;
    await cleanup(object.path).catch(() => undefined);
  }
  if (row.document_storage_path) {
    await deleteScheduledDocument(row.document_storage_path).catch(() => undefined);
  } else if (row.document_path) {
    await unlink(row.document_path).catch(() => undefined);
  }
  await databasePool().query(
    "DELETE FROM public.scheduled_post_media WHERE post_id = $1",
    [jobId],
  );
  return { id: row.id, platform: row.platform, status: "cancelled" };
}

export async function rescheduleScheduledPost(
  ownerId: string,
  jobId: string,
  scheduledAt: string,
): Promise<{
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: "scheduled";
}> {
  const normalizedScheduledAt = normalizeRescheduledTime(scheduledAt);
  await ensureScheduleStore();
  const client = await databasePool().connect();
  let transactionStarted = false;
  let result: { id: string; platform: Platform; scheduledAt: string; status: "scheduled" };
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    // Lock the row so a concurrent worker claim (which uses FOR UPDATE SKIP
    // LOCKED) either skips this job or, if it already moved it to `publishing`,
    // is observed below and rejected. The job is never republished at the old
    // time and no duplicate row is created.
    const { rows } = await client.query<ScheduledPostRow>(
      "SELECT * FROM public.scheduled_posts WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [jobId, ownerId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Scheduled post ${jobId} was not found.`);
    if (!canRescheduleScheduledPost(row.status)) {
      throw new Error(`Only scheduled posts can be rescheduled; this post is ${row.status}.`);
    }
    await client.query(
      `UPDATE public.scheduled_posts
       SET scheduled_at = $3, claimed_at = NULL, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [jobId, ownerId, normalizedScheduledAt],
    );
    await client.query("COMMIT");
    transactionStarted = false;
    result = {
      id: row.id,
      platform: row.platform,
      scheduledAt: normalizedScheduledAt,
      status: "scheduled",
    };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await startScheduleRunner();
  return result;
}
