import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { databasePool } from "./database.js";

let migrations: Promise<void> | undefined;

export function ensureDatabaseMigrations(): Promise<void> {
  if (!migrations) {
    migrations = (async () => {
      for (const name of [
        "001_scheduled_posts.sql",
        "002_scheduled_posts_constraints.sql",
        "003_cloud_scheduling.sql",
      ]) {
        const filePath = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
        await databasePool().query(await readFile(filePath, "utf8"));
      }
    })().catch((error: unknown) => {
      migrations = undefined;
      throw error;
    });
  }
  return migrations;
}
