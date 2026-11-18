import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRODUCTION_ORIGIN,
  LOCAL_DEVELOPMENT_ORIGIN,
  isTrustedOrigin,
  resolveTrustedOrigins,
} from "../src/lib/trusted-origins";

const REPORTED_PREVIEW_HOST
  = "social-media-i4yq1n3a7-shriram-muthuramans-projects.vercel.app";
const REPORTED_PREVIEW_ORIGIN = `https://${REPORTED_PREVIEW_HOST}`;
const UNAPPROVED_ORIGIN = "https://unapproved-attacker.example.com";

describe("resolveTrustedOrigins", () => {
  it("always includes the canonical production origin", () => {
    expect(resolveTrustedOrigins({})).toEqual([CANONICAL_PRODUCTION_ORIGIN]);
  });

  it("includes a valid BETTER_AUTH_URL", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://app.example.com",
    });
    expect(origins).toContain("https://app.example.com");
    expect(isTrustedOrigin("https://app.example.com", origins)).toBe(true);
  });

  it("allows the reported Vercel preview origin through VERCEL_URL", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_URL: CANONICAL_PRODUCTION_ORIGIN,
      VERCEL_URL: REPORTED_PREVIEW_HOST,
    });
    expect(origins).toContain(REPORTED_PREVIEW_ORIGIN);
    expect(isTrustedOrigin(REPORTED_PREVIEW_ORIGIN, origins)).toBe(true);
    expect(isTrustedOrigin(CANONICAL_PRODUCTION_ORIGIN, origins)).toBe(true);
  });

  it("allows a branch deployment through VERCEL_BRANCH_URL", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      VERCEL_BRANCH_URL: "app-git-main-team.vercel.app",
    });
    expect(origins).toContain("https://app-git-main-team.vercel.app");
    expect(isTrustedOrigin("https://app-git-main-team.vercel.app", origins)).toBe(true);
  });

  it("allows an explicitly approved preview origin", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_TRUSTED_ORIGINS: REPORTED_PREVIEW_ORIGIN,
    });
    expect(origins).toContain(REPORTED_PREVIEW_ORIGIN);
    expect(isTrustedOrigin(REPORTED_PREVIEW_ORIGIN, origins)).toBe(true);
  });

  it("rejects an origin that is not on the allowlist", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_URL: CANONICAL_PRODUCTION_ORIGIN,
      VERCEL_URL: REPORTED_PREVIEW_HOST,
    });
    expect(isTrustedOrigin(UNAPPROVED_ORIGIN, origins)).toBe(false);
  });

  it("rejects wildcard patterns instead of broadening the allowlist", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_TRUSTED_ORIGINS: "*,https://*.vercel.app,https://?.example.com",
    });
    expect(origins).toEqual([CANONICAL_PRODUCTION_ORIGIN]);
    expect(isTrustedOrigin("https://attacker.vercel.app", origins)).toBe(false);
  });

  it("rejects insecure http origins in production", () => {
    const origins = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "http://app.example.com",
      BETTER_AUTH_TRUSTED_ORIGINS: "http://preview.example.com",
    });
    expect(origins).toEqual([CANONICAL_PRODUCTION_ORIGIN]);
    expect(isTrustedOrigin("http://preview.example.com", origins)).toBe(false);
  });

  it("trusts localhost only in development", () => {
    const development = resolveTrustedOrigins({
      NODE_ENV: "development",
      BETTER_AUTH_URL: LOCAL_DEVELOPMENT_ORIGIN,
    });
    expect(development).toContain(LOCAL_DEVELOPMENT_ORIGIN);

    const production = resolveTrustedOrigins({
      NODE_ENV: "production",
      BETTER_AUTH_URL: LOCAL_DEVELOPMENT_ORIGIN,
    });
    expect(production).not.toContain(LOCAL_DEVELOPMENT_ORIGIN);
  });

  it("rejects origins with paths, queries, credentials, fragments or other schemes", () => {
    const origins = resolveTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: [
        "https://good.example.com/path",
        "https://good.example.com/?next=/",
        "https://user:pass@good.example.com",
        "https://good.example.com#fragment",
        "ftp://good.example.com",
        "not-an-origin",
      ].join(","),
    });
    expect(origins).toEqual([CANONICAL_PRODUCTION_ORIGIN]);
  });

  it("normalizes and deduplicates exact origins", () => {
    const origins = resolveTrustedOrigins({
      BETTER_AUTH_TRUSTED_ORIGINS: `${CANONICAL_PRODUCTION_ORIGIN}, https://PREVIEW.example.com:443/`,
    });
    expect(origins).toEqual([
      CANONICAL_PRODUCTION_ORIGIN,
      "https://preview.example.com",
    ]);
  });

  it("ignores malformed platform host values", () => {
    const origins = resolveTrustedOrigins({
      VERCEL_URL: "https://attacker.example.com",
      VERCEL_BRANCH_URL: "good.example.com/path",
    });
    expect(origins).toEqual([CANONICAL_PRODUCTION_ORIGIN]);
  });
});

describe("isTrustedOrigin", () => {
  it("matches exact origins only", () => {
    const origins = resolveTrustedOrigins({
      BETTER_AUTH_URL: "https://app.example.com",
    });
    expect(isTrustedOrigin("https://app.example.com/", origins)).toBe(true);
    expect(isTrustedOrigin("https://app.example.com.evil.com", origins)).toBe(false);
    expect(isTrustedOrigin("https://app.example.com:444", origins)).toBe(false);
    expect(isTrustedOrigin("null", origins)).toBe(false);
  });
});

describe("auth.ts trusted-origin wiring", () => {
  const auth = readFileSync("src/lib/auth.ts", "utf8");

  it("passes the resolved allowlist to Better Auth", () => {
    expect(auth).toMatch(/import \{ resolveTrustedOrigins \} from "@\/lib\/trusted-origins";/);
    expect(auth).toMatch(/trustedOrigins,\s*\n\s*emailAndPassword:/);
  });

  it("does not disable CSRF/origin validation or use wildcards", () => {
    expect(auth).not.toMatch(/disableCSRFCheck|disableOriginCheck|skipOriginCheck/);
    expect(auth).not.toMatch(/\*\./);
  });
});
