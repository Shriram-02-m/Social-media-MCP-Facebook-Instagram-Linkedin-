import { headers } from "next/headers";
import { z } from "zod";

import { changeAdminPassword } from "@/lib/admin-security";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";
import { validatePasswordChange } from "@/lib/security-policy";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    currentPassword: z.string(),
    newPassword: z.string(),
    confirmPassword: z.string(),
  })
  .strict();

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      throw new ApiError(body.error.issues[0]?.message ?? "Invalid password change.");
    }

    const parsed = validatePasswordChange(body.data);
    if (!parsed.ok) throw new ApiError(parsed.message);

    // Better Auth verifies the current password, updates the hash, revokes all
    // other sessions, and issues a replacement cookie. The helper forwards the
    // Set-Cookie header and strips the raw session token from the body.
    return await changeAdminPassword({
      headers: new Headers(await headers()),
      userId: session.user.id,
      currentSessionId: session.session.id,
      currentPassword: parsed.value.currentPassword,
      newPassword: parsed.value.newPassword,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
