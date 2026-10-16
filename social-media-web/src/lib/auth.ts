import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";

const baseURL = process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL,
  trustedOrigins: [baseURL],
  emailAndPassword: {
    enabled: true,
    // Public sign-up is enabled. Set ALLOW_ADMIN_SIGNUP=false to restrict provisioning to scripts/seed-admin.ts.
    disableSignUp: process.env.ALLOW_ADMIN_SIGNUP === "false",
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
});
