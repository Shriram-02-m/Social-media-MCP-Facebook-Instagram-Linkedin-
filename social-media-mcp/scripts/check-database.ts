import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { config } from "../src/config/env.js";

if (!config.databaseUrl) {
  console.error("Database check failed: DATABASE_URL is not configured.");
  process.exitCode = 1;
} else {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    idleTimeoutMillis: config.databaseIdleTimeoutMs,
    keepAlive: true,
  });

  try {
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      const { rows } = await client.query<{ server_time: Date; database: string }>(
        "SELECT NOW() AS server_time, current_database() AS database",
      );
      const cloudSchema = await client.query<{
        has_image_storage_path: boolean;
        has_token_table: boolean;
        token_rls_enabled: boolean;
        bucket_private: boolean;
        anon_can_read_tokens: boolean;
        service_role_can_read_tokens: boolean;
        supports_cancelled_posts: boolean;
        supports_token_validation: boolean;
      }>(`
        SELECT
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'scheduled_posts'
              AND column_name = 'image_storage_path'
          ) AS has_image_storage_path,
          to_regclass('public.oauth_tokens') IS NOT NULL AS has_token_table,
          COALESCE((
            SELECT relrowsecurity FROM pg_class
            WHERE oid = to_regclass('public.oauth_tokens')
          ), FALSE) AS token_rls_enabled,
          COALESCE((
            SELECT NOT public FROM storage.buckets
            WHERE id = 'social-media-images'
          ), FALSE) AS bucket_private,
          has_table_privilege('anon', 'public.oauth_tokens', 'SELECT') AS anon_can_read_tokens,
          has_table_privilege('service_role', 'public.oauth_tokens', 'SELECT') AS service_role_can_read_tokens,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.scheduled_posts'::regclass
              AND conname = 'scheduled_posts_status_check'
              AND pg_get_constraintdef(oid) ILIKE '%cancelled%'
          ) AS supports_cancelled_posts,
          EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'public.scheduled_posts'::regclass
              AND conname = 'scheduled_posts_failure_stage_check'
              AND pg_get_constraintdef(oid) ILIKE '%token_validation%'
          ) AS supports_token_validation
      `);
      const schema = cloudSchema.rows[0];
      if (!schema?.has_image_storage_path || !schema.has_token_table || !schema.token_rls_enabled
        || !schema.bucket_private || schema.anon_can_read_tokens || !schema.service_role_can_read_tokens
        || !schema.supports_cancelled_posts || !schema.supports_token_validation) {
        throw new Error("Cloud schema, private bucket, or token-table access validation failed.");
      }
      await client.query("BEGIN");
      transactionStarted = true;
      const id = randomUUID();
      const imageToken = randomBytes(32).toString("hex");
      await client.query(
        `INSERT INTO public.scheduled_posts
          (id, platform, scheduled_at, text, image_token, image_path, content_type, status,
           created_at, updated_at, published_at, result, error, retry_count, failure_stage,
           image_validation, claimed_at)
         VALUES ($1, 'facebook', NOW(), 'database smoke test (rolled back)', $2,
                 'local-smoke-test-image.png', 'image/png', 'failed',
                 NOW(), NOW(), NULL, NULL, 'smoke test', 0, 'image_validation',
                 $3::jsonb, NULL)`,
        [id, imageToken, JSON.stringify({ valid: false, retryable: false })],
      );
      const inserted = await client.query<{
        status: string;
        retry_count: number;
        failure_stage: string;
        error: string;
        image_validation: { valid?: boolean };
      }>(
        "SELECT status, retry_count, failure_stage, error, image_validation FROM public.scheduled_posts WHERE id = $1",
        [id],
      );
      await client.query(
        `UPDATE public.scheduled_posts
         SET status = 'published', published_at = NOW(), result = $2::jsonb,
             error = NULL, retry_count = 1, failure_stage = NULL, claimed_at = NULL
         WHERE id = $1`,
        [id, JSON.stringify({ platform: "facebook", id: "smoke-test-post", confirmed: true })],
      );
      const updated = await client.query<{ status: string; retry_count: number; result: { confirmed?: boolean } }>(
        "SELECT status, retry_count, result FROM public.scheduled_posts WHERE id = $1",
        [id],
      );
      if (inserted.rows[0]?.status !== "failed"
        || inserted.rows[0]?.retry_count !== 0
        || inserted.rows[0]?.failure_stage !== "image_validation"
        || inserted.rows[0]?.error !== "smoke test"
        || inserted.rows[0]?.image_validation.valid !== false) {
        throw new Error("Scheduled-post insert/retrieval verification failed.");
      }
      if (updated.rows[0]?.status !== "published"
        || updated.rows[0]?.retry_count !== 1
        || updated.rows[0]?.result.confirmed !== true) {
        throw new Error("Scheduled-post status/result update verification failed.");
      }
      await client.query("ROLLBACK");
      transactionStarted = false;
      console.log(`Database connection, cloud schema, private bucket, token RLS, and scheduled-post insert/read/update checks passed. Database: ${rows[0]?.database}; server time: ${rows[0]?.server_time.toISOString()}. Smoke-test row rolled back.`);
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "UNKNOWN";
    console.error(`Database connection/CRUD check failed (error ${code}). Check DATABASE_URL, Supabase connectivity, SSL settings, and applied migrations.`);
    process.exitCode = 1;
  } finally {
    try {
      await pool.end();
    } catch {
      console.error("Database connection check could not close its pool cleanly.");
      process.exitCode = 1;
    }
  }
}
