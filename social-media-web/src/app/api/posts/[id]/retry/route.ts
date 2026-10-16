import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  canSafelyRetryScheduledPost,
  retryScheduledPost,
  scheduledPostStatus,
} from "@/lib/backend";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiSession();
    const { id } = await params;

    const post = (await scheduledPostStatus()).find((item) => item.id === id);
    if (!post) throw new ApiError("That post was not found.", 404);
    if (!canSafelyRetryScheduledPost(post.status, post.failureStage)) {
      throw new ApiError(
        "This post cannot be retried. Schedule it again from the Composer.",
      );
    }

    const retry = await retryScheduledPost(id);
    return Response.json({ retry });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
