import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { and, eq, ne } from "drizzle-orm";

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

process.env.ALLOW_ADMIN_SIGNUP = "true";

const email = process.env.ADMIN_EMAIL?.trim();
const password = process.env.ADMIN_PASSWORD;
const adminName = process.env.ADMIN_NAME?.trim() || "Administrator";

if (!email || !password) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD before seeding the admin account.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("ADMIN_PASSWORD must be at least 8 characters.");
  process.exit(1);
}

const { auth, ADMIN_ROLE } = await import("../src/lib/auth");
const { db } = await import("../src/lib/db");
const { user } = await import("../src/lib/db/schema");
const { logActivity } = await import("../src/lib/activity");

// Single-Super-Admin invariant: refuse when any admin already exists. The
// database makes this bulletproof via the partial unique `role` index
// (migration 0002); this early check gives a clear refusal message, and the
// promote step below re-verifies inside a transaction so concurrent
// invocations can never create two admins.
const existingAdmins = await db
  .select({ id: user.id, email: user.email })
  .from(user)
  .where(eq(user.role, ADMIN_ROLE));

if (existingAdmins.length > 0) {
  console.error(
    `A Super Admin already exists (${existingAdmins[0]!.email}). Refusing to create another one.`,
  );
  process.exit(1);
}

const alreadyValid = await auth.api
  .signInEmail({ body: { email, password } })
  .then(() => true)
  .catch(() => false);

// If the configured credentials already sign in, only accept that as "done"
// when the matched account actually IS the Super Admin. A previous failed
// seeding attempt (e.g. an aborted run between signup and promotion) can
// leave a role=user row behind; in that case fall through to the promotion
// step below, which re-verifies the single-admin invariant transactionally.
let promoteUserId: string | undefined;
if (alreadyValid) {
  const [row] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  if (row && row.role === ADMIN_ROLE) {
    console.log(`Admin ${email} already exists and is already the Super Admin.`);
    process.exit(0);
  }
  if (!row) {
    console.error(
      "The credentials matched no user row. Refusing to continue without signup.",
    );
    process.exit(1);
  }
  promoteUserId = row.id;
  console.log(`Credentials match ${email} (role=${row.role}); completing promotion to Super Admin.`);
} else {
  try {
    const created = await auth.api.signUpEmail({ body: { email, password, name: adminName } });
    promoteUserId = (created?.user as { id?: string } | undefined)?.id;
  } catch (error) {
    console.error("Could not create the admin account:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Promote the account (freshly created as pending/role=user, or recovered
// from an earlier aborted seeding attempt) to the Super Admin inside one
// transaction. The partial unique index aborts this transaction if a
// concurrent run promoted a different account first.
try {
  promoteUserId = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    if (!row) throw new Error(`User ${email} was not found after signup.`);
    if (promoteUserId && row.id !== promoteUserId) {
      throw new Error(`The promoted row is not the account the credentials belong to.`);
    }
    const blockers = await tx
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(and(eq(user.role, ADMIN_ROLE), ne(user.id, row.id)));
    if (blockers.length > 0) {
      throw new Error(
        `A Super Admin already exists (${blockers[0]!.email}). Refusing to create another one.`,
      );
    }
    await tx
      .update(user)
      .set({
        role: ADMIN_ROLE,
        approvalStatus: "approved",
        banned: false,
        banReason: null,
        banExpires: null,
        deletedAt: null,
      })
      .where(eq(user.id, row.id));
    return row.id;
  });
} catch (error) {
  const code = error instanceof Error && "code" in error ? String((error as { code?: unknown }).code) : "";
  if (code === "23505") {
    console.error("A Super Admin already exists (database single-admin invariant enforced). Refusing.");
  } else {
    console.error("Could not promote the admin account:");
    console.error(error instanceof Error ? error.message : error);
  }
  process.exit(1);
}

// Audit: admin initialization. Non-sensitive metadata only.
await logActivity({
  actorUserId: promoteUserId,
  targetUserId: promoteUserId,
  action: "admin_initialized",
  resourceType: "user",
  resourceId: promoteUserId,
  metadata: { seededBy: "seed-admin" },
});

console.log(`Super Admin ${email} initialized (role=admin, approved).`);
