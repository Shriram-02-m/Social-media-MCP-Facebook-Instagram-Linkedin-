import { count, sql } from "drizzle-orm";

import {
  summarizeUserStats,
  type AdminUserStats,
} from "@/lib/admin-overview-policy";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";

export type { AdminUserStats } from "@/lib/admin-overview-policy";

/**
 * Count users with one grouped aggregate query. Grouping by approval status,
 * the banned flag, and the deleted-at boolean yields at most twelve rows
 * regardless of the user-table size; no user records are loaded into
 * application memory.
 */
export async function getAdminUserStats(): Promise<AdminUserStats> {
  const deleted = sql<boolean>`${user.deletedAt} is not null`;

  const rows = await db
    .select({
      approvalStatus: user.approvalStatus,
      banned: user.banned,
      deleted,
      total: count(),
    })
    .from(user)
    .groupBy(user.approvalStatus, user.banned, deleted);

  const breakdown = summarizeUserStats(
    rows.map((row) => ({
      approvalStatus: row.approvalStatus,
      banned: row.banned,
      deleted: row.deleted,
      total: Number(row.total),
    })),
  );

  return {
    total: breakdown.total,
    approved: breakdown.approved,
    pending: breakdown.pending,
    rejected: breakdown.rejected,
  };
}
