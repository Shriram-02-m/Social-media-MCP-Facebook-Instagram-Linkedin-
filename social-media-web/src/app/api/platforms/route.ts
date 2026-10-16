import { apiErrorResponse, requireApiSession } from "@/lib/api";
import { linkedinConnectionStatus, metaConnectionStatus } from "@/lib/backend";

type PlatformId = "facebook" | "instagram" | "linkedin";

async function check(platform: PlatformId): Promise<Record<string, unknown>> {
  try {
    const status =
      platform === "linkedin"
        ? await linkedinConnectionStatus()
        : await metaConnectionStatus(platform);
    return { platform, ...status };
  } catch (error) {
    return {
      platform,
      connected: false,
      error: error instanceof Error ? error.message : "Status check failed.",
    };
  }
}

export async function GET() {
  try {
    await requireApiSession();
    const platforms = await Promise.all(
      (["facebook", "instagram", "linkedin"] as const).map(check),
    );
    return Response.json({ platforms });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
