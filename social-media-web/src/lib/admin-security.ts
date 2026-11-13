import { and, eq, gt } from "drizzle-orm";

import { logActivity } from "@/lib/activity";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { session, user } from "@/lib/db/schema";
import { validateDisplayName } from "@/lib/security-policy";

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  approvalStatus: string;
}

function mapAuthError(error: unknown, fallback: string): ApiError {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: unknown } | null)?.code
    ?? (error as { body?: { code?: unknown } } | null)?.body?.code;
  const status = (error as { statusCode?: unknown } | null)?.statusCode
    ?? (error as { status?: unknown } | null)?.status;

  if (code === "INVALID_PASSWORD") {
    return new ApiError("Current password is incorrect.", 400);
  }
  if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") {
    return new ApiError("The new password does not meet the length requirements.", 400);
  }
  if (code === "CREDENTIAL_ACCOUNT_NOT_FOUND") {
    return new ApiError("This account does not have a password set.", 400);
  }
  if (status === 401) {
    return new ApiError("Your session has expired. Sign in again.", 401);
  }
  if (status === 403) {
    return new ApiError("This action is not allowed.", 403);
  }
  if (status === 429) {
    return new ApiError("Too many requests. Try again later.", 429);
  }
  return new ApiError(fallback, 400);
}

export async function getAdminProfile(userId: string): Promise<AdminProfile> {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
      approvalStatus: user.approvalStatus,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!row) throw new ApiError("Administrator account not found.", 404);
  return row;
}

/**
 * Updates only the display name. Role, email, approval state, and password are
 * deliberately absent from this path; a profile payload cannot escalate
 * privileges or move the recovery channel.
 */
export async function updateAdminProfile(
  userId: string,
  rawName: unknown,
): Promise<AdminProfile> {
  const parsed = validateDisplayName(rawName);
  if (!parsed.ok) throw new ApiError(parsed.message);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        role: user.role,
        approvalStatus: user.approvalStatus,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!existing) throw new ApiError("Administrator account not found.", 404);

    if (existing.name !== parsed.value) {
      await tx
        .update(user)
        .set({ name: parsed.value, updatedAt: new Date() })
        .where(eq(user.id, userId));

      await logActivity(
        {
          actorUserId: userId,
          targetUserId: userId,
          action: "admin_profile_updated",
          resourceType: "user",
          resourceId: userId,
          metadata: { field: "name", previousName: existing.name, name: parsed.value },
        },
        tx,
      );
    }

    return { ...existing, name: parsed.value };
  });
}

async function countOtherSessions(
  userId: string,
  currentSessionId: string,
): Promise<number> {
  const rows = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())));
  return rows.filter((row) => row.id !== currentSessionId).length;
}

export interface ChangeAdminPasswordInput {
  headers: Headers;
  userId: string;
  currentSessionId: string;
  currentPassword: string;
  newPassword: string;
}

/**
 * Changes the password through Better Auth with `revokeOtherSessions: true`.
 * Better Auth performs the password update and session rotation in one
 * transaction and returns the new session cookie in `Set-Cookie`. That header
 * is forwarded so the current browser stays signed in; the response body is
 * replaced because Better Auth's body contains the new raw session token.
 */
export async function changeAdminPassword(
  input: ChangeAdminPasswordInput,
): Promise<Response> {
  const otherSessions = await countOtherSessions(
    input.userId,
    input.currentSessionId,
  );

  let authResponse: Response;
  try {
    authResponse = await auth.api.changePassword({
      headers: input.headers,
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      asResponse: true,
    });
  } catch (error) {
    throw mapAuthError(error, "Unable to change password.");
  }

  if (!authResponse.ok) {
    const body = (await authResponse.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    throw mapAuthError(body, "Unable to change password.");
  }

  await logActivity({
    actorUserId: input.userId,
    targetUserId: input.userId,
    action: "admin_password_changed",
    resourceType: "user",
    resourceId: input.userId,
    metadata: { otherSessionsRevoked: otherSessions },
  });

  const responseHeaders = new Headers();
  for (const cookie of authResponse.headers.getSetCookie()) {
    responseHeaders.append("set-cookie", cookie);
  }
  responseHeaders.set("content-type", "application/json");
  responseHeaders.set("cache-control", "no-store");

  return new Response(
    JSON.stringify({ success: true, otherSessionsRevoked: otherSessions }),
    { status: 200, headers: responseHeaders },
  );
}

