import { randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { config } from "./config/env.js";
import { loadTokens } from "./auth/token-store.js";
import { registerScheduledMedia, unregisterScheduledMedia } from "./auth/oauth.js";
import { publishMeta } from "./platforms/meta.js";
import { publishLinkedIn } from "./platforms/linkedin.js";
import type { MetaPlatform, Platform, PublishedPost } from "./platforms/types.js";
import {
  validateScheduledImageWithRetries,
  type ScheduledImageValidation,
} from "./utils/scheduled-image.js";

export interface NewScheduledPost {
  platform: Platform;
  scheduledAt: string;
  text: string;
}

export function canSafelyRetryScheduledPost(
  status: ScheduledPost["status"],
  failureStage: ScheduledPost["failureStage"],
): boolean {
  return status === "failed" && failureStage === "image_validation";
}

interface ScheduledPost extends NewScheduledPost {
  id: string;
  imageToken: string;
  imagePath: string;
  contentType: string;
  status: "scheduled" | "publishing" | "published" | "failed";
  createdAt: string;
  publishedAt?: string;
  result?: PublishedPost;
  error?: string;
  retryCount: number;
  failureStage?: "image_validation" | "publishing";
  imageValidation?: ScheduledImageValidation;
}

interface ScheduledPostRow extends QueryResultRow {
  id: string;
  platform: Platform;
  scheduled_at: Date;
  text: string;
  image_token: string;
  image_path: string;
  content_type: string;
  status: ScheduledPost["status"];
  created_at: Date;
  published_at: Date | null;
  result: PublishedPost | null;
  error: string | null;
  retry_count: number;
  failure_stage: "image_validation" | "publishing" | null;
  image_validation: ScheduledImageValidation | null;
}

const schedulerDirectory = path.dirname(config.tokenFile);
const mediaDirectory = path.join(schedulerDirectory, "scheduled-media");
const migrationPath = fileURLToPath(new URL("../migrations/001_scheduled_posts.sql", import.meta.url));
const textLimits: Record<Platform, number> = { instagram: 2200, facebook: 63206, linkedin: 3000 };
let pool: Pool | undefined;
let initialization: Promise<void> | undefined;
let tickTimer: NodeJS.Timeout | undefined;
let tickRunning = false;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown publishing error.";
  return message.replace(/(client_secret|access_token|refresh_token|authorization_code|code)=([^&\s]+)/gi, "$1=[redacted]").slice(0, 700);
}

function databasePool(): Pool {
  if (!config.databaseUrl) throw new Error("Set DATABASE_URL to a PostgreSQL connection string to use scheduled posts.");
  pool ??= new Pool({ connectionString: config.databaseUrl });
  return pool;
}

async function ensureScheduleStore(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      const migration = await readFile(migrationPath, "utf8");
      await databasePool().query(migration);
      await databasePool().query(`
        UPDATE scheduled_posts
        SET status = 'failed',
            error = 'Scheduler stopped during publishing. Check the platform before retrying to avoid a duplicate post.',
            failure_stage = COALESCE(failure_stage, 'publishing'),
            claimed_at = NULL,
            updated_at = NOW()
        WHERE status = 'publishing'
          AND claimed_at < NOW() - INTERVAL '30 minutes'
      `);
    })().catch((error: unknown) => {
      initialization = undefined;
      throw error;
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
    contentType: row.content_type,
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
    "SELECT * FROM scheduled_posts ORDER BY created_at, id",
  );
  return rows.map(fromRow);
}

async function saveJob(job: ScheduledPost): Promise<void> {
  await ensureScheduleStore();
  const { rowCount } = await databasePool().query(
    `UPDATE scheduled_posts
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
    if (job.status === "scheduled") {
      await registerScheduledMedia(job.imageToken, job.imagePath, job.contentType);
    }
  }
}

async function publishJob(job: ScheduledPost): Promise<void> {
  try {
    let result: PublishedPost;
    if (job.platform === "linkedin") {
      await validateBeforePublishing(job, false);
      job.failureStage = "publishing";
      await saveJob(job);
      result = await publishLinkedIn(job.text, job.imagePath);
    } else {
      await validateBeforePublishing(job, true);
      const imageUrl = `${config.imagePublicBaseUrl}/scheduled-media/${job.imageToken}`;
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

async function runDueJobs(): Promise<void> {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await ensureScheduleStore();
    const { rows } = await databasePool().query<ScheduledPostRow>(`
      WITH due AS (
        SELECT id
        FROM scheduled_posts
        WHERE status = 'scheduled' AND scheduled_at <= NOW()
        ORDER BY scheduled_at
        FOR UPDATE SKIP LOCKED
        LIMIT 10
      )
      UPDATE scheduled_posts AS post
      SET status = 'publishing', claimed_at = NOW(), updated_at = NOW(), error = NULL
      FROM due
      WHERE post.id = due.id
      RETURNING post.*
    `);
    await Promise.all(rows.map((row) => publishJob(fromRow(row))));
  } finally {
    tickRunning = false;
  }
}

export async function startScheduleRunner(): Promise<void> {
  await ensureScheduleStore();
  const currentJobs = await loadJobs();
  if (currentJobs.some((job) => job.status === "scheduled")) await registerPendingMedia();
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    void runDueJobs().catch((error: unknown) => {
      console.error("Scheduled publishing worker failed:", safeError(error));
    });
  }, 1000);
  tickTimer.unref();
}

export async function schedulePosts(
  posts: NewScheduledPost[],
  imagePath: string,
): Promise<Array<Pick<ScheduledPost, "id" | "platform" | "scheduledAt" | "status">>> {
  const sourceImagePath = path.resolve(imagePath);
  const contentType = contentTypeFor(sourceImagePath);
  const currentTime = Date.now();
  for (const post of posts) {
    if (post.platform !== "linkedin" && !config.imagePublicBaseUrl.startsWith("https://")) {
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
  const tokens = await loadTokens();
  for (const post of posts) {
    if (!tokens[post.platform]) throw new Error(`${post.platform} is not connected; authorize it before scheduling.`);
  }

  await ensureScheduleStore();
  await mkdir(mediaDirectory, { recursive: true });
  const storedImagePath = path.join(mediaDirectory, `${randomBytes(16).toString("hex")}${path.extname(sourceImagePath).toLowerCase()}`);
  const image = await readFile(sourceImagePath);
  if (!image.byteLength) throw new Error("The selected schedule image file is empty.");
  await writeFile(storedImagePath, image, { mode: 0o600, flag: "wx" });

  const createdAt = new Date().toISOString();
  const createdJobs: ScheduledPost[] = posts.map((post) => ({
    ...post,
    id: randomBytes(16).toString("hex"),
    imageToken: randomBytes(32).toString("hex"),
    imagePath: storedImagePath,
    contentType,
    status: "scheduled",
    createdAt,
    retryCount: 0,
  }));
  let client: PoolClient | undefined;
  let transactionStarted = false;
  try {
    client = await databasePool().connect();
    for (const job of createdJobs) await registerScheduledMedia(job.imageToken, job.imagePath, job.contentType);
    await client.query("BEGIN");
    transactionStarted = true;
    for (const job of createdJobs) {
      await client.query(
        `INSERT INTO scheduled_posts
          (id, platform, scheduled_at, text, image_token, image_path, content_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [job.id, job.platform, job.scheduledAt, job.text, job.imageToken, job.imagePath, job.contentType, job.status, job.createdAt],
      );
    }
    await client.query("COMMIT");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await client?.query("ROLLBACK").catch(() => undefined);
    for (const job of createdJobs) {
      unregisterScheduledMedia(job.imageToken);
    }
    await unlink(storedImagePath).catch(() => undefined);
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
  failureStage?: "image_validation" | "publishing";
  imageValidation?: ScheduledImageValidation;
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
      "SELECT * FROM scheduled_posts WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    const row = rows[0];
    if (!row) throw new Error(`Scheduled post ${jobId} was not found.`);
    if (row.status !== "failed") throw new Error(`Only failed posts can be retried; this post is ${row.status}.`);
    if (!canSafelyRetryScheduledPost(row.status, row.failure_stage ?? undefined)) {
      throw new Error("This post failed during publishing, so its outcome may be uncertain. Verify the platform before scheduling a new post; automatic retry is blocked to prevent duplicates.");
    }
    await registerScheduledMedia(row.image_token, row.image_path, row.content_type);
    const scheduledAt = new Date().toISOString();
    await client.query(
      `UPDATE scheduled_posts
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
