import { z } from "zod";

import { ApiError, apiErrorResponse, requireApiSession } from "@/lib/api";
import {
  appCredentialStatuses,
  deleteAppCredentials,
  saveAppCredentials,
  userAppCredentialsActive,
  validateAppCredentialInput,
} from "@/lib/backend";

const providerEnum = z.enum(["facebook", "instagram", "linkedin"]);

// Returns only safe metadata: the (public) client/app id for the user's own
// record and whether they are on the shared fallback. The secret is never read
// here and never leaves the database in plaintext.
export async function GET() {
  try {
    const session = await requireApiSession();
    const credentials = await appCredentialStatuses(session.user.id);
    return Response.json({ active: userAppCredentialsActive(), credentials });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const saveSchema = z.object({
  provider: providerEnum,
  clientId: z.string(),
  // Optional so a blank field preserves the stored secret on an update.
  clientSecret: z.string().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await requireApiSession();
    if (!userAppCredentialsActive()) {
      throw new ApiError(
        "User-owned developer app credentials require the cloud backend (TOKEN_STORE_BACKEND=supabase).",
        409,
      );
    }
    const body = await request.json().catch(() => null);
    const parsed = saveSchema.safeParse(body);
    if (!parsed.success) throw new ApiError("Invalid developer app credentials.");
    const { provider, clientId, clientSecret } = parsed.data;

    const issue = validateAppCredentialInput(provider, clientId, clientSecret, false);
    if (issue) throw new ApiError(issue);

    const configured = (await appCredentialStatuses(session.user.id))
      .find((entry) => entry.provider === provider)?.configured ?? false;
    if (!configured && !(clientSecret ?? "").trim()) {
      throw new ApiError("Enter the app/client secret to save this credential.");
    }

    await saveAppCredentials(session.user.id, provider, { clientId, clientSecret });
    return Response.json({ credentials: await appCredentialStatuses(session.user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const session = await requireApiSession();
    if (!userAppCredentialsActive()) {
      throw new ApiError(
        "User-owned developer app credentials require the cloud backend (TOKEN_STORE_BACKEND=supabase).",
        409,
      );
    }
    const parsed = providerEnum.safeParse(new URL(request.url).searchParams.get("provider"));
    if (!parsed.success) throw new ApiError("Invalid provider.");

    // Removing the app configuration never touches stored social tokens or
    // scheduled posts; the user simply falls back to the shared app.
    await deleteAppCredentials(session.user.id, parsed.data);
    return Response.json({ credentials: await appCredentialStatuses(session.user.id) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
