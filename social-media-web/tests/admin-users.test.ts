import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("whitelists approval and role filters", () => {
    expect(parseUserFilters({ approval: "APPROVED", role: "ADMIN" })).toEqual({
      query: "",
      approval: "approved",
      role: "admin",
    });
    expect(parseUserFilters({ approval: "bogus", role: "bogus" })).toEqual({
      query: "",
      approval: "all",
      role: "all",
    });
  });

  it("reads URLSearchParams and array values", () => {
    expect(
      parseUserFilters(new URLSearchParams({ q: "dinesh", approval: "rejected" })),
    ).toMatchObject({ query: "dinesh", approval: "rejected" });
    expect(parseUserFilters({ q: ["first", "second"] }).query).toBe("first");
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
      counts: { total: 1, pending: 0, approved: 1, rejected: 0 },
    });

    const response = await listUsersRoute(
      new Request("https://example.test/api/admin/users?approval=approved"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ counts: { total: 1 } });
    expect(listUsersMock).toHaveBeenCalledWith({
      query: "",
      approval: "approved",
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
});
