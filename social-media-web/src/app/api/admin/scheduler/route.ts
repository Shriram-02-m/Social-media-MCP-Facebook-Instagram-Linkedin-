import { parsePostFilters } from "@/lib/admin-policy";
import { listScheduledPosts } from "@/lib/admin-scheduler";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const filters = parsePostFilters(new URL(request.url).searchParams);
    return Response.json(await listScheduledPosts(filters));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
