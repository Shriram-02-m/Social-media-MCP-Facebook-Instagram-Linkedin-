import { apiErrorResponse, requireApiSession } from "@/lib/api";
import { processDueJobs } from "@/lib/backend";

export async function POST() {
  try {
    await requireApiSession();
    const processed = await processDueJobs();
    return Response.json({ processed });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
