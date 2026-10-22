import { closeDatabasePool } from "../src/database.js";
import { ensureDatabaseMigrations } from "../src/database-migrations.js";

try {
  await ensureDatabaseMigrations();
  console.info("Database migrations 001-003, 005, 006, and 007 completed. Existing scheduled-post records were preserved.");
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown database migration error.";
  console.error(message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]"));
  process.exitCode = 1;
} finally {
  await closeDatabasePool().catch(() => {
    console.error("Could not close the database connection cleanly.");
    process.exitCode = 1;
  });
}
