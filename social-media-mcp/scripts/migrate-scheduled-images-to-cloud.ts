import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { closeDatabasePool, databasePool } from "../src/database.js";
import { ensureDatabaseMigrations } from "../src/database-migrations.js";
import { deleteScheduledImage, uploadScheduledImage } from "../src/storage/scheduled-images.js";

interface PendingImage {
  id: string;
  user_id: string;
  image_path: string;
  content_type: string;
}

async function main(): Promise<void> {
  await ensureDatabaseMigrations();
  const { rows } = await databasePool().query<PendingImage>(
    `SELECT id, user_id, image_path, content_type
     FROM public.scheduled_posts
    WHERE image_storage_path IS NULL
      AND (status = 'scheduled' OR (status = 'failed' AND failure_stage = 'image_validation'))
     ORDER BY scheduled_at, id`,
  );
  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const image = await readFile(row.image_path);
      const extension = row.content_type === "image/png" ? ".png"
        : row.content_type === "image/gif" ? ".gif" : ".jpg";
      const objectPath = await uploadScheduledImage(image, row.content_type, extension, row.user_id);
      const client: PoolClient = await databasePool().connect();
      try {
        const result = await client.query(
         `UPDATE public.scheduled_posts
          SET image_storage_path = $2, updated_at = NOW()
          WHERE id = $1 AND image_storage_path IS NULL
            AND (status = 'scheduled' OR (status = 'failed' AND failure_stage = 'image_validation'))`,
         [row.id, objectPath],
        );
        if (result.rowCount !== 1) {
         await deleteScheduledImage(objectPath);
         continue;
        }
        migrated += 1;
      } finally {
        client.release();
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Unknown migration error.";
      console.error(JSON.stringify({
        event: "scheduled_image_migration_failed",
        jobId: row.id,
        error: message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]"),
      }));
    }
  }
  console.info(`Migrated ${migrated} pending scheduled image(s) to private Supabase Storage; ${failed} failed. Original local files were retained.`);
  if (failed) throw new Error(`${failed} scheduled image(s) need repair before cloud Cron is enabled.`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown scheduled-image migration error.";
    console.error(message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]"));
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool().catch(() => {
    console.error("Could not close the database connection cleanly.");
    process.exitCode = 1;
  }));
