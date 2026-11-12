// Pure user-management policy: constants, filter parsing, and the update
// guard. Kept free of database imports so it can be unit-tested without a
// connection and reused by both the API routes and server pages.

import {
  USER_STATUSES,
  type UserStatus,
} from "@/lib/admin-user-status";

export const USER_ROLES = ["admin", "user"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

// Only these two targets can be set through the management API. "pending" is
// the signup default and is never an admin-selectable action.
export const MANAGEABLE_APPROVAL_STATUSES = ["approved", "rejected"] as const;
export type ManageableApprovalStatus = (typeof MANAGEABLE_APPROVAL_STATUSES)[number];

export type FilterValue<T extends string> = T | "all";

export interface UserFilters {
  query: string;
  status: FilterValue<UserStatus>;
  role: FilterValue<UserRole>;
}

export interface UserUpdate {
  role?: UserRole;
  approvalStatus?: ManageableApprovalStatus;
}

export interface GuardTarget {
  id: string;
  role: string;
  approvalStatus: string;
  deletedAt: Date | null;
}

export interface UserUpdateViolation {
  message: string;
  status: number;
}

const MAX_QUERY_LENGTH = 100;

function readParam(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
  key: string,
): string {
  if (!input) return "";
  if (typeof (input as URLSearchParams).get === "function") {
    return (input as URLSearchParams).get(key) ?? "";
  }
  const value = (input as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// Older dashboard links used `approval=approved|rejected`. Keep accepting
// them (mapped to the new console-facing terms) so bookmarks and any external
// links keep working.
const LEGACY_STATUS_PARAMS: Record<string, UserStatus> = {
  approved: "active",
  rejected: "inactive",
};

/** Normalise and whitelist the list filters coming from a URL. */
export function parseUserFilters(
  input: URLSearchParams | Record<string, string | string[] | undefined> | null | undefined,
): UserFilters {
  const query = readParam(input, "q").trim().slice(0, MAX_QUERY_LENGTH);
  const statusRaw = readParam(input, "status").trim().toLowerCase();
  const legacyStatusRaw = readParam(input, "approval").trim().toLowerCase();
  const statusCandidate = LEGACY_STATUS_PARAMS[statusRaw || legacyStatusRaw]
    ?? (statusRaw || legacyStatusRaw);
  const roleRaw = readParam(input, "role").trim().toLowerCase();

  return {
    query,
    status: (USER_STATUSES as readonly string[]).includes(statusCandidate)
      ? (statusCandidate as UserStatus)
      : "all",
    role: (USER_ROLES as readonly string[]).includes(roleRaw)
      ? (roleRaw as UserRole)
      : "all",
  };
}

/**
 * Server-side invariant check for every user update. Returns a safe,
 * user-facing violation, or null when the update is allowed.
 *
 * `adminCount` is the number of rows with role='admin' including the target.
 * The database also enforces "at most one admin" with a partial unique index;
 * this guard exists so the API returns a clear message and so the actor can
 * never lock themself out.
 */
export function validateUserUpdate(params: {
  actorId: string;
  target: GuardTarget;
  update: UserUpdate;
  adminCount: number;
}): UserUpdateViolation | null {
  const { actorId, target, update, adminCount } = params;

  if (!update.role && !update.approvalStatus) {
    return { message: "No changes were provided.", status: 400 };
  }

  if (target.deletedAt) {
    return {
      message: "This account has been deleted and can no longer be managed.",
      status: 409,
    };
  }

  if (update.approvalStatus) {
    if (target.id === actorId) {
      return { message: "You cannot change your own approval status.", status: 409 };
    }
    if (update.approvalStatus === target.approvalStatus) {
      return {
        message: `This account is already ${target.approvalStatus}.`,
        status: 409,
      };
    }
  }

  if (update.role) {
    if (target.id === actorId) {
      // Covers both demotion and promotion of the acting Super Admin.
      return { message: "You cannot change your own role.", status: 409 };
    }
    if (update.role === target.role) {
      return {
        message: `This account already has the ${target.role} role.`,
        status: 409,
      };
    }
    if (update.role === "admin" && target.role !== "admin" && adminCount > 0) {
      return {
        message:
          "A Super Admin already exists. The application supports exactly one admin account.",
        status: 409,
      };
    }
    if (update.role === "user" && target.role === "admin" && adminCount <= 1) {
      return {
        message: "You cannot remove the only Super Admin.",
        status: 409,
      };
    }
  }

  return null;
}
