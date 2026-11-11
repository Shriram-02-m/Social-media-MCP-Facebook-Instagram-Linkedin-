import { headers } from "next/headers";

import { listAdminSessions, revokeOtherAdminSessions } from "@/lib/admin-security";
import { apiErrorResponse } from "@/lib/api";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await requireAdmin();
    return Response.json({
      sessions: await listAdminSessions(session.user.id, session.session.id),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const session = await requireAdmin();
    return Response.json(
      await revokeOtherAdminSessions(
        new Headers(await headers()),
        session.user.id,
        session.session.id,
      ),
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
