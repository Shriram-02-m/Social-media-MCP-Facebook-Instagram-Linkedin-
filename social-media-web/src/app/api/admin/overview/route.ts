import { parseDateRange } from "@/lib/admin-policy";
import { getAdminOverview } from "@/lib/admin-overview";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const range = parseDateRange(new URL(request.url).searchParams, {
      defaultDays: 30,
      maxDays: 366,
    });
    return Response.json(await getAdminOverview(range));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
