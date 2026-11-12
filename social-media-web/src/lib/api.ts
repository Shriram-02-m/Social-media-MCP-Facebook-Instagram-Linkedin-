import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import {
  ApprovalRequiredError,
  SessionUnavailableError,
  requireApprovedUser,
  UnauthorizedError,
} from "@/lib/session";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Standard protected-API helper. Beyond session validity it enforces the
// account-approval gate: pending, rejected, suspended, and soft-deleted users
// are rejected even if a previously issued session cookie is still valid.
// Admin-only routes must additionally call requireAdmin() from "@/lib/session".
export async function requireApiSession() {
  return requireApprovedUser();
}

export async function currentSessionOrNull() {
  return auth.api.getSession({ headers: await headers() });
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof ApprovalRequiredError) {
    return Response.json({ error: error.message, code: error.code }, { status: 403 });
  }
  if (error instanceof SessionUnavailableError) {
    // 503, not 500 or 401: the caller is still authenticated; the session
    // store is temporarily unreachable. Clients may retry.
    return Response.json({ error: error.message, code: error.code }, { status: 503 });
  }
  console.error("[api] unhandled error:", error);
  const message = error instanceof Error ? error.message : "Unexpected error.";
  return Response.json({ error: message }, { status: 500 });
}
