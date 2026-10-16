import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { config } from "@/lib/backend";

import * as schema from "./schema";

const globalForDb = globalThis as unknown as { scheduledMediaDbPool?: Pool };

function connectionString(): string {
  return (process.env.DATABASE_URL?.trim() || config.databaseUrl || "").trim();
}

const pool = globalForDb.scheduledMediaDbPool ?? new Pool({
  connectionString: connectionString(),
  max: 5,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  keepAlive: true,
});

if (process.env.NODE_ENV !== "production") {
  globalForDb.scheduledMediaDbPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
