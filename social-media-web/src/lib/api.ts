import { headers } from "next/headers";

import { auth } from "@/lib/auth";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export async function requireApiSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new ApiError("Authentication required.", 401);
  return session;
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("[api] unhandled error:", error);
  const message = error instanceof Error ? error.message : "Unexpected error.";
  return Response.json({ error: message }, { status: 500 });
}
