import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isActiveApprovalRow,
  summarizeUserStats,
  type UserStatsRow,
} from "@/lib/admin-overview-policy";

const readFile = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), "utf8");

function row(overrides: Partial<UserStatsRow> = {}): UserStatsRow {
  return {
    approvalStatus: "pending",
    banned: false,
    deleted: false,
    total: 1,
    ...overrides,
  };
}

describe("admin overview user statistics", () => {
  it("counts a newly registered pending user", () => {
    expect(summarizeUserStats([row()])).toMatchObject({
      total: 1,
      approved: 0,
      pending: 1,
      rejected: 0,
      suspended: 0,
      deleted: 0,
    });
  });

  it("counts approved and rejected users", () => {
    const stats = summarizeUserStats([
      row({ approvalStatus: "approved" }),
      row({ approvalStatus: "rejected" }),
    ]);

    expect(stats).toMatchObject({
      total: 2,
      approved: 1,
      pending: 0,
      rejected: 1,
      suspended: 0,
      deleted: 0,
    });
  });

  it("aggregates multiple users with different statuses without double counting", () => {
    const stats = summarizeUserStats([
      row({ approvalStatus: "approved", total: 3 }),
      row({ approvalStatus: "pending", total: 2 }),
      row({ approvalStatus: "rejected", total: 4 }),
      row({ approvalStatus: "approved", banned: true, total: 1 }),
      row({ approvalStatus: "pending", deleted: true, total: 1 }),
    ]);

    expect(stats).toEqual({
      total: 11,
      approved: 3,
      pending: 2,
      rejected: 4,
      suspended: 1,
      deleted: 1,
    });
    expect(
      stats.approved + stats.pending + stats.rejected + stats.suspended + stats.deleted,
    ).toBe(stats.total);
  });

  it("does not count suspended users as approved, pending, or rejected", () => {
    const stats = summarizeUserStats([
      row({ approvalStatus: "pending", banned: true, total: 2 }),
    ]);

    expect(stats).toMatchObject({
      total: 2,
      approved: 0,
      pending: 0,
      rejected: 0,
      suspended: 2,
    });
  });

  it("does not count soft-deleted users as approved, pending, or rejected", () => {
    const stats = summarizeUserStats([
      row({ approvalStatus: "rejected", deleted: true, total: 2 }),
    ]);

    expect(stats).toMatchObject({
      total: 2,
      approved: 0,
      pending: 0,
      rejected: 0,
      deleted: 2,
    });
  });

  it("counts a deleted suspended account only once, as deleted", () => {
    const stats = summarizeUserStats([
      row({ approvalStatus: "approved", banned: true, deleted: true }),
    ]);

    expect(stats).toEqual({
      total: 1,
      approved: 0,
      pending: 0,
      rejected: 0,
      suspended: 0,
      deleted: 1,
    });
  });

  it("reflects status changes because each summary is derived from current rows", () => {
    const before = summarizeUserStats([row({ approvalStatus: "pending" })]);
    const after = summarizeUserStats([row({ approvalStatus: "approved" })]);

    expect(before).toMatchObject({ total: 1, pending: 1, approved: 0 });
    expect(after).toMatchObject({ total: 1, pending: 0, approved: 1 });
  });
});

describe("approval counts across account states", () => {
  type TestApprovalStatus = "approved" | "pending" | "rejected";

  interface TestUser {
    id: string;
    approvalStatus: TestApprovalStatus;
    banned: boolean;
    deleted: boolean;
  }

  const users: TestUser[] = [
    { id: "approved-active", approvalStatus: "approved", banned: false, deleted: false },
    { id: "approved-suspended", approvalStatus: "approved", banned: true, deleted: false },
    { id: "approved-deleted", approvalStatus: "approved", banned: false, deleted: true },
    { id: "pending-active", approvalStatus: "pending", banned: false, deleted: false },
    { id: "pending-suspended", approvalStatus: "pending", banned: true, deleted: false },
    { id: "pending-deleted", approvalStatus: "pending", banned: false, deleted: true },
    { id: "rejected-active", approvalStatus: "rejected", banned: false, deleted: false },
    { id: "rejected-suspended", approvalStatus: "rejected", banned: true, deleted: false },
    { id: "rejected-deleted", approvalStatus: "rejected", banned: false, deleted: true },
  ];

  function statsFor(rows: TestUser[]) {
    return summarizeUserStats(
      rows.map(({ approvalStatus, banned, deleted }) => ({
        approvalStatus,
        banned,
        deleted,
        total: 1,
      })),
    );
  }

  function activeUsersFor(status: TestApprovalStatus) {
    return users.filter(
      (account) =>
        account.approvalStatus === status && isActiveApprovalRow(account),
    );
  }

  it("treats suspended or deleted accounts as inactive", () => {
    expect(isActiveApprovalRow({ banned: false, deleted: false })).toBe(true);
    expect(isActiveApprovalRow({ banned: true, deleted: false })).toBe(false);
    expect(isActiveApprovalRow({ banned: false, deleted: true })).toBe(false);
  });

  it("counts only active approved users", () => {
    expect(statsFor(users)).toMatchObject({
      approved: activeUsersFor("approved").length,
    });
    expect(activeUsersFor("approved").map((account) => account.id)).toEqual([
      "approved-active",
    ]);
  });

  it("counts only active pending users", () => {
    expect(statsFor(users)).toMatchObject({
      pending: activeUsersFor("pending").length,
    });
    expect(activeUsersFor("pending").map((account) => account.id)).toEqual([
      "pending-active",
    ]);
  });

  it("counts only active rejected users", () => {
    expect(statsFor(users)).toMatchObject({
      rejected: activeUsersFor("rejected").length,
    });
    expect(activeUsersFor("rejected").map((account) => account.id)).toEqual([
      "rejected-active",
    ]);
  });

  it("keeps every suspended and soft-deleted account in Total Users", () => {
    const stats = statsFor(users);

    expect(stats.total).toBe(users.length);
    expect(stats.suspended).toBe(3);
    expect(stats.deleted).toBe(3);
    expect(
      stats.approved + stats.pending + stats.rejected + stats.suspended + stats.deleted,
    ).toBe(stats.total);
  });

  it("makes every approval count match the active users in its filtered list", () => {
    const stats = statsFor(users);

    for (const status of ["approved", "pending", "rejected"] as const) {
      expect(stats[status]).toBe(activeUsersFor(status).length);
    }
  });
});

describe("admin overview data source and UI", () => {
  const lib = readFile("src/lib/admin-overview.ts");
  const policy = readFile("src/lib/admin-overview-policy.ts");
  const page = readFile("src/app/(dashboard)/admin/page.tsx");
  const route = readFile("src/app/api/admin/overview/route.ts");
  const usersLib = readFile("src/lib/admin-users.ts");
  const filtersLib = readFile("src/lib/admin-user-filters.ts");

  it("aggregates in PostgreSQL instead of loading users into memory", () => {
    expect(lib).toMatch(/\.groupBy\(/);
    expect(lib).toMatch(/count\(\)/);
    expect(lib).not.toMatch(/loadTokenMetadata/);
    expect(lib).not.toMatch(/scheduled_posts/);
    expect(lib).not.toMatch(/\.select\(\)\s*\.from\(user\)/);
  });

  it("classifies pending explicitly instead of using a fallback bucket", () => {
    expect(policy).toMatch(/row\.approvalStatus === "pending"/);
    expect(policy).not.toMatch(/else\s+summary\.pending/);
  });

  it("shares the active-approval rule with the Users directory", () => {
    expect(policy).toMatch(/export function isActiveApprovalRow/);
    expect(policy).toMatch(/!row\.banned && !row\.deleted/);
    expect(filtersLib).toMatch(/eq\(user\.approvalStatus, status\)/);
    expect(filtersLib).toMatch(/eq\(user\.banned, false\)/);
    expect(filtersLib).toMatch(/isNull\(user\.deletedAt\)/);
    expect(usersLib).toMatch(/activeApprovalCondition\(filters\.approval\)/);
    expect(usersLib).toMatch(/getAdminUserStats\(\)/);
    expect(usersLib).toMatch(/total:\s*stats\.total/);
    expect(usersLib).not.toMatch(/groupBy\(user\.approvalStatus\)/);
  });

  it("shows only the four requested user statistics", () => {
    for (const label of [
      "Total Users",
      "Approved Users",
      "Pending Users",
      "Rejected Users",
    ]) {
      expect(page).toContain(label);
    }

    expect(page).not.toContain("Pending / On Hold");
    expect(page).not.toContain("On Hold");

    for (const href of [
      'href: "/users"',
      'href: "/users?approval=approved"',
      'href: "/users?approval=pending"',
      'href: "/users?approval=rejected"',
    ]) {
      expect(page).toContain(href);
    }
  });

  it("removes the old dashboard sections and data sources", () => {
    for (const removed of [
      "DateRangeFilter",
      "OverviewChart",
      "Scheduled posts",
      "Published posts",
      "Failed posts",
      "Held posts",
      "Connected social accounts",
      "Suspended accounts",
      "Daily activity",
      "Recent activity",
      "Publishing snapshot",
      "Account health",
      "listActivity",
      "getAdminOverview",
    ]) {
      expect(page).not.toContain(removed);
    }
  });

  it("keeps the Super Admin guard and API error handling", () => {
    expect(page).toMatch(/requireAdminPage\(\)/);
    expect(route).toMatch(/await requireAdmin\(\)/);
    expect(route).toMatch(/apiErrorResponse\(error\)/);
  });
});
