import { closeDatabasePool } from "../src/database.js";
import { ensureDatabaseMigrations } from "../src/database-migrations.js";
import { readLocalTokens, saveCloudTokens } from "../src/auth/token-store.js";
import { config } from "../src/config/env.js";
import type { Platform } from "../src/platforms/types.js";

async function main(): Promise<void> {
  const ownerId = config.ownerUserId;
  const tokens = await readLocalTokens(ownerId);
  const connected = (["facebook", "instagram", "linkedin"] as Platform[])
    .filter((platform) => Boolean(tokens[platform]));
  if (connected.length === 0) throw new Error(`The local encrypted token vault contains no provider tokens for user ${ownerId}.`);
  await ensureDatabaseMigrations();
  await saveCloudTokens(ownerId, tokens, process.argv.includes("--overwrite"));
  console.info(`Migrated encrypted OAuth records for user ${ownerId} (${connected.join(", ")}). The local token vault was left unchanged.`);
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown token migration error.";
    console.error(message.replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "[database URL redacted]"));
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool().catch(() => {
    console.error("Could not close the database connection cleanly.");
    process.exitCode = 1;
  }));
