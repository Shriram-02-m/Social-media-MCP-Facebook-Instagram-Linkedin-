import { redirect } from "next/navigation";

import {
  ApprovalRequiredError,
  requireAdmin,
  UnauthorizedError,
} from "@/lib/session";

/**
 * Server-page guard for admin-only screens. Regular users are sent back to the
 * dashboard instead of seeing an error boundary; the API routes still return
 * 403 for direct requests.
 */
export async function requireAdminPage() {
  try {
    return await requireAdmin();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/login");
    if (error instanceof ApprovalRequiredError) redirect("/");
    throw error;
  }
}
