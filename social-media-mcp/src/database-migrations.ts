import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databasePool } from "./database.js";

const migrationNames = [
  "001_scheduled_posts.sql",
  "002_scheduled_posts_constraints.sql",
  "003_cloud_scheduling.sql",
  "005_linkedin_documents.sql",
  "006_scheduled_post_media.sql",
  "007_multi_user.sql",
  "008_oauth_sessions.sql",
  "009_user_app_credentials.sql",
  "010_mcp_oauth.sql",
  "011_mcp_media_upload_intents.sql",
];

let migrations: Promise<void> | undefined;

export function ensureDatabaseMigrations(): Promise<void> {
  if (!migrations) {
    migrations = (async () => {
      const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
      for (const name of migrationNames) {
        await databasePool().query(await readFile(path.join(directory, name), "utf8"));
      }
    })().catch((error: unknown) => {
      migrations = undefined;
      throw error;
    });
  }
  return migrations;
}
