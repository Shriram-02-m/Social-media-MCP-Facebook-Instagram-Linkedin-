import { parseSocialAccountFilters } from "@/lib/admin-policy";
import { listSocialAccounts } from "@/lib/admin-social-accounts";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const filters = parseSocialAccountFilters(new URL(request.url).searchParams);
    return Response.json(await listSocialAccounts(filters));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
