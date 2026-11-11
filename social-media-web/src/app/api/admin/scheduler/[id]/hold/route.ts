import { z } from "zod";

import { adminHoldPost } from "@/lib/admin-scheduler";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const idSchema = z.string().trim().min(1).max(128);

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAdmin();
    const parsed = idSchema.safeParse((await params).id);
    if (!parsed.success) throw new ApiError("Invalid scheduled post id.");
    return Response.json(await adminHoldPost(session.user.id, parsed.data));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
