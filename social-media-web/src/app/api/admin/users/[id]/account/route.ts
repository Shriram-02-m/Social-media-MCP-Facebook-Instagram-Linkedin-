import { z } from "zod";

import { performAccountAction } from "@/lib/admin-accounts";
import { ACCOUNT_ACTIONS } from "@/lib/admin-policy";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const idSchema = z.string().trim().min(1).max(128);

const bodySchema = z
  .object({
    action: z.enum(ACCOUNT_ACTIONS),
    reason: z.string().trim().max(300).optional(),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin();
    const id = idSchema.safeParse((await params).id);
    if (!id.success) throw new ApiError("Invalid user id.");
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      throw new ApiError(body.error.issues[0]?.message ?? "Invalid account action.");
    }
    return Response.json(
      await performAccountAction(
        session.user.id,
        id.data,
        body.data.action,
        body.data.reason,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
