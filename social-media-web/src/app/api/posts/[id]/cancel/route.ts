import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import { cancelScheduledPost, scheduledPostStatus } from "@/lib/backend";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireApiSession();
    const { id } = await params;

    const post = (await scheduledPostStatus()).find((item) => item.id === id);
    if (!post) throw new ApiError("That post was not found.", 404);
    if (post.status !== "scheduled") {
      throw new ApiError("Only scheduled posts can be cancelled.");
    }

    const cancelled = await cancelScheduledPost(id);
    return Response.json({ cancelled });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
