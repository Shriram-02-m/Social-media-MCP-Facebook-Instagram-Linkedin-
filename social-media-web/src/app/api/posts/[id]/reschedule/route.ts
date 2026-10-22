import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  canRescheduleScheduledPost,
  rescheduleScheduledPost,
  scheduledPostStatus,
} from "@/lib/backend";

const bodySchema = z.object({
  scheduledAt: z.string().min(1, "Choose a new date and time."),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireApiSession();
    const { id } = await params;

    const json = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(parsed.error.issues[0]?.message ?? "Choose a new date and time.");
    }

    const post = (await scheduledPostStatus(session.user.id)).find((item) => item.id === id);
    if (!post) throw new ApiError("That post was not found.", 404);
    if (!canRescheduleScheduledPost(post.status)) {
      throw new ApiError(
        `Only scheduled posts can be rescheduled; this post is ${post.status}.`,
      );
    }

    const rescheduled = await rescheduleScheduledPost(session.user.id, id, parsed.data.scheduledAt);
    return Response.json({ rescheduled });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
