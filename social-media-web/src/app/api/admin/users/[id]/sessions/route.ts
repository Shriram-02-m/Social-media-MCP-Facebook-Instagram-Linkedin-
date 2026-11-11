import { z } from "zod";

import { performAccountAction } from "@/lib/admin-accounts";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const idSchema = z.string().trim().min(1).max(128);

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin();
    const id = idSchema.safeParse((await params).id);
    if (!id.success) throw new ApiError("Invalid user id.");
    return Response.json(
      await performAccountAction(session.user.id, id.data, "revoke_sessions"),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
