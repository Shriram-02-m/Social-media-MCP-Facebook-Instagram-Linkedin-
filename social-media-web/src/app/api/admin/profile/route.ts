import { z } from "zod";

import { getAdminProfile, updateAdminProfile } from "@/lib/admin-security";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

// Strict: only the display name can be changed. Role, email, approval state,
// and password are not part of this contract and are rejected if supplied.
const updateSchema = z
  .object({
    name: z.string(),
  })
  .strict();

export async function GET() {
  try {
    const session = await requireAdmin();
    return Response.json(await getAdminProfile(session.user.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const session = await requireAdmin();
    const body = updateSchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      throw new ApiError(body.error.issues[0]?.message ?? "Invalid profile update.");
    }
    return Response.json(await updateAdminProfile(session.user.id, body.data.name));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
