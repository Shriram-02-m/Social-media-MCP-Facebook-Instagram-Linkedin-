import type { AdminPlatform, SocialAccountStatus } from "@/lib/admin-policy";

export interface AdminSocialConnectionRow {
  userId: string;
  userName: string;
  userEmail: string;
  userStatus: "pending" | "approved" | "rejected" | "suspended" | "deleted";
  platform: AdminPlatform;
  status: SocialAccountStatus;
  accountName: string | null;
  accountId: string | null;
  expiresAt: string | null;
  expired: boolean;
  scopes: string[];
  pageCount: number;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
}

/**
 * One owner with every matching platform connection attached. Grouping is
 * keyed on the immutable user id so two people with the same display name or
 * email are never merged.
 */
export interface AdminSocialOwnerRow {
  userId: string;
  userName: string;
  userEmail: string;
  userStatus: AdminSocialConnectionRow["userStatus"];
  /** Connections for this owner, ordered Facebook → Instagram → LinkedIn. */
  connections: AdminSocialConnectionRow[];
}

const PLATFORM_ORDER: Record<AdminPlatform, number> = {
  facebook: 0,
  instagram: 1,
  linkedin: 2,
};

/**
 * Groups flat connection rows by owner id without dropping or merging any
 * connection. Pure so the grouping behaviour can be tested without a database
 * connection; owner order follows the first appearance of each user id.
 */
export function groupConnectionsByOwner(
  rows: AdminSocialConnectionRow[],
): AdminSocialOwnerRow[] {
  const owners = new Map<string, AdminSocialOwnerRow>();

  for (const connection of rows) {
    const existing = owners.get(connection.userId);
    if (existing) {
      existing.connections.push(connection);
      continue;
    }
    owners.set(connection.userId, {
      userId: connection.userId,
      userName: connection.userName,
      userEmail: connection.userEmail,
      userStatus: connection.userStatus,
      connections: [connection],
    });
  }

  for (const owner of owners.values()) {
    owner.connections.sort(
      (left, right) =>
        PLATFORM_ORDER[left.platform] - PLATFORM_ORDER[right.platform],
    );
  }

  return [...owners.values()];
}
