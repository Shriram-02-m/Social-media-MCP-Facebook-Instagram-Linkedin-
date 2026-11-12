import { and, eq, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";

import type { UserStatus } from "@/lib/admin-user-status";
import { user } from "@/lib/db/schema";

/**
 * Database-side condition that excludes Super Admin accounts.
 *
 * `role` is the authoritative marker for the Super Admin (`role = 'admin'`),
 * matching the admin plugin's `adminRoles` configuration. This deliberately
 * uses the role column rather than a user id, email, or name, and leaves every
 * other role untouched. It is shared by the dashboard aggregates and the
 * default Users directory so the cards and the list apply the same rule.
 */
export function nonAdminCondition(): SQL {
  return ne(user.role, "admin");
}

/**
 * Database-side condition for one console-facing user status.
 *
 * Mirrors `classifyUserStatus` exactly, so a status-filtered directory list
 * contains the same accounts that the matching dashboard card counts:
 *
 * - `pending`  → approval pending AND not banned AND not deleted
 * - `active`   → approval approved AND not banned AND not deleted
 * - `inactive` → rejected OR banned OR soft-deleted
 *
 * The conditions are mutually exclusive and cover every row, so the three
 * buckets partition the user table without double counting.
 */
export function userStatusCondition(status: UserStatus): SQL {
  switch (status) {
    case "pending":
      return and(
        eq(user.approvalStatus, "pending"),
        eq(user.banned, false),
        isNull(user.deletedAt),
      )!;
    case "active":
      return and(
        eq(user.approvalStatus, "approved"),
        eq(user.banned, false),
        isNull(user.deletedAt),
      )!;
    case "inactive":
      return or(
        eq(user.approvalStatus, "rejected"),
        eq(user.banned, true),
        isNotNull(user.deletedAt),
      )!;
  }
}
