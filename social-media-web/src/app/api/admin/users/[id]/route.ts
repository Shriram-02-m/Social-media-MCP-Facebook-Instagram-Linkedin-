import { z } from "zod";

import { getUserDetail, updateUser } from "@/lib/admin-users";
import {
  MANAGEABLE_APPROVAL_STATUSES,
  USER_ROLES,
  type UserUpdate,
} from "@/lib/admin-users-policy";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const idSchema = z.string().trim().min(1).max(128);

const updateSchema = z
  .object({
    role: z.enum(USER_ROLES).optional(),
    approvalStatus: z.enum(MANAGEABLE_APPROVAL_STATUSES).optional(),
  })
  .strict()
  .refine(
    (value) => value.role !== undefined || value.approvalStatus !== undefined,
    { message: "Provide a role or approvalStatus to update." },
  );

async function targetId(params: Promise<{ id: string }>): Promise<string> {
  const parsed = idSchema.safeParse((await params).id);
  if (!parsed.success) throw new ApiError("Invalid user id.");
  return parsed.data;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin();
    const detail = await getUserDetail(await targetId(params));
    if (!detail) throw new ApiError("User not found.", 404);
    return Response.json({ user: detail });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin();
    const id = await targetId(params);

    const body = await request.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(parsed.error.issues[0]?.message ?? "Invalid request.");
    }

    const updated = await updateUser(
      session.user.id,
      id,
      parsed.data as UserUpdate,
    );
    return Response.json({ user: updated });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
