import { headers } from "next/headers";

import { auth } from "@/lib/auth";

export type AdminSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export async function getSession(): Promise<AdminSession> {
  return auth.api.getSession({ headers: await headers() });
}

export class UnauthorizedError extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "UnauthorizedError";
  }
}

export async function requireAdmin(): Promise<NonNullable<AdminSession>> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}
