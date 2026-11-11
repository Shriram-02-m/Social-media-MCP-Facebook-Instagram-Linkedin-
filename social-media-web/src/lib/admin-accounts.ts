import { eq } from "drizzle-orm";

import { logActivity } from "@/lib/activity";
import {
  ACCOUNT_ACTIONS,
  type AccountAction,
  validateAccountAction,
} from "@/lib/admin-policy";
import {
  getUserDetail as getAdminUserDetail,
  type AdminUserDetail,
} from "@/lib/admin-users";
import {
  listUserScheduledPosts,
  type AdminUserPost,
} from "@/lib/admin-scheduler";
import {
  listUserSocialAccounts,
  type AdminSocialConnectionRow,
} from "@/lib/admin-social-accounts";
import { ApiError } from "@/lib/api";
import {
  holdScheduledPostsForUser,
  resumeScheduledPostsForUser,
} from "@/lib/backend";
import { db } from "@/lib/db";
import { session, user } from "@/lib/db/schema";

export interface AccountActionResult {
  id: string;
  action: AccountAction;
  banned: boolean;
  deletedAt: string | null;
  sessionsRevoked: number;
  postsHeld: number;
  postsResumed: number;
  postsStillHeld: number;
}

const ACTION_LABELS: Record<AccountAction, string> = {
  suspend: "user_suspended",
  reactivate: "user_reactivated",
  soft_delete: "user_soft_deleted",
  restore: "user_restored",
  revoke_sessions: "user_sessions_revoked",
};

function cleanReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, 300) : undefined;
}

/**
 * Account lifecycle change for the Super Admin.
 *
 * The user row update, session revocation, and audit entry commit in one
 * database transaction. Post hold/resume runs immediately afterwards through
 * the scheduler module; if it fails, logging only reports the partial state and
 * the database-level `social_media_account_is_active` guard still prevents any
 * suspended/deleted account from being claimed by the worker.
 */
export async function performAccountAction(
  actorId: string,
  targetId: string,
  action: AccountAction,
  reason?: string,
): Promise<AccountActionResult> {
  if (!(ACCOUNT_ACTIONS as readonly string[]).includes(action)) {
    throw new ApiError("Unknown account action.", 400);
  }

  const cleanedReason = cleanReason(reason);
  let sessionsRevoked = 0;
  let previous: { banned: boolean; deletedAt: Date | null; approvalStatus: string } | undefined;

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: user.id,
        role: user.role,
        approvalStatus: user.approvalStatus,
        banned: user.banned,
        deletedAt: user.deletedAt,
      })
      .from(user)
      .where(eq(user.id, targetId))
      .limit(1);

    if (!row) throw new ApiError("User not found.", 404);
    const violation = validateAccountAction({ action, actorId, target: row });
    if (violation) throw new ApiError(violation.message, violation.status);
    previous = {
      banned: row.banned,
      deletedAt: row.deletedAt,
      approvalStatus: row.approvalStatus,
    };

    const patch: Partial<typeof user.$inferInsert> = { updatedAt: new Date() };
    if (action === "suspend") {
      patch.banned = true;
      patch.banReason = cleanedReason ?? "Suspended by the administrator.";
      patch.banExpires = null;
    } else if (action === "reactivate") {
      patch.banned = false;
      patch.banReason = null;
      patch.banExpires = null;
    } else if (action === "soft_delete") {
      patch.deletedAt = new Date();
    } else if (action === "restore") {
      patch.deletedAt = null;
    }

    if (action !== "revoke_sessions") {
      await tx.update(user).set(patch).where(eq(user.id, targetId));
    }

    if (action === "suspend" || action === "soft_delete" || action === "revoke_sessions") {
      const revoked = await tx
        .delete(session)
        .where(eq(session.userId, targetId))
        .returning({ id: session.id });
      sessionsRevoked = revoked.length;
    }

    await logActivity(
      {
        actorUserId: actorId,
        targetUserId: targetId,
        action: ACTION_LABELS[action],
        resourceType: "user",
        resourceId: targetId,
        metadata: {
          reason: cleanedReason,
          previousBanned: row.banned,
          previousDeletedAt: row.deletedAt?.toISOString() ?? null,
          previousApprovalStatus: row.approvalStatus,
          sessionsRevoked,
        },
      },
      tx,
    );
  });

  let postsHeld = 0;
  let postsResumed = 0;
  let postsStillHeld = 0;
  try {
    if (action === "suspend" || action === "soft_delete") {
      const held = await holdScheduledPostsForUser(targetId, {
        actorUserId: actorId,
        reason: cleanedReason
          ?? (action === "suspend"
            ? "Held: the account was suspended by the administrator."
            : "Held: the account was deleted by the administrator."),
      });
      postsHeld = held.length;
    } else if (action === "reactivate" || action === "restore") {
      const canPublish = previous?.approvalStatus === "approved" && !previous.banned;
      if (canPublish) {
        const resumed = await resumeScheduledPostsForUser(targetId, undefined, {
          actorUserId: actorId,
        });
        postsResumed = resumed.resumed.length;
        postsStillHeld = resumed.stillHeld.length;
      }
    }
  } catch (error) {
    console.error(
      "[admin] account action succeeded but post hold/resume failed:",
      error instanceof Error ? error.message : error,
    );
  }

  return {
    id: targetId,
    action,
    banned: action === "suspend"
      ? true
      : action === "reactivate"
        ? false
        : previous?.banned ?? false,
    deletedAt: action === "soft_delete"
      ? new Date().toISOString()
      : action === "restore"
        ? null
        : previous?.deletedAt?.toISOString() ?? null,
    sessionsRevoked,
    postsHeld,
    postsResumed,
    postsStillHeld,
  };
}

export interface AdminUserContext {
  detail: AdminUserDetail;
  connections: AdminSocialConnectionRow[];
  posts: AdminUserPost[];
}

export async function getAdminUserContext(
  id: string,
): Promise<AdminUserContext | null> {
  const detail = await getAdminUserDetail(id);
  if (!detail) return null;
  const [connections, posts] = await Promise.all([
    listUserSocialAccounts(id),
    listUserScheduledPosts(id),
  ]);
  return { detail, connections, posts };
}
