"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL?.trim() || undefined,
});

export const { signIn, signOut, useSession } = authClient;
