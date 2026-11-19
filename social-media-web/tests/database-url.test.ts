import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INVALID_PRODUCTION_DATABASE_URL,
  LOOPBACK_PRODUCTION_DATABASE_URL,
  MISSING_PRODUCTION_DATABASE_URL,
  resolveDatabaseUrl,
} from "../src/lib/db/connection-url";

const REMOTE_URL
  = "postgresql://app_user:strong-secret@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require";

describe("resolveDatabaseUrl", () => {
  it("requires DATABASE_URL in a production runtime", () => {
    expect(() => resolveDatabaseUrl({ NODE_ENV: "production" }))
      .toThrow(MISSING_PRODUCTION_DATABASE_URL);
  });

  it("returns a valid remote PostgreSQL URL unchanged", () => {
    expect(resolveDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: REMOTE_URL,
    })).toBe(REMOTE_URL);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: `  ${REMOTE_URL}  `,
    })).toBe(REMOTE_URL);
  });

  it("accepts the backend config fallback only when it is a valid remote URL", () => {
    expect(resolveDatabaseUrl({ NODE_ENV: "production" }, REMOTE_URL)).toBe(REMOTE_URL);
    expect(() => resolveDatabaseUrl(
      { NODE_ENV: "production" },
      "postgresql://user:pass@localhost:5432/app",
    )).toThrow(LOOPBACK_PRODUCTION_DATABASE_URL);
  });

  it("rejects non-PostgreSQL schemes and malformed values", () => {
    expect(() => resolveDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "https://db.example.com",
    })).toThrow(INVALID_PRODUCTION_DATABASE_URL);
    expect(() => resolveDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "not a url",
    })).toThrow(INVALID_PRODUCTION_DATABASE_URL);
    expect(() => resolveDatabaseUrl({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql:///appdb",
    })).toThrow(LOOPBACK_PRODUCTION_DATABASE_URL);
  });

  it("rejects every loopback host form in production", () => {
    const hosts = [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "127.0.0.1",
      "127.42.0.9",
      "[::1]",
    ];
    for (const host of hosts) {
      expect(() => resolveDatabaseUrl({
        NODE_ENV: "production",
        DATABASE_URL: `postgresql://user:pass@${host}:5432/appdb`,
      })).toThrow(LOOPBACK_PRODUCTION_DATABASE_URL);
    }
  });

  it("never includes credentials or the connection string in an error", () => {
    const secret = "super-secret-do-not-log";
    const localUrl = `postgresql://user:${secret}@127.0.0.1:5432/appdb`;
    let thrown: Error | undefined;
    try {
      resolveDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: localUrl });
    } catch (error) {
      thrown = error as Error;
    }
    expect(thrown?.message).toBe(LOOPBACK_PRODUCTION_DATABASE_URL);
    expect(thrown?.message).not.toContain(secret);
    expect(thrown?.message).not.toContain("127.0.0.1");
  });

  it("allows a remote host whose name merely contains 'localhost'", () => {
    const url = "postgresql://user:pass@db.localhost.example.com:5432/appdb";
    expect(resolveDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: url })).toBe(url);
  });

  it("preserves local PostgreSQL support outside production", () => {
    expect(resolveDatabaseUrl({ NODE_ENV: "development" })).toBe("");
    expect(resolveDatabaseUrl({})).toBe("");
    const localUrl = "postgresql://postgres:postgres@127.0.0.1:5432/appdb";
    expect(resolveDatabaseUrl({
      NODE_ENV: "development",
      DATABASE_URL: localUrl,
    })).toBe(localUrl);
  });

  it("does not break the Next.js production build phase", () => {
    expect(resolveDatabaseUrl({
      NODE_ENV: "production",
      NEXT_PHASE: "phase-production-build",
    })).toBe("");
  });
});

describe("database pool wiring", () => {
  const db = readFileSync("src/lib/db/index.ts", "utf8");

  it("uses the strict resolver for the pg connection string", () => {
    expect(db).toMatch(/import \{ resolveDatabaseUrl \} from "@\/lib\/db\/connection-url";/);
    expect(db).toMatch(/return resolveDatabaseUrl\(process\.env, config\.databaseUrl\);/);
  });
});
