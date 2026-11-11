import { and, desc, eq, gt } from "drizzle-orm";

import { logActivity } from "@/lib/activity";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { session, user } from "@/lib/db/schema";
import { isEmailDeliveryConfigured } from "@/lib/email";
import { validateDisplayName, validateOtp } from "@/lib/security-policy";

export interface AdminProfile {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  approvalStatus: string;
}

export interface AdminSessionSummary {
  id: string;
  current: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RecoveryStatus {
  email: string;
  emailVerified: boolean;
  deliveryConfigured: boolean;
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
  if (code === "INVALID_OTP") {
    return new ApiError("The verification code is invalid.", 400);
  }
  if (code === "OTP_EXPIRED") {
    return new ApiError("The verification code has expired. Request a new one.", 400);
  }
  if (code === "TOO_MANY_ATTEMPTS") {
    return new ApiError("Too many attempts. Request a new code.", 429);
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

export async function listAdminSessions(
  userId: string,
  currentSessionId: string,
): Promise<AdminSessionSummary[]> {
  const rows = await db
    .select({
      id: session.id,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
    })
    .from(session)
    .where(and(eq(session.userId, userId), gt(session.expiresAt, new Date())))
    .orderBy(desc(session.updatedAt));

  // Tokens are intentionally not selected or returned to the client.
  return rows.map((row) => ({
    id: row.id,
    current: row.id === currentSessionId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  }));
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

/**
 * Revokes every other session for the signed-in administrator through Better
 * Auth's own endpoint. The current session is preserved, so the UI stays
 * usable while any other device is signed out immediately.
 */
export async function revokeOtherAdminSessions(
  headers: Headers,
  userId: string,
  currentSessionId: string,
): Promise<{ revoked: number }> {
  const revoked = await countOtherSessions(userId, currentSessionId);

  try {
    await auth.api.revokeOtherSessions({ headers });
  } catch (error) {
    throw mapAuthError(error, "Unable to revoke other sessions.");
  }

  await logActivity({
    actorUserId: userId,
    targetUserId: userId,
    action: "admin_sessions_revoked",
    resourceType: "session",
    resourceId: userId,
    metadata: { revokedCount: revoked },
  });

  return { revoked };
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

export async function getRecoveryStatus(userId: string): Promise<RecoveryStatus> {
  const [row] = await db
    .select({ email: user.email, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  if (!row) throw new ApiError("Administrator account not found.", 404);
  return {
    email: row.email,
    emailVerified: row.emailVerified,
    deliveryConfigured: isEmailDeliveryConfigured(),
  };
}

/**
 * Sends a verification OTP to the administrator's current recovery email. The
 * caller must pass the email from the verified session; a client-supplied
 * address is never accepted.
 */
export async function sendRecoveryVerification(
  userId: string,
  email: string,
): Promise<{ success: true }> {
  try {
    await auth.api.sendVerificationOTP({
      body: { email, type: "email-verification" },
    });
  } catch (error) {
    throw mapAuthError(error, "Unable to send the verification code.");
  }

  await logActivity({
    actorUserId: userId,
    targetUserId: userId,
    action: "admin_recovery_email_verification_requested",
    resourceType: "user",
    resourceId: userId,
    metadata: { method: "email-otp" },
  });

  return { success: true };
}

/**
 * Verifies the OTP sent to the administrator's recovery email. The email is
 * supplied by the route from the verified session, not by the browser.
 */
export async function verifyRecoveryOtp(
  userId: string,
  email: string,
  rawOtp: unknown,
): Promise<{ success: true }> {
  const parsed = validateOtp(rawOtp);
  if (!parsed.ok) throw new ApiError(parsed.message);

  try {
    await auth.api.verifyEmailOTP({ body: { email, otp: parsed.value } });
  } catch (error) {
    throw mapAuthError(error, "Unable to verify the code.");
  }

  await logActivity({
    actorUserId: userId,
    targetUserId: userId,
    action: "admin_recovery_email_verified",
    resourceType: "user",
    resourceId: userId,
    metadata: { method: "email-otp" },
  });

  return { success: true };
}
