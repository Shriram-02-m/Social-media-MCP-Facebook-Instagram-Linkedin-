import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import { waitForAuthorization } from "@/lib/backend";

const schema = z.object({
  sessionId: z.string().min(1),
  timeoutSeconds: z.number().int().min(0).max(20).default(20),
});

export async function POST(request: Request) {
  try {
    const session = await requireApiSession();
    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError("Invalid request.");
    const status = await waitForAuthorization(parsed.data.sessionId, parsed.data.timeoutSeconds, session.user.id);
    return Response.json({ status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
