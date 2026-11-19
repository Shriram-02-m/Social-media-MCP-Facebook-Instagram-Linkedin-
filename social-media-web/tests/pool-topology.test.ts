import { describe, expect, it, vi } from "vitest";

import { POOL_MAX } from "@/lib/db";

const { setDatabasePool, databasePool, closeDatabasePool } = await import(
  "../../social-media-mcp/dist/database.js"
);

describe("serverless pool topology", () => {
  it("uses a single pooled connection per Vercel instance", () => {
    // Supabase Transaction Pooler multiplexes backends; a larger per-isolate
    // pool only multiplies client sessions against the pooler's client cap.
    expect(POOL_MAX).toBe(1);
  });

  it("reuses the web pool instead of opening a second backend pool", async () => {
    const sharedPool = {
      query: vi.fn(),
      connect: vi.fn(),
      end: vi.fn(),
      totalCount: 1,
    };

    setDatabasePool(sharedPool as never);
    expect(databasePool()).toBe(sharedPool);

    // Closing from web code must not tear down a pool owned by the web app.
    await closeDatabasePool();
    expect(sharedPool.end).not.toHaveBeenCalled();

    // Restore the injected pool for any later test in this file.
    setDatabasePool(sharedPool as never);
    expect(databasePool()).toBe(sharedPool);
  });
});
