import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyUserStatus,
  isActiveAccount,
  type UserStatusRow,
} from "@/lib/admin-user-status";
import {
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
      pending: 1,
      active: 0,
      inactive: 0,
    });
  });

  it("counts approved, unbanned users as active", () => {
    expect(
      summarizeUserStats([row({ approvalStatus: "approved" })]),
    ).toMatchObject({
      total: 1,
      pending: 0,
      active: 1,
      inactive: 0,
    });
  });

  it("counts rejected users as inactive", () => {
    expect(
      summarizeUserStats([row({ approvalStatus: "rejected" })]),
    ).toMatchObject({
      total: 1,
      pending: 0,
      active: 0,
      inactive: 1,
    });
  });

  it("counts banned users as inactive even when approval is approved or pending", () => {
    expect(
      summarizeUserStats([
        row({ approvalStatus: "approved", banned: true }),
        row({ approvalStatus: "pending", banned: true }),
      ]),
    ).toMatchObject({
      total: 2,
      pending: 0,
      active: 0,
      inactive: 2,
    });
  });

  it("counts soft-deleted users as inactive, including rejected users", () => {
    expect(
      summarizeUserStats([
        row({ approvalStatus: "rejected", deleted: true }),
        row({ approvalStatus: "approved", deleted: true }),
      ]),
    ).toMatchObject({
      total: 2,
      pending: 0,
      active: 0,
      inactive: 2,
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
      pending: 2,
      active: 3,
      inactive: 6,
    });
    expect(stats.pending + stats.active + stats.inactive).toBe(stats.total);
  });

  it("reflects status changes because each summary is derived from current rows", () => {
    const before = summarizeUserStats([row({ approvalStatus: "pending" })]);
    const after = summarizeUserStats([row({ approvalStatus: "approved" })]);

    expect(before).toMatchObject({ total: 1, pending: 1, active: 0 });
    expect(after).toMatchObject({ total: 1, pending: 0, active: 1 });
  });

  it("matches the requested counts after Super Admin rows are excluded", () => {
    // These are the rows PostgreSQL returns once `role <> 'admin'` is applied:
    // two approved normal users, one pending normal user, and one rejected,
    // soft-deleted normal user.
    const stats = summarizeUserStats([
      row({ approvalStatus: "approved" }),
      row({ approvalStatus: "approved" }),
      row({ approvalStatus: "pending" }),
      row({ approvalStatus: "rejected", deleted: true }),
    ]);

    expect(stats).toMatchObject({
      total: 4,
      pending: 1,
      active: 2,
      inactive: 1,
    });
  });
});

describe("user status classification", () => {
  const cases: [string, UserStatusRow, string][] = [
    [
      "a pending, active account",
      { approvalStatus: "pending", banned: false, deleted: false },
      "pending",
    ],
    [
      "an approved, active account",
      { approvalStatus: "approved", banned: false, deleted: false },
      "active",
    ],
    [
      "a rejected account",
      { approvalStatus: "rejected", banned: false, deleted: false },
      "inactive",
    ],
    [
      "a banned approved account",
      { approvalStatus: "approved", banned: true, deleted: false },
      "inactive",
    ],
    [
      "a banned pending account",
      { approvalStatus: "pending", banned: true, deleted: false },
      "inactive",
    ],
    [
      "a soft-deleted approved account",
      { approvalStatus: "approved", banned: false, deleted: true },
      "inactive",
    ],
    [
      "a rejected, soft-deleted account",
      { approvalStatus: "rejected", banned: false, deleted: true },
      "inactive",
    ],
    [
      "a soft-deleted pending account",
      { approvalStatus: "pending", banned: false, deleted: true },
      "inactive",
    ],
  ];

  it.each(cases)("classifies %s as %s", (_label, input, expected) => {
    expect(classifyUserStatus(input)).toBe(expected);
  });

  it("treats only unbanned, non-deleted accounts as active accounts", () => {
    expect(isActiveAccount({ banned: false, deleted: false })).toBe(true);
    expect(isActiveAccount({ banned: true, deleted: false })).toBe(false);
    expect(isActiveAccount({ banned: false, deleted: true })).toBe(false);
  });
});

describe("admin overview data source and UI", () => {
  const lib = readFile("src/lib/admin-overview.ts");
  const policy = readFile("src/lib/admin-overview-policy.ts");
  const statusPolicy = readFile("src/lib/admin-user-status.ts");
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

  it("uses one shared classifier instead of ad-hoc buckets", () => {
    expect(policy).toMatch(/classifyUserStatus/);
    expect(statusPolicy).toMatch(/export function classifyUserStatus/);
    expect(statusPolicy).toMatch(/row\.approvalStatus === "rejected"/);
    expect(statusPolicy).toMatch(/row\.approvalStatus === "pending"/);
    expect(statusPolicy).toMatch(/!row\.banned && !row\.deleted/);
  });

  it("shares the status rule with the Users directory", () => {
    expect(filtersLib).toMatch(/export function userStatusCondition/);
    expect(filtersLib).toMatch(/eq\(user\.approvalStatus, "pending"\)/);
    expect(filtersLib).toMatch(/eq\(user\.approvalStatus, "approved"\)/);
    expect(filtersLib).toMatch(/eq\(user\.approvalStatus, "rejected"\)/);
    expect(filtersLib).toMatch(/eq\(user\.banned, false\)/);
    expect(filtersLib).toMatch(/isNotNull\(user\.deletedAt\)/);
    expect(usersLib).toMatch(/userStatusCondition\(filters\.status\)/);
    expect(usersLib).toMatch(/getAdminUserStats\(\)/);
    expect(usersLib).toMatch(/total:\s*stats\.total/);
    expect(usersLib).toMatch(/pending:\s*stats\.pending/);
    expect(usersLib).toMatch(/active:\s*stats\.active/);
    expect(usersLib).toMatch(/inactive:\s*stats\.inactive/);
    expect(usersLib).not.toMatch(/groupBy\(user\.approvalStatus\)/);
  });

  it("shows only the four requested user statistics", () => {
    for (const label of [
      "Total Users",
      "Pending Users",
      "Active Users",
      "Inactive Users",
    ]) {
      expect(page).toContain(label);
    }

    expect(page).not.toContain("Approved Users");
    expect(page).not.toContain("Rejected Users");
    expect(page).not.toContain("Pending / On Hold");
    expect(page).not.toContain("On Hold");

    for (const href of [
      'href: "/users"',
      'href: "/users?status=pending"',
      'href: "/users?status=active"',
      'href: "/users?status=inactive"',
    ]) {
      expect(page).toContain(href);
    }
  });

  it("uses Active and Inactive labels in the directory and detail pages", () => {
    const table = readFile("src/app/(dashboard)/users/users-table.tsx");
    const detail = readFile("src/app/(dashboard)/users/[id]/page.tsx");
    const directoryFilters = readFile(
      "src/app/(dashboard)/users/users-filters.tsx",
    );

    expect(table).toContain("Active");
    expect(table).toContain("Inactive");
    expect(table).not.toContain(">Approved<");
    expect(table).not.toContain(">Rejected<");
    expect(detail).toContain("Inactive");
    expect(detail).not.toContain(">Rejected<");
    expect(directoryFilters).toContain('active: "Active"');
    expect(directoryFilters).toContain('inactive: "Inactive"');
    expect(directoryFilters).not.toContain('approved: "Approved"');
    expect(directoryFilters).not.toContain('rejected: "Rejected"');
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
