import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq } from "drizzle-orm";

// Emergency, offline recovery for the single Super Admin. This is deliberately
// a CLI script rather than an HTTP endpoint: it needs direct database access,
// an explicit operator acknowledgement, and a password supplied out of band.
// There is no unauthenticated path to change an administrator password.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

for (const file of [
  path.join(root, ".env.local"),
  path.join(root, ".env"),
  path.join(root, "..", "social-media-mcp", ".env"),
]) {
  if (!existsSync(file)) continue;
  const text = await readFile(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

const ACK_PHRASE = "recover-super-admin";
const acknowledgement = process.env.RECOVER_ADMIN_ACKNOWLEDGE?.trim();
if (acknowledgement !== ACK_PHRASE) {
  console.error(
    `Refusing to run. Set RECOVER_ADMIN_ACKNOWLEDGE=${ACK_PHRASE} to confirm this is an intentional emergency recovery.`,
  );
  process.exit(1);
}

const newPassword = process.env.ADMIN_NEW_PASSWORD ?? process.env.ADMIN_PASSWORD;
if (!newPassword) {
  console.error("Set ADMIN_NEW_PASSWORD (or ADMIN_PASSWORD) to the new administrator password.");
  process.exit(1);
}

const { validatePasswordStrength } = await import("../src/lib/security-policy");
const strength = validatePasswordStrength(newPassword);
if (!strength.ok) {
  console.error(strength.message);
  process.exit(1);
}

const { hashPassword } = await import("better-auth/crypto");
const { ADMIN_ROLE } = await import("../src/lib/auth");
const { db } = await import("../src/lib/db");
const { account, session, user } = await import("../src/lib/db/schema");
const { logActivity } = await import("../src/lib/activity");

const admins = await db
  .select({ id: user.id, email: user.email })
  .from(user)
  .where(eq(user.role, ADMIN_ROLE));

if (admins.length === 0) {
  console.error("No active Super Admin found. Use db:seed-admin to provision one.");
  process.exit(1);
}
if (admins.length > 1) {
  console.error("Multiple Super Admin rows found; refusing to guess. Resolve this manually first.");
  process.exit(1);
}

const admin = admins[0]!;
const passwordHash = await hashPassword(newPassword);

try {
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, admin.id), eq(account.providerId, "credential")))
      .limit(1);

    if (existing) {
      await tx
        .update(account)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(eq(account.id, existing.id));
    } else {
      await tx.insert(account).values({
        id: randomUUID(),
        accountId: admin.id,
        providerId: "credential",
        userId: admin.id,
        password: passwordHash,
      });
    }

    // Any session issued before this recovery is untrusted.
    await tx.delete(session).where(eq(session.userId, admin.id));

    // A recovered admin must be able to sign in; clear a stale lockout state
    // without changing the role or ownership of any other data.
    await tx
      .update(user)
      .set({
        approvalStatus: "approved",
        banned: false,
        banReason: null,
        banExpires: null,
        deletedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(user.id, admin.id));

    await logActivity(
      {
        actorUserId: admin.id,
        targetUserId: admin.id,
        action: "admin_emergency_password_recovery",
        resourceType: "user",
        resourceId: admin.id,
        metadata: { method: "offline-script", sessionsRevoked: true },
      },
      tx,
    );
  });
} catch (error) {
  console.error("Emergency recovery failed:");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`Super Admin ${admin.email} password recovered. All sessions were revoked.`);
