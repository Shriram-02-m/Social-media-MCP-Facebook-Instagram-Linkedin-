// Pure user-facing status policy shared by the dashboard statistics, the Users
// directory filters, and the UI badges. Kept free of database imports so the
// classification rules can be unit-tested without a connection.

/**
 * The three statuses shown to the Super Admin.
 *
 * Internally the database still stores `approval_status` (`pending`,
 * `approved`, `rejected`), `banned`, and `deleted_at`. Those are implementation
 * details; the console presents one unambiguous status per account:
 *
 * - `pending`  – waiting for an administrator decision.
 * - `active`   – approved and not suspended or soft-deleted.
 * - `inactive` – rejected, suspended, or soft-deleted.
 *
 * A pending account that is suspended or soft-deleted is `inactive`, not
 * `pending`: lifecycle flags take precedence so every account lands in exactly
 * one bucket and nothing is double-counted.
 */
export const USER_STATUSES = ["pending", "active", "inactive"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserStatusRow {
  approvalStatus: string;
  banned: boolean;
  deleted: boolean;
}

/** True when the account is not suspended and not soft-deleted. */
export function isActiveAccount(row: Pick<UserStatusRow, "banned" | "deleted">): boolean {
  return !row.banned && !row.deleted;
}

/**
 * Map an internal user row to the single status shown in the console.
 *
 * Precedence is deliberate: rejected, suspended, and deleted accounts are all
 * `inactive` even when their `approval_status` is `pending` or `approved`.
 */
export function classifyUserStatus(row: UserStatusRow): UserStatus {
  if (!isActiveAccount(row) || row.approvalStatus === "rejected") {
    return "inactive";
  }
  if (row.approvalStatus === "pending") {
    return "pending";
  }
  return "active";
}
