import { and, count, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";

import type { ActivityFilters } from "@/lib/admin-policy";
import { db } from "@/lib/db";
import { activityLog, user } from "@/lib/db/schema";

export interface AdminActivityEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  targetUserId: string | null;
  targetName: string | null;
  targetEmail: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface AdminActivityResult {
  entries: AdminActivityEntry[];
  total: number;
  page: number;
  pageSize: number;
  actions: string[];
  range: { fromIso: string; toIso: string; days: number };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function parseMetadata(value: unknown): unknown {
  // The pg driver already parses jsonb into an object. Tolerate string values
  // too (for example if the column is ever text) and never let malformed
  // legacy text take down the whole page.
  if (value === null || value === undefined) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export async function listActivity(
  filters: ActivityFilters,
): Promise<AdminActivityResult> {
  const conditions = [
    gte(activityLog.createdAt, filters.range.from),
    lte(activityLog.createdAt, filters.range.to),
  ];

  if (filters.action) conditions.push(eq(activityLog.action, filters.action));
  if (filters.userId) {
    conditions.push(or(
      eq(activityLog.actorUserId, filters.userId),
      eq(activityLog.targetUserId, filters.userId),
    )!);
  }
  if (filters.query) {
    const pattern = `%${escapeLike(filters.query)}%`;
    conditions.push(or(
      ilike(activityLog.action, pattern),
      ilike(activityLog.resourceType, pattern),
      ilike(activityLog.resourceId, pattern),
      ilike(activityLog.actorUserId, pattern),
      ilike(activityLog.targetUserId, pattern),
      // metadata is jsonb, which has no ILIKE operator. Cast explicitly so the
      // search works against the canonical JSON text instead of throwing
      // `operator does not exist: jsonb ~~* unknown` and failing the page.
      ilike(sql`${activityLog.metadata}::text`, pattern),
    )!);
  }

  const where = and(...conditions);

  const [rows, [totalRow], actionRows] = await Promise.all([
    db
      .select()
      .from(activityLog)
      .where(where)
      .orderBy(desc(activityLog.createdAt))
      .limit(filters.pageSize)
      .offset(filters.offset),
    db.select({ total: count() }).from(activityLog).where(where),
    db
      .select({ action: activityLog.action })
      .from(activityLog)
      .groupBy(activityLog.action)
      .orderBy(desc(count())),
  ]);

  const userIds = [...new Set(rows.flatMap((row) => [row.actorUserId, row.targetUserId]))]
    .filter((id): id is string => Boolean(id));
  const users = userIds.length
    ? await db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(inArray(user.id, userIds))
    : [];
  const usersById = new Map(users.map((row) => [row.id, row]));

  return {
    entries: rows.map((row) => {
      const actor = row.actorUserId ? usersById.get(row.actorUserId) : undefined;
      const target = row.targetUserId ? usersById.get(row.targetUserId) : undefined;
      return {
        id: row.id,
        action: row.action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        actorUserId: row.actorUserId,
        actorName: actor?.name ?? null,
        actorEmail: actor?.email ?? null,
        targetUserId: row.targetUserId,
        targetName: target?.name ?? null,
        targetEmail: target?.email ?? null,
        metadata: parseMetadata(row.metadata),
        createdAt:
          row.createdAt instanceof Date && !Number.isNaN(row.createdAt.getTime())
            ? row.createdAt.toISOString()
            : "",
      };
    }),
    total: Number(totalRow?.total ?? 0),
    page: filters.page,
    pageSize: filters.pageSize,
    actions: actionRows.map((row) => row.action).filter(Boolean),
    range: {
      fromIso: filters.range.fromIso,
      toIso: filters.range.toIso,
      days: filters.range.days,
    },
  };
}
