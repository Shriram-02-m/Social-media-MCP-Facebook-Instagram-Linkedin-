import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadEnv() {
  const candidates = [
    path.join(root, ".env.local"),
    path.join(root, ".env"),
    path.join(root, "..", "social-media-mcp", ".env"),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

await loadEnv();

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  console.error("Set DATABASE_URL (web .env.local or social-media-mcp/.env) before running migrations.");
  process.exit(1);
}

const directory = path.join(root, "migrations");
const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();

const client = new Client({ connectionString });
await client.connect();
try {
  for (const file of files) {
    const sql = await readFile(path.join(directory, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("commit");
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
