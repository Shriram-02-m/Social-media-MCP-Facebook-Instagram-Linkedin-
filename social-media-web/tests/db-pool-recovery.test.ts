import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// Integration test against the real database: proves that
// ensureDatabaseConnection() deterministically recovers a pool holding dead
// idle clients (the production failure mode for frozen serverless instances
// whose idle TCP connections are closed by Supabase/Supavisor).
//
// Skipped when no database URL is available (pure-CI environments).
let databaseUrl = process.env.DATABASE_URL?.trim() || "";
if (!databaseUrl) {
  try {
    for (const line of readFileSync(
      path.resolve(__dirname, "../../social-media-mcp/.env"),
      "utf8",
    ).split(/\r?\n/)) {
      const match = /^DATABASE_URL=(.*)$/.exec(line);
      if (match?.[1]) {
        databaseUrl = match[1].trim();
        process.env.DATABASE_URL ??= databaseUrl;
        break;
      }
    }
  } catch {
    // No local env file: the test skips.
  }
}

const { isConnectionError, ensureDatabaseConnection, pool } = await import("@/lib/db");
const { Pool } = await import("pg");

describe.skipIf(!databaseUrl)("database pool zombie recovery", () => {
  it(
    "classifies connection errors without misclassifying query failures",
    () => {
      const reset = Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
      expect(isConnectionError(reset)).toBe(true);
      expect(isConnectionError(new Error("FATAL: sorry, too many clients already"))).toBe(true);
      expect(isConnectionError(new Error('column "x" does not exist'))).toBe(false);
      expect(isConnectionError(new Error("syntax error at or near \"FROM\""))).toBe(false);
    },
  );

  it(
    "drains server-terminated idle clients and restores the pool",
    { timeout: 60000 },
    async () => {
      // Fill the pool with idle clients, kill their backends from a separate
      // connection (exactly what a provider does to a frozen instance's idle
      // sockets), then return them to the pool as idle zombies.
      const held: Array<{ processID?: number; release: (err?: Error | null) => void }> = [];
      try {
        for (let i = 0; i < 3; i += 1) {
          const client = await pool.connect();
          held.push(client as unknown as { processID?: number; release: (err?: Error | null) => void });
        }
        const pids = held.map((client) => client.processID).filter((pid) => pid !== undefined);
        expect(pids).toHaveLength(3);

        const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
        try {
          await adminPool.query(
            `SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid`,
            [pids],
          );
        } finally {
          await adminPool.end();
        }
      } finally {
        // Release regardless of failures so the pool is left in a state where
        // the zombies (or their replacements) are idle, as after a serverless
        // freeze.
        for (const client of held) {
          try {
            client.release();
          } catch {
            // Already removed by the failure path.
          }
        }
      }

      // The recovery helper drains every dead client it is handed and ends
      // with a verified-healthy pooled connection.
      expect(await ensureDatabaseConnection()).toBe(true);

      // And the pool serves queries again.
      const after = await pool.query("SELECT 1 AS ok");
      expect(after.rows[0]?.ok).toBe(1);
    },
  );
});
