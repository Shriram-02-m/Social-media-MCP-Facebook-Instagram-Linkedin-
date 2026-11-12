import { and, asc, count, desc, eq, ilike, or } from "drizzle-orm";

import { logActivity } from "@/lib/activity";
import { getAdminUserStats } from "@/lib/admin-overview";
import {
  nonAdminCondition,
  userStatusCondition,
} from "@/lib/admin-user-filters";
import {
  classifyUserStatus,
  type UserStatus,
} from "@/lib/admin-user-status";
import { ApiError } from "@/lib/api";
import { db } from "@/lib/db";
import { isUniqueViolation } from "@/lib/db-errors";
import { account, session, user } from "@/lib/db/schema";
import {
  type ApprovalStatus,
  type UserFilters,
  type UserRole,
  type UserUpdate,
  validateUserUpdate,
} from "@/lib/admin-users-policy";

export interface AdminUserSummary {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  approvalStatus: ApprovalStatus;
  banned: boolean;
  createdAt: string;
  deletedAt: string | null;
}

export interface AdminUserDetail extends AdminUserSummary {
  emailVerified: boolean;
  image: string | null;
  banReason: string | null;
  banExpires: string | null;
  updatedAt: string;
  hasPassword: boolean;
  sessionCount: number;
}

export interface AdminUserCounts {
  total: number;
  pending: number;
  active: number;
  inactive: number;
}

export interface AdminUserList {
  users: AdminUserSummary[];
  counts: AdminUserCounts;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  approvalStatus: string;
  banned: boolean;
  createdAt: Date;
  updatedAt: Date;
  emailVerified: boolean;
  image: string | null;
  banReason: string | null;
  banExpires: Date | null;
  deletedAt: Date | null;
}

// Escape LIKE metacharacters so a search for "100%" is a literal search.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function asRole(value: string): UserRole {
  return value === "admin" ? "admin" : "user";
}

function asApprovalStatus(value: string): ApprovalStatus {
  if (value === "approved" || value === "rejected") return value;
  return "pending";
}

function toSummary(row: UserRow): AdminUserSummary {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: asRole(row.role),
    status: classifyUserStatus({
      approvalStatus: row.approvalStatus,
      banned: row.banned,
      deleted: row.deletedAt !== null,
    }),
    approvalStatus: asApprovalStatus(row.approvalStatus),
    banned: row.banned,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

export async function listUsers(filters: UserFilters): Promise<AdminUserList> {
  const conditions = [];
  if (filters.query) {
    const pattern = `%${escapeLike(filters.query)}%`;
    conditions.push(or(ilike(user.name, pattern), ilike(user.email, pattern))!);
  }
  if (filters.status !== "all") {
    conditions.push(userStatusCondition(filters.status));
  }
  if (filters.role !== "all") {
    conditions.push(eq(user.role, filters.role));
  } else {
    // The default directory and the dashboard card links are normal-user
    // views, so they must exclude the Super Admin just like the statistics.
    // Selecting the "Super Admin" role filter still lists that account.
    conditions.push(nonAdminCondition());
  }

  const rows = (await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      approvalStatus: user.approvalStatus,
      banned: user.banned,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      emailVerified: user.emailVerified,
      image: user.image,
      banReason: user.banReason,
      banExpires: user.banExpires,
      deletedAt: user.deletedAt,
    })
    .from(user)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(user.createdAt), asc(user.email))) as UserRow[];

  // Reuse the dashboard aggregate so the cards and the directory can never
  // disagree: total counts every non-admin row, while pending/active/inactive
  // use the same classification rules as the status filters. Both queries stay
  // in PostgreSQL.
  const stats = await getAdminUserStats();

  const counts: AdminUserCounts = {
    total: stats.total,
    pending: stats.pending,
    active: stats.active,
    inactive: stats.inactive,
  };

  return { users: rows.map(toSummary), counts };
}

export async function getUserDetail(id: string): Promise<AdminUserDetail | null> {
  const [row] = (await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      approvalStatus: user.approvalStatus,
      banned: user.banned,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      emailVerified: user.emailVerified,
      image: user.image,
      banReason: user.banReason,
      banExpires: user.banExpires,
      deletedAt: user.deletedAt,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1)) as UserRow[];

  if (!row) return null;

  const [credential] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, id), eq(account.providerId, "credential")))
    .limit(1);

  const [sessionCount] = await db
    .select({ total: count() })
    .from(session)
    .where(eq(session.userId, id));

  return {
    ...toSummary(row),
    emailVerified: row.emailVerified,
    image: row.image,
    banReason: row.banReason,
    banExpires: row.banExpires ? row.banExpires.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    hasPassword: Boolean(credential),
    sessionCount: Number(sessionCount?.total ?? 0),
  };
}

export async function updateUser(
  actorId: string,
  targetId: string,
  update: UserUpdate,
): Promise<AdminUserSummary> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = (await tx
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          approvalStatus: user.approvalStatus,
          banned: user.banned,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          emailVerified: user.emailVerified,
          image: user.image,
          banReason: user.banReason,
          banExpires: user.banExpires,
          deletedAt: user.deletedAt,
        })
        .from(user)
        .where(eq(user.id, targetId))
        .limit(1)) as UserRow[];

      if (!row) throw new ApiError("User not found.", 404);

      const adminRows = await tx
        .select({ id: user.id })
        .from(user)
        .where(eq(user.role, "admin"));

      const violation = validateUserUpdate({
        actorId,
        target: row,
        update,
        adminCount: adminRows.length,
      });
      if (violation) throw new ApiError(violation.message, violation.status);

      const patch: Partial<typeof user.$inferInsert> = { updatedAt: new Date() };
      if (update.role) patch.role = update.role;
      if (update.approvalStatus) patch.approvalStatus = update.approvalStatus;

      await tx.update(user).set(patch).where(eq(user.id, targetId));

      await logActivity(
        {
          actorUserId: actorId,
          targetUserId: targetId,
          action: update.role
            ? "user_role_changed"
            : update.approvalStatus === "approved"
              ? "user_approved"
              : "user_rejected",
          resourceType: "user",
          resourceId: targetId,
          metadata: {
            previousRole: row.role,
            role: update.role ?? row.role,
            previousApprovalStatus: row.approvalStatus,
            approvalStatus: update.approvalStatus ?? row.approvalStatus,
          },
        },
        tx,
      );

      return toSummary({
        ...row,
        role: update.role ?? row.role,
        approvalStatus: update.approvalStatus ?? row.approvalStatus,
        updatedAt: new Date(),
      });
    });
  } catch (error) {
    // Defense in depth: the partial unique index on role='admin' can still fire
    // under a concurrent request even though this transaction checked first.
    if (isUniqueViolation(error)) {
      throw new ApiError(
        "A Super Admin already exists. The application supports exactly one admin account.",
        409,
      );
    }
    throw error;
  }
}
