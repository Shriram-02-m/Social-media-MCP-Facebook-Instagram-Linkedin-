import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readFile = (relative: string) => readFileSync(relative, "utf8");

describe("database migration 0002 (admin multi-tenant foundation)", () => {
  const migration = readFile("migrations/0002_admin_multitenant.sql");

  it("adds the Better Auth admin plugin columns", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "role" text NOT NULL DEFAULT 'user'/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "banned" boolean NOT NULL DEFAULT false/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "ban_reason" text/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "ban_expires" timestamp with time zone/i);
  });

  it("adds approval_status and deleted_at with case-correct defaults", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "approval_status" text NOT NULL DEFAULT 'approved'/i);
    expect(migration).toMatch(/SET DEFAULT 'pending'/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone/i);
  });

  it("explicitly marks existing users as approved", () => {
    expect(migration).toMatch(/UPDATE "user" SET "approval_status" = 'approved'/i);
  });

  it("enforces the single-Super-Admin invariant at the database level", () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "user_single_admin_idx"/i);
    expect(migration).toMatch(/WHERE "role" = 'admin'/i);
  });

  it("does not drop or reset any existing data", () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
  });

  it("creates the shared activity log table without secrets-handling columns", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS "activity_log"/i);
    expect(migration).toMatch(/"metadata" jsonb NOT NULL DEFAULT '\{\}'::jsonb/i);
  });
});

describe("Better Auth integration (src/lib/auth.ts)", () => {
  const auth = readFile("src/lib/auth.ts");

  it("integrates the Better Auth 1.7.9 admin plugin with the confirmed roles", () => {
    expect(auth).toMatch(/import \{ admin \} from "better-auth\/plugins\/admin"/);
    expect(auth).toMatch(/admin\(\{\s*adminRoles: \["admin"\],\s*defaultRole: "user",/);
  });

  it("forces every signup to a pending regular user regardless of payload", () => {
    expect(auth).toMatch(/before: async \(user\) => \(\{[\s\S]*data: \{[\s\S]*\.\.\.user,[\s\S]*role: "user",[\s\S]*approvalStatus: "pending",[\s\S]*banned: false,/);
  });

  it("makes approval status server-managed (input: false)", () => {
    expect(auth).toMatch(/approvalStatus: \{[^}]*?input: false,/);
    expect(auth).toMatch(/deletedAt: \{[^}]*?input: false,/);
  });

  it("blocks session creation for soft-deleted and banned accounts", () => {
    expect(auth).toMatch(/if \(user\?\.deletedAt\) return false;/);
    expect(auth).toMatch(/if \(user\?\.banned\) return false;/);
  });

  it("audits signup through the activity log", () => {
    expect(auth).toMatch(/action: "user_signup_pending"/);
  });
});

describe("signup workflow (approval gate)", () => {
  const signup = readFile("src/app/(auth)/signup/signup-form.tsx");

  it("signs out the auto-created session and routes to the pending page", () => {
    expect(signup).toMatch(/await authClient\.signOut\(\);/);
    expect(signup).toMatch(/router\.replace\("\/pending"\)/);
    expect(signup).not.toMatch(/role:/);
    expect(signup).not.toMatch(/approvalStatus:/);
  });
});

describe("authorization layer", () => {
  const api = readFile("src/lib/api.ts");

  it("makes the standard API helper enforce approved-user access", () => {
    expect(api).toMatch(/requireApprovedUser\(\)/);
    expect(api).toMatch(/ApprovalRequiredError/);
  });
});

describe("Super Admin initialization (db:seed-admin)", () => {
  const seed = readFile("scripts/seed-admin.mts");

  it("refuses to create a second Super Admin and promotes inside a transaction", () => {
    expect(seed).toMatch(/A Super Admin already exists/);
    expect(seed).toMatch(/db\.transaction/);
    expect(seed).toMatch(/and\(eq\(user\.role, ADMIN_ROLE\), ne\(user\.id, row\.id\)\)/);
  });

  it("promotes with the full lifecycle state, no hardcoded credentials", () => {
    expect(seed).toMatch(/role: ADMIN_ROLE/);
    expect(seed).toMatch(/approvalStatus: "approved"/);
    expect(seed).toMatch(/banned: false/);
    expect(seed).toMatch(/deletedAt: null/);
    expect(seed).not.toMatch(/ADMIN_PASSWORD\s*=\s*["']/);
  });

  it("audits admin initialization", () => {
    expect(seed).toMatch(/action: "admin_initialized"/);
  });
});

describe("scheduler hold/resume (MCP backend)", () => {
  const scheduler = readFile("../social-media-mcp/src/scheduler.ts");

  it("enforces the account guard in the database claim query", () => {
    expect(scheduler).toMatch(/social_media_account_is_active\(user_id\)/);
    expect(scheduler).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(scheduler).toMatch(/AND public\.social_media_account_is_active\(user_id\)/);
  });

  it("gates new scheduling attempts on the same database-level guard", () => {
    expect(scheduler.match(/assertAccountCanSchedule\(ownerId\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("hold preserves content and locks rows against concurrent claims", () => {
    expect(scheduler).toMatch(/export async function holdScheduledPostsForUser/);
    expect(scheduler).toMatch(/SET status = 'held', error = \$2, claimed_at = NULL/);
    expect(scheduler).not.toMatch(/DELETE FROM public\.scheduled_posts/);
  });

  it("resume never auto-publishes overdue posts", () => {
    expect(scheduler).toMatch(/export async function resumeScheduledPostsForUser/);
    expect(scheduler).toMatch(/const overdue = row\.scheduled_at\.getTime\(\) <= Date\.now\(\)/);
    expect(scheduler).toMatch(/Still held: the original schedule time has passed/);
  });

  it("cancellation and reference counting respect held posts", () => {
    expect(scheduler).toMatch(/status IN \('scheduled', 'held'\)/);
    expect(scheduler).toMatch(/refs\.status IN \('scheduled', 'publishing', 'held'\)/);
  });
});
