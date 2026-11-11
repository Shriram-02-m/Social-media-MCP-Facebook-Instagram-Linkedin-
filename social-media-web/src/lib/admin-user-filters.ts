import { and, eq, isNull, type SQL } from "drizzle-orm";

import type { ApprovalStatus } from "@/lib/admin-users-policy";
import { user } from "@/lib/db/schema";

/**
 * Database-side condition for an approval-filtered user list.
 *
 * Approval statistics only count active accounts, so the Users directory must
 * apply the same rule when an administrator clicks a dashboard card:
 * `approval_status = status AND banned = false AND deleted_at IS NULL`.
 *
 * The unfiltered "Total users" view intentionally does not use this helper; it
 * keeps showing every row, including suspended and soft-deleted accounts.
 */
export function activeApprovalCondition(status: ApprovalStatus): SQL {
  return and(
    eq(user.approvalStatus, status),
    eq(user.banned, false),
    isNull(user.deletedAt),
  )!;
}
