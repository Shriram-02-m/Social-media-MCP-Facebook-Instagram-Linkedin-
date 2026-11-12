import { and, asc, ilike, or } from "drizzle-orm";

import type {
  AdminPlatform,
  SocialAccountFilters,
  SocialAccountStatus,
} from "@/lib/admin-policy";
import {
  groupConnectionsByOwner,
  type AdminSocialConnectionRow,
  type AdminSocialOwnerRow,
} from "@/lib/admin-social-grouping";
import { loadTokenMetadata } from "@/lib/backend";
import { db, pool } from "@/lib/db";
import { user } from "@/lib/db/schema";

export { groupConnectionsByOwner };
export type { AdminSocialConnectionRow, AdminSocialOwnerRow };

export interface AdminSocialAccountsResult {
  /** One entry per unique owner for the current page. */
  rows: AdminSocialOwnerRow[];
  totalConnections: number;
  filteredConnections: number;
  totalUsers: number;
  /** Unique owners remaining after platform/status filters; drives pagination. */
  filteredUsers: number;
  counts: Record<SocialAccountStatus, number>;
  page: number;
  pageSize: number;
}

interface AuthSessionRow {
  user_id: string;
  platform: AdminPlatform;
  status: string;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function userStatus(row: {
  approvalStatus: string;
  banned: boolean;
  deletedAt: Date | null;
}): AdminSocialConnectionRow["userStatus"] {
  if (row.deletedAt) return "deleted";
  if (row.banned) return "suspended";
  if (row.approvalStatus === "approved" || row.approvalStatus === "rejected") {
    return row.approvalStatus;
  }
  return "pending";
}

async function latestAuthorizationSessions(
  userIds: string[],
): Promise<Map<string, AuthSessionRow>> {
  const sessions = new Map<string, AuthSessionRow>();
  if (!userIds.length) return sessions;
  try {
    const { rows } = await pool.query<AuthSessionRow>(
      `SELECT DISTINCT ON (user_id, platform)
              user_id, platform, status, error, created_at, completed_at
         FROM public.oauth_authorization_sessions
        WHERE user_id = ANY($1::text[])
        ORDER BY user_id, platform, created_at DESC`,
      [userIds],
    );
    for (const row of rows) sessions.set(`${row.user_id}:${row.platform}`, row);
  } catch {
    // The OAuth session table is optional (legacy local deployments).
  }
  return sessions;
}

/** Cross-account connection monitoring. Never returns or logs token material. */
export async function listSocialAccounts(
  filters: SocialAccountFilters,
): Promise<AdminSocialAccountsResult> {
  const conditions = [];
  if (filters.query) {
    const pattern = `%${escapeLike(filters.query)}%`;
    conditions.push(or(ilike(user.name, pattern), ilike(user.email, pattern))!);
  }

  const users = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      approvalStatus: user.approvalStatus,
      banned: user.banned,
      deletedAt: user.deletedAt,
    })
    .from(user)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(user.email), asc(user.name));

  const sessions = await latestAuthorizationSessions(users.map((row) => row.id));

  const allRows: AdminSocialConnectionRow[] = [];
  const settled = await Promise.allSettled(
    users.map(async (row) => ({
      user: row,
      tokens: await loadTokenMetadata(row.id),
    })),
  );

  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    const { user: owner, tokens } = item.value;
    const ownerStatus = userStatus(owner);
    for (const token of tokens) {
      const session = sessions.get(`${owner.id}:${token.platform}`);
      const sessionError = session && session.status !== "connected" ? session.error : null;
      const status: SocialAccountStatus = token.expired ? "expired" : "connected";
      allRows.push({
        userId: owner.id,
        userName: owner.name,
        userEmail: owner.email,
        userStatus: ownerStatus,
        platform: token.platform as AdminPlatform,
        status,
        accountName: token.accountName,
        accountId: token.accountId,
        expiresAt: token.expiresAt === null ? null : new Date(token.expiresAt).toISOString(),
        expired: token.expired,
        scopes: token.scopes,
        pageCount: token.pageCount,
        connectedAt: token.connectedAt,
        lastSyncAt: token.updatedAt,
        lastError: sessionError,
        lastErrorAt: sessionError && session ? session.created_at.toISOString() : null,
      });
    }

    // Surface a failed authorization attempt even when no token was stored.
    for (const platform of ["facebook", "instagram", "linkedin"] as const) {
      const hasToken = tokens.some((token) => token.platform === platform);
      if (hasToken) continue;
      const session = sessions.get(`${owner.id}:${platform}`);
      if (!session || session.status === "connected" || session.status === "pending") continue;
      allRows.push({
        userId: owner.id,
        userName: owner.name,
        userEmail: owner.email,
        userStatus: ownerStatus,
        platform,
        status: "error",
        accountName: null,
        accountId: null,
        expiresAt: null,
        expired: false,
        scopes: [],
        pageCount: 0,
        connectedAt: null,
        lastSyncAt: session.completed_at?.toISOString() ?? session.created_at.toISOString(),
        lastError: session.error ?? `Authorization ${session.status}.`,
        lastErrorAt: (session.completed_at ?? session.created_at).toISOString(),
      });
    }
  }

  allRows.sort((left, right) => {
    const byEmail = left.userEmail.localeCompare(right.userEmail);
    if (byEmail !== 0) return byEmail;
    return left.platform.localeCompare(right.platform);
  });

  const counts: Record<SocialAccountStatus, number> = {
    connected: 0,
    expired: 0,
    error: 0,
    disconnected: 0,
  };
  for (const row of allRows) counts[row.status] += 1;

  const filtered = allRows.filter((row) => {
    if (filters.platform !== "all" && row.platform !== filters.platform) return false;
    if (filters.status !== "all" && row.status !== filters.status) return false;
    return true;
  });

  // Filtering happens per connection, then the surviving connections are
  // grouped by owner. Pagination is applied to owners so a user's platforms
  // are never split across pages.
  const ownerRows = groupConnectionsByOwner(filtered);

  return {
    rows: ownerRows.slice(filters.offset, filters.offset + filters.pageSize),
    totalConnections: allRows.length,
    filteredConnections: filtered.length,
    totalUsers: users.length,
    filteredUsers: ownerRows.length,
    counts,
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/**
 * Connection summary for a single user detail page. Reuses the same safe
 * metadata helper but avoids the global pagination query.
 */
export async function listUserSocialAccounts(userId: string): Promise<AdminSocialConnectionRow[]> {
  const tokens = await loadTokenMetadata(userId);
  return tokens.map((token) => ({
    userId,
    userName: "",
    userEmail: "",
    userStatus: "approved",
    platform: token.platform as AdminPlatform,
    status: token.expired ? "expired" : "connected",
    accountName: token.accountName,
    accountId: token.accountId,
    expiresAt: token.expiresAt === null ? null : new Date(token.expiresAt).toISOString(),
    expired: token.expired,
    scopes: token.scopes,
    pageCount: token.pageCount,
    connectedAt: token.connectedAt,
    lastSyncAt: token.updatedAt,
    lastError: null,
    lastErrorAt: null,
  }));
}
