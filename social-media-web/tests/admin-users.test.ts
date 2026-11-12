import { readFileSync } from "node:fs";

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { nonAdminCondition, userStatusCondition } from "@/lib/admin-user-filters";
import {
  parseUserFilters,
  validateUserUpdate,
  type GuardTarget,
} from "@/lib/admin-users-policy";
import { isUniqueViolation } from "@/lib/db-errors";

const readFile = (relative: string) => readFileSync(relative, "utf8");

function target(overrides: Partial<GuardTarget> = {}): GuardTarget {
  return {
    id: "user-2",
    role: "user",
    approvalStatus: "pending",
    deletedAt: null,
    ...overrides,
  };
}

describe("parseUserFilters", () => {
  it("trims and caps the search query", () => {
    const filters = parseUserFilters({ q: `  ${"a".repeat(300)}  ` });
    expect(filters.query).toHaveLength(100);
  });

  it("whitelists status and role filters", () => {
    expect(parseUserFilters({ status: "ACTIVE", role: "ADMIN" })).toEqual({
      query: "",
      status: "active",
      role: "admin",
    });
    expect(parseUserFilters({ status: "bogus", role: "bogus" })).toEqual({
      query: "",
      status: "all",
      role: "all",
    });
  });

  it("maps legacy approval links to the new status terms", () => {
    expect(parseUserFilters({ approval: "approved" })).toMatchObject({
      status: "active",
    });
    expect(parseUserFilters({ approval: "rejected" })).toMatchObject({
      status: "inactive",
    });
    expect(parseUserFilters({ approval: "pending" })).toMatchObject({
      status: "pending",
    });
  });

  it("reads URLSearchParams and array values", () => {
    expect(
      parseUserFilters(new URLSearchParams({ q: "dinesh", status: "inactive" })),
    ).toMatchObject({ query: "dinesh", status: "inactive" });
    expect(parseUserFilters({ q: ["first", "second"] }).query).toBe("first");
  });
});

describe("userStatusCondition", () => {
  const dialect = new PgDialect();

  it("filters pending users to active pending accounts in PostgreSQL", () => {
    const query = dialect.sqlToQuery(userStatusCondition("pending"));

    expect(query.sql).toContain('"user"."approval_status" =');
    expect(query.sql).toContain('"user"."banned" =');
    expect(query.sql).toContain('"user"."deleted_at" is null');
    expect(query.sql).toMatch(/ and /);
    expect(query.params).toEqual(["pending", false]);
  });

  it("filters active users to approved, unbanned, non-deleted accounts", () => {
    const query = dialect.sqlToQuery(userStatusCondition("active"));

    expect(query.sql).toContain('"user"."approval_status" =');
    expect(query.sql).toContain('"user"."banned" =');
    expect(query.sql).toContain('"user"."deleted_at" is null');
    expect(query.sql).toMatch(/ and /);
    expect(query.params).toEqual(["approved", false]);
  });

  it("filters inactive users to rejected, banned, or soft-deleted accounts", () => {
    const query = dialect.sqlToQuery(userStatusCondition("inactive"));

    expect(query.sql).toContain('"user"."approval_status" =');
    expect(query.sql).toContain('"user"."banned" =');
    expect(query.sql).toContain('"user"."deleted_at" is not null');
    expect(query.sql).toMatch(/ or /);
    expect(query.params).toEqual(["rejected", true]);
  });
});

describe("nonAdminCondition", () => {
  const dialect = new PgDialect();

  it("excludes the Super Admin role in PostgreSQL", () => {
    const query = dialect.sqlToQuery(nonAdminCondition());

    expect(query.sql).toContain('"user"."role" <>');
    expect(query.params).toEqual(["admin"]);
  });
});

describe("validateUserUpdate", () => {
  it("rejects an empty update", () => {
    expect(
      validateUserUpdate({ actorId: "admin-1", target: target(), update: {}, adminCount: 1 }),
    ).toMatchObject({ status: 400 });
  });

  it("refuses to manage a deleted account", () => {
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: target({ deletedAt: new Date() }),
        update: { approvalStatus: "approved" },
        adminCount: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it("allows approving and rejecting another account", () => {
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: target({ approvalStatus: "pending" }),
        update: { approvalStatus: "approved" },
        adminCount: 1,
      }),
    ).toBeNull();
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: target({ approvalStatus: "pending" }),
        update: { approvalStatus: "rejected" },
        adminCount: 1,
      }),
    ).toBeNull();
  });

  it("treats a redundant approval change as a conflict", () => {
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: target({ approvalStatus: "approved" }),
        update: { approvalStatus: "approved" },
        adminCount: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it("prevents the acting admin from changing their own approval or role", () => {
    const self = target({ id: "admin-1", role: "admin", approvalStatus: "approved" });
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: self,
        update: { approvalStatus: "rejected" },
        adminCount: 1,
      }),
    ).toMatchObject({ status: 409 });
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: self,
        update: { role: "user" },
        adminCount: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it("prevents creating a second admin while one exists", () => {
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: target({ role: "user" }),
        update: { role: "admin" },
        adminCount: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it("allows promotion only when no admin exists", () => {
    expect(
      validateUserUpdate({
        actorId: "admin-1",
        target: target({ role: "user" }),
        update: { role: "admin" },
        adminCount: 0,
      }),
    ).toBeNull();
  });

  it("protects the only admin from demotion", () => {
    expect(
      validateUserUpdate({
        actorId: "someone-else",
        target: target({ role: "admin", approvalStatus: "approved" }),
        update: { role: "user" },
        adminCount: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it("allows demoting a non-final admin", () => {
    expect(
      validateUserUpdate({
        actorId: "actor",
        target: target({ role: "admin", approvalStatus: "approved" }),
        update: { role: "user" },
        adminCount: 2,
      }),
    ).toBeNull();
  });
});

describe("isUniqueViolation", () => {
  it("detects a direct PostgreSQL unique violation", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("detects a unique violation wrapped by Drizzle", () => {
    const wrapped = new Error("Failed query", {
      cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it("ignores unrelated errors, nulls, and cyclic causes", () => {
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(isUniqueViolation(cyclic)).toBe(false);
  });
});

// --- Route-handler regression tests -----------------------------------------
// The handlers import the real policy module (pure) but everything that would
// touch the database or Better Auth is mocked.

const requireAdminMock = vi.hoisted(() => vi.fn());
const listUsersMock = vi.hoisted(() => vi.fn());
const getUserDetailMock = vi.hoisted(() => vi.fn());
const updateUserMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({ requireAdmin: requireAdminMock }));
vi.mock("@/lib/admin-users", () => ({
  listUsers: listUsersMock,
  getUserDetail: getUserDetailMock,
  updateUser: updateUserMock,
}));
vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    ApiError,
    apiErrorResponse: (error: unknown) => {
      if (error instanceof ApiError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof (error as { status?: unknown }).status === "number"
      ) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Forbidden." },
          { status: (error as { status: number }).status },
        );
      }
      return Response.json({ error: "Unexpected error." }, { status: 500 });
    },
  };
});

import { GET as listUsersRoute } from "@/app/api/admin/users/route";
import {
  GET as getUserRoute,
  PATCH as updateUserRoute,
} from "@/app/api/admin/users/[id]/route";

const adminSession = {
  session: { id: "sess-admin" },
  user: { id: "admin-1" },
} as never;

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  requireAdminMock.mockReset();
  listUsersMock.mockReset();
  getUserDetailMock.mockReset();
  updateUserMock.mockReset();
});

describe("admin user API authorization", () => {
  it("lists users for an admin", async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    listUsersMock.mockResolvedValue({
      users: [{ id: "u-1" }],
      counts: { total: 1, pending: 0, active: 1, inactive: 0 },
    });

    const response = await listUsersRoute(
      new Request("https://example.test/api/admin/users?status=active"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ counts: { total: 1 } });
    expect(listUsersMock).toHaveBeenCalledWith({
      query: "",
      status: "active",
      role: "all",
    });
  });

  it("returns 403 for a non-admin list request", async () => {
    requireAdminMock.mockRejectedValue(
      Object.assign(new Error("This account was not approved."), { status: 403 }),
    );

    const response = await listUsersRoute(
      new Request("https://example.test/api/admin/users"),
    );

    expect(response.status).toBe(403);
    expect(listUsersMock).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing user detail", async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    getUserDetailMock.mockResolvedValue(null);

    const response = await getUserRoute(
      new Request("https://example.test/api/admin/users/missing"),
      params("missing"),
    );

    expect(response.status).toBe(404);
  });

  it("rejects unknown or empty patch bodies", async () => {
    requireAdminMock.mockResolvedValue(adminSession);

    for (const body of [{}, { foo: "bar" }, { role: "owner" }, { approvalStatus: "pending" }]) {
      const response = await updateUserRoute(
        new Request("https://example.test/api/admin/users/u-2", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        params("u-2"),
      );
      expect(response.status).toBe(400);
    }
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("updates a user for an admin", async () => {
    requireAdminMock.mockResolvedValue(adminSession);
    updateUserMock.mockResolvedValue({ id: "u-2", approvalStatus: "approved" });

    const response = await updateUserRoute(
      new Request("https://example.test/api/admin/users/u-2", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalStatus: "approved" }),
      }),
      params("u-2"),
    );

    expect(response.status).toBe(200);
    expect(updateUserMock).toHaveBeenCalledWith("admin-1", "u-2", {
      approvalStatus: "approved",
    });
  });

  it("does not update anything for a non-admin", async () => {
    requireAdminMock.mockRejectedValue(
      Object.assign(new Error("This account was not approved."), { status: 403 }),
    );

    const response = await updateUserRoute(
      new Request("https://example.test/api/admin/users/u-2", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalStatus: "approved" }),
      }),
      params("u-2"),
    );

    expect(response.status).toBe(403);
    expect(updateUserMock).not.toHaveBeenCalled();
  });
});

describe("user-management wiring", () => {
  it("guards both admin API routes with requireAdmin", () => {
    for (const file of [
      "src/app/api/admin/users/route.ts",
      "src/app/api/admin/users/[id]/route.ts",
    ]) {
      expect(readFile(file)).toMatch(/\brequireAdmin\b/);
    }
  });

  it("guards both admin pages on the server", () => {
    for (const file of [
      "src/app/(dashboard)/users/page.tsx",
      "src/app/(dashboard)/users/[id]/page.tsx",
    ]) {
      expect(readFile(file)).toMatch(/\brequireAdminPage\b/);
    }
  });

  it("renders the Users navigation item only inside the admin group", () => {
    const sidebar = readFile("src/components/app-sidebar.tsx");
    expect(sidebar).toMatch(/const ADMIN_NAV_ITEMS/);
    expect(sidebar).toMatch(/title: "Users", href: "\/users"/);
    expect(sidebar).toMatch(/\{isAdmin \?/);
    expect(sidebar).toMatch(/<SidebarGroupLabel>Administration<\/SidebarGroupLabel>/);
  });

  it("applies the shared status filter to status lists", () => {
    const lib = readFile("src/lib/admin-users.ts");

    expect(lib).toMatch(/userStatusCondition\(filters\.status\)/);
    expect(lib).toMatch(/getAdminUserStats\(\)/);
    expect(lib).toMatch(/ilike\(user\.name/);
    expect(lib).toMatch(/ilike\(user\.email/);
    expect(lib).toMatch(/orderBy\(desc\(user\.createdAt\), asc\(user\.email\)\)/);
  });

  it("excludes Super Admin accounts from the default directory and statistics", () => {
    const lib = readFile("src/lib/admin-users.ts");
    const overview = readFile("src/lib/admin-overview.ts");
    const filters = readFile("src/lib/admin-user-filters.ts");

    expect(filters).toMatch(/export function nonAdminCondition/);
    expect(filters).toMatch(/ne\(user\.role, "admin"\)/);
    expect(overview).toMatch(/\.where\(nonAdminCondition\(\)\)/);
    expect(lib).toMatch(/nonAdminCondition\(\)/);
    expect(lib).toMatch(/if \(filters\.role !== "all"\)/);
    expect(lib).toMatch(/eq\(user\.role, filters\.role\)/);
  });

  it("keeps Total Users as every non-admin row while status counts use shared buckets", () => {
    const lib = readFile("src/lib/admin-users.ts");

    expect(lib).toMatch(/if \(filters\.status !== "all"\)/);
    expect(lib).toMatch(/total:\s*stats\.total/);
    expect(lib).toMatch(/pending:\s*stats\.pending/);
    expect(lib).toMatch(/active:\s*stats\.active/);
    expect(lib).toMatch(/inactive:\s*stats\.inactive/);
  });

  it("preserves URL-driven search, status, and role filters", () => {
    const page = readFile("src/app/(dashboard)/users/page.tsx");
    const filters = readFile("src/app/(dashboard)/users/users-filters.tsx");

    expect(page).toMatch(/parseUserFilters\(await props\.searchParams\)/);
    expect(filters).toMatch(/params\.set\("q", trimmed\)/);
    expect(filters).toMatch(/params\.set\("status", nextStatus\)/);
    expect(filters).toMatch(/params\.set\("role", nextRole\)/);
  });

  it("labels the directory statuses Active, Inactive, and Pending", () => {
    const table = readFile("src/app/(dashboard)/users/users-table.tsx");
    const filters = readFile("src/app/(dashboard)/users/users-filters.tsx");

    expect(table).toContain("Active");
    expect(table).toContain("Inactive");
    expect(table).toContain("Pending");
    expect(table).not.toContain(">Approved<");
    expect(table).not.toContain(">Rejected<");
    expect(filters).toContain('active: "Active"');
    expect(filters).toContain('inactive: "Inactive"');
    expect(filters).toContain('pending: "Pending"');
  });

  it("renders the redesigned detail sections and account fields", () => {
    const page = readFile("src/app/(dashboard)/users/[id]/page.tsx");

    for (const section of [
      "Back to users",
      "Account information",
      "Account management",
      "Social media connections",
      "Recent scheduled posts",
    ]) {
      expect(page).toContain(section);
    }

    for (const field of [
      "Full name",
      "Email address",
      "Role",
      "Account status",
      "Email verification",
      "Password login",
      "Account created",
      "Last updated",
      "Active sessions",
      "Suspended",
      "Deleted",
    ]) {
      expect(page).toContain(`label="${field}"`);
    }

    // Fixed table layout with horizontal scrolling keeps long content from
    // expanding columns and breaking the page on narrow screens.
    expect(page).toMatch(/table-fixed/);
    expect(page).toMatch(/min-w-\[960px\]/);
    expect(page).toMatch(/<colgroup>/);
    expect(page).toMatch(/<PostDetails post=\{post\} \/>/);
  });

  it("keeps grouped account actions wired to the existing endpoints", () => {
    const userActions = readFile(
      "src/app/(dashboard)/users/[id]/user-actions.tsx",
    );
    const accountActions = readFile(
      "src/app/(dashboard)/users/[id]/account-actions.tsx",
    );

    for (const group of ["Registration", "Role"]) {
      expect(userActions).toContain(group);
    }
    for (const group of [
      "Account status",
      "Account security",
      "Account management",
    ]) {
      expect(accountActions).toContain(group);
    }

    expect(userActions).toMatch(/method: "PATCH"/);
    expect(userActions).toMatch(/approvalStatus: "approved"/);
    expect(userActions).toMatch(/approvalStatus: "rejected"/);
    expect(accountActions).toMatch(/\/api\/admin\/users\/\$\{encodeURIComponent\(id\)\}\/account/);
    expect(accountActions).toMatch(/\/api\/admin\/users\/\$\{encodeURIComponent\(id\)\}\/sessions/);
    expect(accountActions).toMatch(/method: "DELETE"/);
  });

  it("exposes full post details without leaking secrets", () => {
    const page = readFile("src/app/(dashboard)/users/[id]/page.tsx");
    const details = readFile("src/app/(dashboard)/users/[id]/post-details.tsx");
    const scheduler = readFile("src/lib/admin-scheduler.ts");

    expect(details).toContain("Post details");
    expect(details).toContain("Content");
    expect(details).toContain("Error");
    expect(details).toMatch(/post\.text/);
    expect(details).toMatch(/post\.retryCount/);
    expect(details).toMatch(/post\.failureStage/);
    expect(details).toMatch(/post\.publishedUrl/);

    expect(scheduler).toMatch(/failure_stage/);
    expect(scheduler).toMatch(/created_at/);
    expect(scheduler).toMatch(/media_type/);

    for (const file of [page, details]) {
      expect(file).not.toMatch(/access_token|refresh_token|client_secret/i);
    }
  });
});
