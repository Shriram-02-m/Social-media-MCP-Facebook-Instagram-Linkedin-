import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const { auth } = await import("../src/lib/auth");

const alreadyValid = await auth.api
  .signInEmail({ body: { email, password } })
  .then(() => true)
  .catch(() => false);

if (alreadyValid) {
  console.log(`Admin ${email} already exists and the password matches.`);
  process.exit(0);
}

try {
  await auth.api.signUpEmail({ body: { email, password, name: adminName } });
  console.log(`Created admin ${email}.`);
} catch (error) {
  console.error("Could not create the admin account:");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
