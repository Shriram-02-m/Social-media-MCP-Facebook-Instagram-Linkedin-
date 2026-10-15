import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient, QueryResultRow } from "pg";
import { config } from "./config/env.js";
import { databasePool } from "./database.js";
import { ensureDatabaseMigrations } from "./database-migrations.js";
import { loadTokens } from "./auth/token-store.js";
import { registerScheduledMedia, unregisterScheduledMedia } from "./auth/oauth.js";
import { publishMeta } from "./platforms/meta.js";
import { linkedinTokenForUse, publishLinkedIn, publishLinkedInWithDocument, publishLinkedInWithImage } from "./platforms/linkedin.js";
import type { MetaPlatform, Platform, PublishedPost } from "./platforms/types.js";
import {
  createScheduledImageUrl,
  deleteScheduledDocument,
  deleteScheduledImage,
  downloadScheduledDocument,
  downloadScheduledImage,
  isPdf,
  uploadScheduledDocument,
  uploadScheduledImage,
  validateStoredDocument,
  validateStoredImage,
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
  path: string;
  title?: string;
}

export function canSafelyRetryScheduledPost(
  status: ScheduledPost["status"],
  failureStage: ScheduledPost["failureStage"],
): boolean {
  return status === "failed"
    && (failureStage === "image_validation" || failureStage === "document_validation" || failureStage === "token_validation");
}

interface ScheduledPost extends NewScheduledPost {
  id: string;
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
  failureStage?: "token_validation" | "image_validation" | "document_validation" | "publishing";
  imageValidation?: ScheduledImageValidation;
}

interface ScheduledPostRow extends QueryResultRow {
  id: string;
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
  status: ScheduledPost["status"];
  created_at: Date;
  published_at: Date | null;
  result: PublishedPost | null;
  error: string | null;
  retry_count: number;
  failure_stage: "token_validation" | "image_validation" | "document_validation" | "publishing" | null;
  image_validation: ScheduledImageValidation | null;
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
    ...(row.failure_stage ? { failureStage: row.failure_stage } : {}),
    ...(row.image_validation ? { imageValidation: row.image_validation } : {}),
  };
}

async function loadJobs(): Promise<ScheduledPost[]> {
  await ensureScheduleStore();
  const { rows } = await databasePool().query<ScheduledPostRow>(
    "SELECT * FROM public.scheduled_posts ORDER BY created_at, id",
  );
  return rows.map(fromRow);
}

async function saveJob(job: ScheduledPost): Promise<void> {
  await ensureScheduleStore();
  const { rowCount } = await databasePool().query(
    `UPDATE public.scheduled_posts
     SET status = $2, published_at = $3, result = $4::jsonb, error = $5,
         retry_count = $6, failure_stage = $7, image_validation = $8::jsonb,
         claimed_at = CASE WHEN $2 = 'publishing' THEN claimed_at ELSE NULL END,
         updated_at = NOW()
     WHERE id = $1`,
    [
      job.id,
      job.status,
      job.publishedAt ?? null,
      job.result ? JSON.stringify(job.result) : null,
      job.error ?? null,
      job.retryCount,
      job.failureStage ?? null,
      job.imageValidation ? JSON.stringify(job.imageValidation) : null,
    ],
  );
  if (rowCount !== 1) throw new Error(`Scheduled post ${job.id} was not found while saving its status.`);
}

function contentTypeFor(imagePath: string): string {
  const extension = path.extname(imagePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  throw new Error("Scheduled images must be PNG, JPEG, or GIF files.");
}

async function registerPendingMedia(): Promise<void> {
  const currentJobs = await loadJobs();
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
      await linkedinTokenForUse();
    } else {
      const token = (await loadTokens())[job.platform];
      if (!token) throw new Error(`${job.platform} is not connected. Authorize it before retrying this scheduled post.`);
      if (token.expiresAt !== undefined && token.expiresAt <= Date.now()) {
        throw new Error(`${job.platform} access token is expired. Reauthorize the account, then safely retry this post.`);
      }
    }
    delete job.failureStage;
    let result: PublishedPost;
    if (job.platform === "linkedin") {
      if (job.documentStoragePath || job.documentPath) {
        await validateDocumentBeforePublishing(job);
        job.failureStage = "publishing";
        await saveJob(job);
        const document = job.documentStoragePath
          ? await downloadScheduledDocument(job.documentStoragePath)
          : { bytes: await readFile(job.documentPath), contentType: job.documentContentType ?? "application/pdf" };
        result = await publishLinkedInWithDocument(
          job.text,
          document.bytes,
          document.contentType,
          job.documentTitle ?? "Document",
        );
      } else {
        await validateBeforePublishing(job, false);
        job.failureStage = "publishing";
        await saveJob(job);
        if (job.imageStoragePath) {
          const image = await downloadScheduledImage(job.imageStoragePath);
          result = await publishLinkedInWithImage(job.text, image.bytes, image.contentType);
        } else {
          result = await publishLinkedIn(job.text, job.imagePath);
        }
      }
    } else {
      await validateBeforePublishing(job, true);
      const imageUrl = job.imageStoragePath
        ? await createScheduledImageUrl(job.imageStoragePath)
        : `${config.imagePublicBaseUrl}/scheduled-media/${job.imageToken}`;
      job.failureStage = "publishing";
      await saveJob(job);
      result = await publishMeta(job.platform as MetaPlatform, job.text, imageUrl);
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
    await Promise.all(rows.map((row) => publishJob(fromRow(row))));
    return rows.length;
  } finally {
    workerRunning = false;
  }
}

export async function startScheduleRunner(): Promise<void> {
  await ensureScheduleStore();
  const currentJobs = await loadJobs();
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
  posts: NewScheduledPost[],
  imagePath: string,
  document?: NewScheduledDocument,
): Promise<Array<Pick<ScheduledPost, "id" | "platform" | "scheduledAt" | "status">>> {
  const sourceImagePath = path.resolve(imagePath);
  const contentType = contentTypeFor(sourceImagePath);
  const currentTime = Date.now();
  for (const post of posts) {
    if (config.scheduledImageStorage === "local" && post.platform !== "linkedin" && !config.imagePublicBaseUrl.startsWith("https://")) {
      throw new Error("Scheduled Instagram and Facebook image publishing requires IMAGE_PUBLIC_BASE_URL to be a public HTTPS tunnel URL.");
    }
    const scheduledTime = Date.parse(post.scheduledAt);
    if (!Number.isFinite(scheduledTime) || scheduledTime <= currentTime) {
      throw new Error(`The ${post.platform} schedule must be a valid future ISO-8601 timestamp.`);
    }
    if (post.text.length > textLimits[post.platform]) {
      throw new Error(`${post.platform} post text exceeds the ${textLimits[post.platform]}-character limit.`);
    }
  }
  if (document && !posts.some((post) => post.platform === "linkedin")) {
    throw new Error("Documents can only be attached to LinkedIn scheduled posts.");
  }
  const tokens = await loadTokens();
  for (const post of posts) {
    if (!tokens[post.platform]) throw new Error(`${post.platform} is not connected; authorize it before scheduling.`);
  }

  await ensureScheduleStore();
  const image = await readFile(sourceImagePath);
  if (!image.byteLength) throw new Error("The selected schedule image file is empty.");
  if (image.byteLength > config.scheduleImageMaxBytes) {
    throw new Error("Scheduled image exceeds SCHEDULE_IMAGE_MAX_BYTES.");
  }
  let storedImagePath = "";
  let imageStoragePath: string | undefined;
  if (config.scheduledImageStorage === "supabase") {
    imageStoragePath = await uploadScheduledImage(image, contentType, path.extname(sourceImagePath).toLowerCase());
  } else {
    await mkdir(mediaDirectory, { recursive: true });
    storedImagePath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}${path.extname(sourceImagePath).toLowerCase()}`);
    await writeFile(storedImagePath, image, { mode: 0o600, flag: "wx" });
  }

  let documentFields: Pick<ScheduledPost, "documentPath" | "documentStoragePath" | "documentContentType" | "documentTitle"> = {
    documentPath: "",
  };
  if (document) {
    const sourceDocumentPath = path.resolve(document.path);
    if (path.extname(sourceDocumentPath).toLowerCase() !== ".pdf") {
      throw new Error("Scheduled documents must be PDF files.");
    }
    const documentBytes = await readFile(sourceDocumentPath);
    if (!documentBytes.byteLength) throw new Error("The selected schedule document file is empty.");
    if (documentBytes.byteLength > config.scheduleDocumentMaxBytes) {
      throw new Error("Scheduled document exceeds SCHEDULE_DOCUMENT_MAX_BYTES.");
    }
    if (!isPdf(documentBytes)) throw new Error("The selected schedule document is not a valid PDF file.");
    const documentTitle = document.title?.trim() || path.basename(sourceDocumentPath, path.extname(sourceDocumentPath));
    let storedDocumentPath = "";
    let documentStoragePath: string | undefined;
    if (config.scheduledImageStorage === "supabase") {
      documentStoragePath = await uploadScheduledDocument(documentBytes, "application/pdf", ".pdf");
    } else {
      await mkdir(mediaDirectory, { recursive: true });
      storedDocumentPath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}.pdf`);
      await writeFile(storedDocumentPath, documentBytes, { mode: 0o600, flag: "wx" });
    }
    documentFields = {
      documentPath: storedDocumentPath,
      ...(documentStoragePath ? { documentStoragePath } : {}),
      documentContentType: "application/pdf",
      documentTitle,
    };
  }

  const createdAt = new Date().toISOString();
  const createdJobs: ScheduledPost[] = posts.map((post) => ({
    ...post,
    id: randomBytes(16).toString("hex"),
    imageToken: randomBytes(32).toString("hex"),
    imagePath: storedImagePath,
    ...(imageStoragePath ? { imageStoragePath } : {}),
    contentType,
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
          (id, platform, scheduled_at, text, image_token, image_path, image_storage_path, content_type,
           document_path, document_storage_path, document_content_type, document_title, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
        [
          job.id, job.platform, job.scheduledAt, job.text, job.imageToken, job.imagePath,
          job.imageStoragePath ?? null, job.contentType,
          job.documentPath, job.documentStoragePath ?? null, job.documentContentType ?? null, job.documentTitle ?? null,
          job.status, job.createdAt,
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

export async function scheduledPostStatus(): Promise<Array<{
  id: string;
  platform: Platform;
  scheduledAt: string;
  status: ScheduledPost["status"];
  publishedAt?: string;
  result?: PublishedPost;
  error?: string;
  retryCount: number;
  failureStage?: "token_validation" | "image_validation" | "document_validation" | "publishing";
  imageValidation?: ScheduledImageValidation;
  document?: { title: string; contentType: string };
}>> {
  const currentJobs = await loadJobs();
  return currentJobs.map((job) => ({
    id: job.id,
    platform: job.platform,
    scheduledAt: job.scheduledAt,
    status: job.status,
    ...(job.publishedAt ? { publishedAt: job.publishedAt } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    retryCount: job.retryCount,
    ...(job.failureStage ? { failureStage: job.failureStage } : {}),
    ...(job.imageValidation ? { imageValidation: job.imageValidation } : {}),
    ...(job.documentPath || job.documentStoragePath
      ? { document: { title: job.documentTitle ?? "Document", contentType: job.documentContentType ?? "application/pdf" } }
      : {}),
  }));
}

export async function retryScheduledPost(jobId: string): Promise<{
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
      "SELECT * FROM public.scheduled_posts WHERE id = $1 FOR UPDATE",
      [jobId],
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

export async function cancelScheduledPost(jobId: string): Promise<{
  id: string;
  platform: Platform;
  status: "cancelled";
}> {
  await ensureScheduleStore();
  const { rows } = await databasePool().query<ScheduledPostRow>(
    `UPDATE public.scheduled_posts
     SET status = 'cancelled', error = 'Cancelled before publishing.', claimed_at = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'scheduled'
     RETURNING *`,
    [jobId],
  );
  const row = rows[0];
  if (!row) {
    const existing = await databasePool().query<{ status: ScheduledPost["status"] }>(
      "SELECT status FROM public.scheduled_posts WHERE id = $1",
      [jobId],
    );
    if (!existing.rowCount) throw new Error(`Scheduled post ${jobId} was not found.`);
    throw new Error(`Only posts that have not started publishing can be cancelled; this post is ${existing.rows[0]!.status}.`);
  }
  unregisterScheduledMedia(row.image_token);
  return { id: row.id, platform: row.platform, status: "cancelled" };
}
