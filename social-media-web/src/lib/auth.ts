
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { logActivity } from "@/lib/activity";

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

// Shown to a user whose account was suspended when they try to sign in.
// Contains no account details beyond the plain suspension notice.
const BANNED_USER_MESSAGE =
  "This account has been suspended. Contact the administrator if you believe this is a mistake.";

// The single Super Admin signature used to detect an existing admin row.
export const ADMIN_ROLE = "admin";

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
  user: {
    additionalFields: {
      // Server-managed only (`input: false`): a signup or profile-update
      // payload can never change the approval state. New rows default to
      // pending; migration 0002 backfilled the pre-existing users as approved.
      approvalStatus: {
        type: "string" as const,
        required: false,
        defaultValue: "pending",
        input: false,
      },
      deletedAt: {
        type: "date" as const,
        required: false,
        input: false,
      },
    },
  },
  plugins: [
    admin({
      adminRoles: ["admin"],
      defaultRole: "user",
      bannedUserMessage: BANNED_USER_MESSAGE,
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        // Server-side signup protection: whatever the client sends, every
        // freshly registered user is a regular pending user. Role changes are
        // reserved for the admin plugin's admin-only endpoints, and the
        // database's partial unique `role` index (migration 0002) guarantees
        // at most one admin row even under a misplaced call.
        before: async (user) => ({
          data: {
            ...user,
            role: "user",
            approvalStatus: "pending",
            banned: false,
            banReason: null,
            banExpires: null,
            deletedAt: null,
          },
        }),
        after: async (user) => {
          // Audit: registration creates a pending account that waits for admin
          // approval. The signup session is discarded right after creation.
          await logActivity({
            actorUserId: user.id,
            targetUserId: user.id,
            action: "user_signup_pending",
            resourceType: "user",
            resourceId: user.id,
            metadata: { approvalStatus: "pending" },
          });
        },
      },
    },
    session: {
      create: {
        // Soft-deleted users can never create a new session, even with valid
        // credentials or a replayed login request.
        before: async (session) => {
          const [user] = await db
            .select({ deletedAt: schema.user.deletedAt, banned: schema.user.banned })
            .from(schema.user)
            .where(eq(schema.user.id, session.userId))
            .limit(1);
          if (user?.deletedAt) return false;
          // Banned users are already rejected natively by the admin plugin
          // with BANNED_USER_MESSAGE; this is a belt-and-braces guard.
          if (user?.banned) return false;
          return undefined;
        },
      },
    },
  },
});

export type AppUser = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>["user"];
