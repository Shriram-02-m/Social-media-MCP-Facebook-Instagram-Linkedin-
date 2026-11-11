import { parseActivityFilters } from "@/lib/admin-policy";
import { listActivity } from "@/lib/admin-activity";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const filters = parseActivityFilters(new URL(request.url).searchParams);
    return Response.json(await listActivity(filters));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
