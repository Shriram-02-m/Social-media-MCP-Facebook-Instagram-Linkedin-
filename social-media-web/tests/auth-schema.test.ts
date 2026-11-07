import { getTableColumns } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { getAuthTables } from "better-auth/db";
import { admin } from "better-auth/plugins/admin";
import { describe, expect, it } from "vitest";

import { session, user } from "@/lib/db/schema";

// Mirrors the schema Better Auth 1.7.9 builds from the admin plugin. The
// Drizzle adapter introspects Drizzle *property keys* (not SQL column names),
// so a session field declared as `impersonated_by: text("impersonated_by")`
// still fails with "Missing columns: session.impersonatedBy". This test locks
// in the camelCase property name that the plugin expects.
const authTables = getAuthTables({
  plugins: [admin({ adminRoles: ["admin"] })],
});

function expectedColumnNames(model: "user" | "session"): string[] {
  const table = authTables[model];
  return Object.entries(table.fields).map(
    ([key, field]) => (field as { fieldName?: string }).fieldName ?? key,
  );
}

const columns = {
  user: getTableColumns(user),
  session: getTableColumns(session),
} satisfies Record<"user" | "session", Record<string, PgColumn>>;

describe("Better Auth Drizzle schema parity", () => {
  it.each(["user", "session"] as const)(
    "declares every Better Auth column on the %s table",
    (model) => {
      for (const name of expectedColumnNames(model)) {
        expect(columns[model], `${model}.${name} is missing`).toHaveProperty(name);
      }
    },
  );

  it("maps session.impersonatedBy to a nullable snake_case column", () => {
    const column = columns.session.impersonatedBy;
    expect(column, "session.impersonatedBy is missing").toBeDefined();
    expect(column.name).toBe("impersonated_by");
    expect(column.notNull).toBe(false);
    expect(column.columnType).toBe("PgText");
  });

  it("keeps the admin-plugin user columns nullable/defaulted", () => {
    expect(columns.user.role.notNull).toBe(true);
    expect(columns.user.role.default).toBe("user");
    expect(columns.user.banned.notNull).toBe(true);
    expect(columns.user.banned.default).toBe(false);
    expect(columns.user.banReason.notNull).toBe(false);
    expect(columns.user.banExpires.notNull).toBe(false);
  });
});
