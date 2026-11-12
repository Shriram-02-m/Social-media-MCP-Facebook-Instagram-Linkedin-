// Pure Super Admin overview statistics policy. Kept free of database imports so
// the counting rules can be unit-tested without a connection, matching the
// existing `admin-users-policy.ts` / `admin-policy.ts` pattern.

import { classifyUserStatus } from "@/lib/admin-user-status";

/**
 * User statistics shown on the Admin Overview.
 *
 * `approval_status` is the registration lifecycle: every signup starts as
 * `pending`, and the administrator moves the account to `approved` or
 * `rejected`. Suspension (`banned`) and soft deletion (`deleted_at`) are
 * separate lifecycle flags, not approval states. `classifyUserStatus` collapses
 * all of that into the three console-facing buckets so an account is counted
 * exactly once.
 */
export interface AdminUserStats {
  total: number;
  pending: number;
  active: number;
  inactive: number;
}

export interface UserStatsRow {
  approvalStatus: string;
  banned: boolean;
  deleted: boolean;
  total: number;
}

/**
 * Pure aggregation over grouped user rows.
 *
 * Every row contributes to `total` and to exactly one of `pending`, `active`,
 * or `inactive`. The classification rule is shared with the Users directory
 * filters through `classifyUserStatus` / `userStatusCondition`, so the cards and
 * the filtered lists can never disagree.
 */
export function summarizeUserStats(rows: UserStatsRow[]): AdminUserStats {
  const summary: AdminUserStats = {
    total: 0,
    pending: 0,
    active: 0,
    inactive: 0,
  };

  for (const row of rows) {
    summary.total += row.total;
    summary[classifyUserStatus(row)] += row.total;
  }

  return summary;
}
