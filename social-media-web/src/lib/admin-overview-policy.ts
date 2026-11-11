// Pure Super Admin overview statistics policy. Kept free of database imports so
// the counting rules can be unit-tested without a connection, matching the
// existing `admin-users-policy.ts` / `admin-policy.ts` pattern.

/**
 * User statistics shown on the Admin Overview.
 *
 * `approval_status` is the registration lifecycle: every signup starts as
 * `pending`, and the administrator moves the account to `approved` or
 * `rejected`. Suspension (`banned`) and soft deletion (`deleted_at`) are
 * separate lifecycle flags, not approval states.
 */
export interface AdminUserStats {
  total: number;
  approved: number;
  pending: number;
  rejected: number;
}

export interface AdminUserStatsBreakdown extends AdminUserStats {
  suspended: number;
  deleted: number;
}

export interface UserStatsRow {
  approvalStatus: string;
  banned: boolean;
  deleted: boolean;
  total: number;
}

export interface ApprovalStateRow {
  banned: boolean;
  deleted: boolean;
}

/**
 * Approval statistics count only active accounts. Suspension (`banned`) and
 * soft deletion (`deleted_at`) are separate lifecycle flags, so they must never
 * inflate the approved/pending/rejected buckets.
 *
 * This is the single pure rule shared by the dashboard aggregation and the
 * Users directory summary; the database condition in `admin-user-filters.ts`
 * mirrors it for approval-filtered lists.
 */
export function isActiveApprovalRow(row: ApprovalStateRow): boolean {
  return !row.banned && !row.deleted;
}

/**
 * Pure aggregation over grouped user rows.
 *
 * Precedence is deliberate and matches the account lifecycle: a soft-deleted
 * row is counted only as deleted, a suspended row only as suspended, and only
 * active rows are classified by approval status. This prevents a suspended or
 * deleted account from inflating the approved/pending/rejected counts. The
 * database CHECK constraint guarantees `approval_status` is one of `pending`,
 * `approved`, or `rejected`.
 */
export function summarizeUserStats(rows: UserStatsRow[]): AdminUserStatsBreakdown {
  const summary: AdminUserStatsBreakdown = {
    total: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    suspended: 0,
    deleted: 0,
  };

  for (const row of rows) {
    const total = row.total;
    summary.total += total;

    if (!isActiveApprovalRow(row)) {
      if (row.deleted) summary.deleted += total;
      else summary.suspended += total;
      continue;
    }
    if (row.approvalStatus === "approved") summary.approved += total;
    else if (row.approvalStatus === "pending") summary.pending += total;
    else if (row.approvalStatus === "rejected") summary.rejected += total;
  }

  return summary;
}
