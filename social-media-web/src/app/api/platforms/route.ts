import { apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  linkedinConnectionStatus,
  loadTokenMetadata,
  metaConnectionStatus,
} from "@/lib/backend";

type PlatformId = "facebook" | "instagram" | "linkedin";

async function check(
  ownerId: string,
  platform: PlatformId,
): Promise<Record<string, unknown> & { platform: PlatformId }> {
  try {
    const status =
      platform === "linkedin"
        ? await linkedinConnectionStatus(ownerId)
        : await metaConnectionStatus(ownerId, platform);
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
    const session = await requireApiSession();
    const [platforms, metadata] = await Promise.all([
      Promise.all(
        (["facebook", "instagram", "linkedin"] as const).map((platform) =>
          check(session.user.id, platform),
        ),
      ),
      // Display-only fields (account name, token expiry). Token material is
      // decrypted in memory by the token store and is never put in the response.
      loadTokenMetadata(session.user.id).catch(() => []),
    ]);

    const byPlatform = new Map(metadata.map((entry) => [entry.platform, entry]));
    const merged = platforms.map((status) => {
      const meta = byPlatform.get(status.platform);
      if (!meta) return status;
      return {
        ...status,
        // Provider status checks win when they report these fields; metadata
        // fills the gaps (Facebook/Instagram status does not return a name/expiry).
        accountName: status.accountName ?? meta.accountName ?? undefined,
        expiresAt:
          typeof status.expiresAt === "number" ? status.expiresAt : meta.expiresAt ?? undefined,
        tokenExpired:
          typeof status.tokenExpired === "boolean" ? status.tokenExpired : meta.expired,
        connectedAt: meta.connectedAt,
      };
    });

    return Response.json({ platforms: merged });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
