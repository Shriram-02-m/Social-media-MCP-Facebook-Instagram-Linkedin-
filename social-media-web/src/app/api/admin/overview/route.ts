import { getAdminUserStats } from "@/lib/admin-overview";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdmin();
    return Response.json(await getAdminUserStats());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
