import { listUsers } from "@/lib/admin-users";
import { parseUserFilters } from "@/lib/admin-users-policy";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

// Admin-only directory. Authorization is enforced here, not only in the UI.
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const filters = parseUserFilters(new URL(request.url).searchParams);
    return Response.json(await listUsers(filters));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
