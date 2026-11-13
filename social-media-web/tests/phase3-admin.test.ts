import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseDateRange,
  parsePagination,
  parsePostFilters,
  parseSocialAccountFilters,
  validateAccountAction,
  type AccountTarget,
} from "@/lib/admin-policy";
import {
  resetWorkerThrottleForTests,
  tryAcquireWorkerSlot,
  WORKER_THROTTLE_WINDOW_MS,
} from "@/lib/worker-throttle";

const readFile = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), "utf8");

function walk(relative: string): string[] {
  const root = path.resolve(process.cwd(), relative);
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) out.push(...walk(path.relative(process.cwd(), full)));
    else out.push(path.relative(process.cwd(), full));
  }
  return out;
}

function target(overrides: Partial<AccountTarget> = {}): AccountTarget {
  return {
    id: "user-2",
    role: "user",
    approvalStatus: "approved",
    banned: false,
    deletedAt: null,
    ...overrides,
  };
}

describe("admin pagination and filters", () => {
  it("normalises page and page size and caps the page size", () => {
    expect(parsePagination({})).toEqual({ page: 1, pageSize: 25, offset: 0 });
    expect(parsePagination({ page: "3", pageSize: "10" })).toEqual({
      page: 3,
      pageSize: 10,
      offset: 20,
    });
    expect(parsePagination({ pageSize: "5000" }).pageSize).toBe(100);
    expect(parsePagination({ page: "-1", pageSize: "abc" })).toEqual({
      page: 1,
      pageSize: 25,
      offset: 0,
    });
    expect(parsePagination(new URLSearchParams("page=2&pageSize=5"))).toEqual({
      page: 2,
      pageSize: 5,
      offset: 5,
    });
  });

  it("builds an inclusive date range and prevents unbounded scans", () => {
    const now = Date.UTC(2026, 5, 15, 12, 0, 0);
    const defaults = parseDateRange({}, { now, defaultDays: 30 });
    expect(defaults.days).toBe(30);
    expect(defaults.toIso).toBe(new Date(now).toISOString());

    const explicit = parseDateRange(
      { from: "2026-01-01", to: "2026-01-31" },
      { now, maxDays: 366 },
    );
    expect(explicit.days).toBe(31);
    expect(explicit.fromIso).toBe("2026-01-01T00:00:00.000Z");
    expect(explicit.toIso).toBe("2026-01-31T23:59:59.999Z");

    const clamped = parseDateRange(
      { from: "2020-01-01", to: "2026-01-01" },
      { now, maxDays: 31 },
    );
    expect(clamped.days).toBe(31);

    const reversed = parseDateRange(
      { from: "2026-02-01", to: "2026-01-01" },
      { now },
    );
    expect(new Date(reversed.fromIso).getTime()).toBeLessThan(
      new Date(reversed.toIso).getTime(),
    );
  });

  it("whitelists post filters and trims queries", () => {
    const filters = parsePostFilters({
      q: `  ${"a".repeat(300)}  `,
      status: "HELD",
      platform: "LINKEDIN",
    });
    expect(filters.query).toHaveLength(100);
    expect(filters.status).toBe("held");
    expect(filters.platform).toBe("linkedin");

    const invalid = parsePostFilters({ status: "bogus", platform: "bogus" });
    expect(invalid.status).toBe("all");
    expect(invalid.platform).toBe("all");
  });

  it("whitelists social-account filters", () => {
    const social = parseSocialAccountFilters({
      platform: "FACEBOOK",
      status: "EXPIRED",
    });
    expect(social.platform).toBe("facebook");
    expect(social.status).toBe("expired");
    expect(social.pageSize).toBe(50);
  });
});

describe("account lifecycle policy", () => {
  it("blocks self-lockout for suspension, deletion, and session revocation", () => {
    const self = target({ id: "admin-1", role: "admin" });
    for (const action of ["suspend", "soft_delete", "revoke_sessions"] as const) {
      const violation = validateAccountAction({
        action,
        actorId: "admin-1",
        target: self,
      });
      expect(violation?.status).toBe(409);
    }
  });

  it("protects the Super Admin from suspension and deletion", () => {
    for (const action of ["suspend", "soft_delete"] as const) {
      expect(
        validateAccountAction({
          action,
          actorId: "admin-1",
          target: target({ role: "admin" }),
        })?.status,
      ).toBe(409);
    }
  });

  it("rejects invalid transitions and accepts valid ones", () => {
    expect(
      validateAccountAction({
        action: "suspend",
        actorId: "admin-1",
        target: target({ banned: true }),
      })?.status,
    ).toBe(409);
    expect(
      validateAccountAction({
        action: "suspend",
        actorId: "admin-1",
        target: target({ deletedAt: new Date() }),
      })?.status,
    ).toBe(409);
    expect(
      validateAccountAction({
        action: "reactivate",
        actorId: "admin-1",
        target: target(),
      })?.status,
    ).toBe(409);
    expect(
      validateAccountAction({
        action: "reactivate",
        actorId: "admin-1",
        target: target({ banned: true }),
      }),
    ).toBeNull();

    expect(
      validateAccountAction({
        action: "soft_delete",
        actorId: "admin-1",
        target: target(),
      }),
    ).toBeNull();
    expect(
      validateAccountAction({
        action: "soft_delete",
        actorId: "admin-1",
        target: target({ deletedAt: new Date() }),
      })?.status,
    ).toBe(409);
    expect(
      validateAccountAction({
        action: "restore",
        actorId: "admin-1",
        target: target(),
      })?.status,
    ).toBe(409);
    expect(
      validateAccountAction({
        action: "restore",
        actorId: "admin-1",
        target: target({ deletedAt: new Date() }),
      }),
    ).toBeNull();

    expect(
      validateAccountAction({
        action: "revoke_sessions",
        actorId: "admin-1",
        target: target(),
      }),
    ).toBeNull();
    expect(
      validateAccountAction({
        action: "revoke_sessions",
        actorId: "admin-1",
        target: target({ deletedAt: new Date() }),
      })?.status,
    ).toBe(409);
  });

  it("rejects an unknown action", () => {
    expect(
      validateAccountAction({
        action: "destroy" as never,
        actorId: "admin-1",
        target: target(),
      })?.status,
    ).toBe(400);
  });
});

describe("worker trigger throttle", () => {
  it("allows one run per user per window and resets after the window", () => {
    resetWorkerThrottleForTests();
    const now = 1_000_000;
    expect(tryAcquireWorkerSlot("u-1", now).allowed).toBe(true);
    expect(tryAcquireWorkerSlot("u-1", now + 1).allowed).toBe(false);
    expect(tryAcquireWorkerSlot("u-2", now + 1).allowed).toBe(true);
    expect(
      tryAcquireWorkerSlot("u-1", now + WORKER_THROTTLE_WINDOW_MS).allowed,
    ).toBe(true);
  });
});

describe("admin API guard", () => {
  const routes = walk("src/app/api/admin").filter((file) =>
    file.endsWith(`${path.sep}route.ts`),
  );

  it("finds every admin route", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it.each(routes)("%s verifies the Super Admin server-side", (file) => {
    const source = readFile(file);
    expect(source).toMatch(/await requireAdmin\(\)/);
    expect(source).toMatch(/apiErrorResponse\(error\)/);
    expect(source).not.toMatch(/requireApiSession/);
    expect(source).not.toMatch(/requireApprovedUser/);
  });

  it("builds account actions from the verified session, never a body user id", () => {
    const account = readFile("src/app/api/admin/users/[id]/account/route.ts");
    expect(account).toMatch(/performAccountAction\(\s*session\.user\.id,/);
    expect(account).toMatch(/z\.enum\(ACCOUNT_ACTIONS\)/);
    expect(account).not.toMatch(/actorId/);
  });

  it("keeps the worker trigger available to approved users with throttling and audit", () => {
    const worker = readFile("src/app/api/worker/run/route.ts");
    expect(worker).toMatch(/requireApiSession\(\)/);
    expect(worker).toMatch(/tryAcquireWorkerSlot\(session\.user\.id\)/);
    expect(worker).toMatch(/action: "worker_run_requested"/);
    expect(worker).toMatch(/action: "worker_run_failed"/);
    expect(worker).not.toMatch(/ownerId/);
    expect(worker).not.toMatch(/SELECT \* FROM/);
  });
});

describe("account lifecycle implementation", () => {
  const accounts = readFile("src/lib/admin-accounts.ts");

  it("commits the user update, session revocation, and audit entry together", () => {
    expect(accounts).toMatch(/await db\.transaction\(async \(tx\) => \{/);
    expect(accounts).toMatch(/validateAccountAction\(/);
    expect(accounts).toMatch(/\.delete\(session\)/);
    expect(accounts).toMatch(/await logActivity\(/);
    expect(accounts).toMatch(/\},\s*tx,\s*\)/);
  });

  it("soft-deletes instead of removing user records", () => {
    expect(accounts).toMatch(/patch\.deletedAt = new Date\(\)/);
    expect(accounts).toMatch(/patch\.deletedAt = null/);
    expect(accounts).not.toMatch(/delete\(user\)/);
  });

  it("holds posts on suspension/deletion and resumes only on reactivation/restore", () => {
    expect(accounts).toMatch(/holdScheduledPostsForUser\(targetId/);
    expect(accounts).toMatch(/resumeScheduledPostsForUser\(targetId/);
    expect(accounts).toMatch(/action === "suspend" \|\| action === "soft_delete"/);
    expect(accounts).toMatch(/action === "reactivate" \|\| action === "restore"/);
  });

  it("logs every lifecycle action", () => {
    for (const action of [
      "user_suspended",
      "user_reactivated",
      "user_soft_deleted",
      "user_restored",
      "user_sessions_revoked",
    ]) {
      expect(accounts).toMatch(new RegExp(action));
    }
  });
});

describe("social account monitoring", () => {
  const social = readFile("src/lib/admin-social-accounts.ts");
  const page = readFile("src/app/(dashboard)/admin/social-accounts/page.tsx");

  it("uses only safe token metadata", () => {
    expect(social).toMatch(/loadTokenMetadata/);
    expect(social).not.toMatch(/loadTokens\b/);
    expect(social).not.toMatch(/accessToken/);
    expect(social).not.toMatch(/refreshToken/);
    expect(social).not.toMatch(/token_ciphertext/);
    expect(page).not.toMatch(/accessToken/);
  });

  it("shows owner, platform, status, sync, expiry, and errors", () => {
    expect(social).toMatch(/userEmail/);
    expect(social).toMatch(/lastSyncAt/);
    expect(social).toMatch(/expiresAt/);
    expect(social).toMatch(/lastError/);
    expect(page).toMatch(/Last sync/);
    expect(page).toMatch(/Token expiry/);
  });

  it("groups connections by owner id before paginating", () => {
    expect(social).toMatch(/groupConnectionsByOwner\(filtered\)/);
    expect(social).toMatch(/filteredUsers: ownerRows\.length/);
    // Statistics keep counting individual connections, not unique owners.
    expect(social).toMatch(/totalConnections: allRows\.length/);
    expect(social).toMatch(/filteredConnections: filtered\.length/);
  });

  it("renders one row per owner with platform details in every column", () => {
    expect(page).toMatch(/result\.rows\.map\(\(row\) => \(/);
    expect(page).toMatch(/key=\{row\.userId\}/);
    expect(page).toMatch(/row\.connections\.map/);
    expect(page).toMatch(/total=\{result\.filteredUsers\}/);
    expect(page).toMatch(/table-fixed/);
    expect(page).toMatch(/<colgroup>/);

    for (const column of [
      "Owner",
      "Platform",
      "Connected account",
      "Status",
      "Last sync",
      "Token expiry",
      "Last error",
    ]) {
      expect(page).toContain(`>${column}<`);
    }
  });

  it("covers every registered user, including users without connections", () => {
    // Owners without any connection are appended as empty rows when no
    // platform/status filter is active.
    expect(social).toMatch(
      /filters\.platform === "all" && filters\.status === "all"/,
    );
    expect(social).toMatch(/connections: \[\]/);
    expect(social).toMatch(/userStatus\(owner\)/);
    // The table renders the fixed platform list with a "Not connected" badge.
    expect(page).toMatch(/PLATFORMS\.map/);
    expect(page).toMatch(/Not connected/);
  });
});

describe("global scheduler", () => {
  const scheduler = readFile("src/lib/admin-scheduler.ts");
  const page = readFile("src/app/(dashboard)/admin/scheduler/page.tsx");

  it("lists posts across all owners, not just the signed-in admin", () => {
    expect(scheduler).toMatch(/FROM public\.scheduled_posts AS post/);
    expect(scheduler).toMatch(/LEFT JOIN "user" AS owner ON owner\.id = post\.user_id/);
    expect(scheduler).toMatch(/owner\.name ILIKE/);
    // The global list query must not filter by a single user id.
    const listQuery = scheduler.slice(
      scheduler.indexOf("SELECT post.id"),
      scheduler.indexOf("const ownerIds"),
    );
    expect(listQuery).not.toMatch(/post\.user_id = /);
  });

  it("delegates hold/resume to the locked MCP scheduler helpers", () => {
    expect(scheduler).toMatch(/holdScheduledPostForUser/);
    expect(scheduler).toMatch(/resumeScheduledPostsForUser/);
    expect(scheduler).toMatch(/Only scheduled posts can be held/);
    expect(scheduler).toMatch(/Only held posts can be resumed/);
    expect(page).toMatch(/DateRangeFilter/);
    expect(page).toMatch(/PostActions/);
  });

  it("renders a fixed-width scheduler table without overlapping columns", () => {
    const contentCell = readFile(
      "src/app/(dashboard)/admin/scheduler/post-content-cell.tsx",
    );
    const errorCell = readFile(
      "src/app/(dashboard)/admin/scheduler/error-cell.tsx",
    );

    // Explicit widths plus a fixed layout stop long content from stretching a
    // column into its neighbours.
    expect(page).toMatch(/table-fixed/);
    expect(page).toMatch(/<colgroup>/);
    expect(page).toMatch(/PostContentCell/);
    expect(page).toMatch(/ErrorCell/);
    expect(contentCell).toMatch(/line-clamp-/);
    expect(contentCell).toMatch(/break-words/);
    expect(errorCell).toMatch(/line-clamp-/);
    expect(errorCell).toMatch(/break-words/);
  });

  it("keeps the scheduler header, statistics, and pagination", () => {
    expect(page).toMatch(
      /Manage scheduled posts across all connected social accounts, monitor/,
    );
    expect(page).toMatch(/AdminPagination/);
    for (const label of ["Scheduled", "Published", "Failed", "Held"]) {
      expect(page).toMatch(new RegExp(`label="${label}"`));
    }
  });

  it("prevents duplicate publishing in the worker claim", () => {
    const worker = readFile("../social-media-mcp/src/scheduler.ts");
    expect(worker).toMatch(/WHERE status = 'scheduled' AND scheduled_at <= NOW\(\)/);
    expect(worker).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(worker).toMatch(/SET status = 'publishing', claimed_at = NOW\(\)/);
    expect(worker).toMatch(/social_media_account_is_active\(user_id\)/);
    expect(worker).toMatch(/Worker stopped during publishing/);
  });

  it("holds around a concurrent claim and preserves retry/uncertain handling", () => {
    const worker = readFile("../social-media-mcp/src/scheduler.ts");
    expect(worker).toMatch(/export async function holdScheduledPostForUser/);
    expect(worker).toMatch(/FOR UPDATE/);
    expect(worker).toMatch(/if \(row\.status !== "scheduled"\)/);
    expect(worker).toMatch(/SET status = 'held', error = \$2, claimed_at = NULL/);
    expect(worker).toMatch(/const overdue = row\.scheduled_at\.getTime\(\) <= Date\.now\(\)/);
    expect(worker).toMatch(/Still held: the original schedule time has passed/);
    expect(worker).toMatch(/retry_count = \$6, failure_stage = \$7/);
  });
});

describe("activity logging coverage", () => {
  it("records auth, admin, social, scheduling, and publishing events", () => {
    const files = {
      auth: readFile("src/lib/auth.ts"),
      admin: readFile("src/lib/admin-accounts.ts"),
      scheduler: readFile("../social-media-mcp/src/scheduler.ts"),
      oauth: readFile("../social-media-mcp/src/auth/oauth.ts"),
    };
    expect(files.auth).toMatch(/action: "user_login"/);
    expect(files.admin).toMatch(/action: ACTION_LABELS\[action\]/);
    expect(files.scheduler).toMatch(/action: "scheduled_post_created"/);
    expect(files.scheduler).toMatch(/action: job\.status === "published" \? "scheduled_post_published" : "scheduled_post_failed"/);
    expect(files.scheduler).toMatch(/action: "scheduled_post_retried"/);
    expect(files.scheduler).toMatch(/action: "scheduled_post_cancelled"/);
    expect(files.scheduler).toMatch(/action: "scheduled_post_rescheduled"/);
    expect(files.scheduler).toMatch(/action: "scheduled_post_hold"/);
    expect(files.scheduler).toMatch(/action: "scheduled_post_resume"/);
    expect(files.oauth).toMatch(/action: "social_account_connected"/);
    expect(files.oauth).toMatch(/action: "social_account_connection_failed"/);
    expect(files.oauth).toMatch(/action: "social_account_connection_cancelled"/);
  });

  it("sanitises activity metadata in both writers", () => {
    for (const file of ["src/lib/activity.ts", "../social-media-mcp/src/utils/activity.ts"]) {
      const source = readFile(file);
      expect(source).toMatch(/FORBIDDEN_META_KEYS/);
      expect(source).toMatch(/sanitize(Activity)?Metadata/);
    }
  });

  it("declares activity metadata as jsonb to match the shared DDL", () => {
    expect(readFile("src/lib/db/schema.ts")).toMatch(/metadata:\s*jsonb\("metadata"\)/);
  });
});

describe("RLS audit migration", () => {
  const migration = readFile("migrations/0003_admin_rls.sql");
  const mcpMigrations = readFile("../social-media-mcp/src/database-migrations.ts");

  it("is additive and never removes data", () => {
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(migration).not.toMatch(/TRUNCATE/i);
    expect(migration).not.toMatch(/DELETE\s+FROM/i);
  });

  it("enables RLS for scheduler and auth tables without forcing owner bypass changes", () => {
    for (const table of ["scheduled_posts", "user", "session", "account", "verification"]) {
      expect(migration).toMatch(new RegExp(`'${table}'`));
    }
    expect(migration).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migration).not.toMatch(/FORCE ROW LEVEL SECURITY/i);
  });

  it("is not auto-applied by the MCP migration list", () => {
    expect(mcpMigrations).not.toMatch(/0003_admin_rls/);
  });
});

describe("admin pages are server-guarded", () => {
  const pages = [
    "src/app/(dashboard)/admin/page.tsx",
    "src/app/(dashboard)/admin/social-accounts/page.tsx",
    "src/app/(dashboard)/admin/scheduler/page.tsx",
    "src/app/(dashboard)/admin/settings/page.tsx",
    "src/app/(dashboard)/users/[id]/page.tsx",
  ];

  it.each(pages)("%s calls requireAdminPage", (file) => {
    expect(readFile(file)).toMatch(/requireAdminPage\(\)/);
  });

  it("keeps the admin navigation out of the regular user interface", () => {
    const sidebar = readFile("src/components/app-sidebar.tsx");
    expect(sidebar).toMatch(/ADMIN_NAV_ITEMS/);
    expect(sidebar).toMatch(/isAdmin \?/);
    expect(sidebar).toMatch(/Social Accounts/);
    expect(sidebar).toMatch(/Scheduler/);
  });
});
