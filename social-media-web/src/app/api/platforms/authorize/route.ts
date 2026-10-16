import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import { beginAuthorization, getAuthorizationStatus } from "@/lib/backend";

const platformEnum = z.enum(["facebook", "instagram", "linkedin"]);

export async function POST(request: Request) {
  try {
    await requireApiSession();
    const body = await request.json().catch(() => null);
    const parsed = z
      .object({ platform: platformEnum })
      .safeParse(body);
    if (!parsed.success) throw new ApiError("Invalid platform.");
    const { platform } = parsed.data;
    const result = await beginAuthorization(platform);
    return Response.json({ platform, ...result });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    await requireApiSession();
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) throw new ApiError("sessionId is required.");
    const status = await getAuthorizationStatus(sessionId);
    return Response.json({ status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
