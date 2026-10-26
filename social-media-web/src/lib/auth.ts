
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const baseURL =
  process.env.BETTER_AUTH_URL?.trim() ||
  "http://localhost:3000";

const trustedOrigins = [
  baseURL,
  "https://social-media-mcp-facebook-instagram.vercel.app",
  ...(process.env.NODE_ENV === "development"
    ? ["http://localhost:3000"]
    : []),
];

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL,
  trustedOrigins: [...new Set(trustedOrigins)],
  emailAndPassword: {
    enabled: true,
    disableSignUp: process.env.ALLOW_ADMIN_SIGNUP === "false",
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
});
