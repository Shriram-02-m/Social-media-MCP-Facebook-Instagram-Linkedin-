import { z } from "zod";

import {
  getRecoveryStatus,
  sendRecoveryVerification,
  verifyRecoveryOtp,
} from "@/lib/admin-security";
import { ApiError, apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send") }).strict(),
  z.object({ action: z.literal("verify"), otp: z.string() }).strict(),
]);

export async function GET() {
  try {
    const session = await requireAdmin();
    return Response.json(await getRecoveryStatus(session.user.id));
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAdmin();
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      throw new ApiError(body.error.issues[0]?.message ?? "Invalid recovery action.");
    }

    // The recovery address always comes from the verified session. A request
    // body cannot redirect the OTP to a different mailbox.
    if (body.data.action === "send") {
      return Response.json(
        await sendRecoveryVerification(session.user.id, session.user.email),
      );
    }
    return Response.json(
      await verifyRecoveryOtp(session.user.id, session.user.email, body.data.otp),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
