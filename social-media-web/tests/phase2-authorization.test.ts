import { describe, expect, it, vi, beforeEach } from "vitest";

// The authorization helpers read the verified session through
// auth.api.getSession; the mock below stands in for Better Auth itself.
const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: getSessionMock } },
  ADMIN_ROLE: "admin",
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers(),
}));

import {
  ApprovalRequiredError,
  readAccountState,
  requireAdmin,
  requireApprovedUser,
  requireAuthenticatedUser,
  requireResourceOwnership,
  UnauthorizedError,
} from "@/lib/session";

function sessionWith(fields: Record<string, unknown>) {
  return {
    session: { id: "sess-1", token: "tok" },
    user: { id: "u-1", name: "U", email: "u@example.com", ...fields },
  };
}

beforeEach(() => {
  getSessionMock.mockReset();
});

describe("readAccountState", () => {
  it("classifies an approved regular user", () => {
    const state = readAccountState(sessionWith({ role: "user", approvalStatus: "approved", banned: false }) as never);
    expect(state).toMatchObject({ role: "user", isAdmin: false, approvalStatus: "approved", deleted: false, banActive: false });
  });

  it("detects the admin role in comma-joined role strings", () => {
    const state = readAccountState(sessionWith({ role: "admin,other", approvalStatus: "approved", banned: false }) as never);
    expect(state?.isAdmin).toBe(true);
  });

  it("defaults unknown approval values to pending", () => {
    const state = readAccountState(sessionWith({ role: "user" }) as never);
    expect(state?.approvalStatus).toBe("pending");
  });
});

describe("requireAuthenticatedUser", () => {
  it("returns the session when one exists", async () => {
    getSessionMock.mockResolvedValue(sessionWith({ approvalStatus: "approved" }));
    const session = await requireAuthenticatedUser();
    expect(session.user.id).toBe("u-1");
  });

  it("throws UnauthorizedError without a session", async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(requireAuthenticatedUser()).rejects.toBeInstanceOf(UnauthorizedError);
  });
});

describe("requireApprovedUser", () => {
  it("allows approved users and the approved admin", async () => {
    getSessionMock.mockResolvedValue(sessionWith({ role: "user", approvalStatus: "approved", banned: false }));
    await expect(requireApprovedUser()).resolves.toBeTruthy();

    getSessionMock.mockResolvedValue(sessionWith({ role: "admin", approvalStatus: "approved", banned: false }));
    await expect(requireApprovedUser()).resolves.toBeTruthy();
  });

  it.each([
    ["pending accounts", { role: "user", approvalStatus: "pending", banned: false }, "pending"],
    ["rejected accounts", { role: "user", approvalStatus: "rejected", banned: false }, "rejected"],
    ["not-yet-expired suspensions", { role: "user", approvalStatus: "approved", banned: true, banExpires: new Date(Date.now() + 60_000) }, "suspended"],
    ["permanent suspensions", { role: "user", approvalStatus: "approved", banned: true }, "suspended"],
    ["soft-deleted accounts", { role: "user", approvalStatus: "approved", banned: false, deletedAt: new Date() }, "deleted"],
  ])("denies %s", async (_label, fields, expectedCode) => {
    getSessionMock.mockResolvedValue(sessionWith(fields));
    const error = await requireApprovedUser().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect((error as ApprovalRequiredError).code).toBe(expectedCode);
  });

  it("treats an expired suspension as no longer banned", async () => {
    getSessionMock.mockResolvedValue(
      sessionWith({ role: "user", approvalStatus: "approved", banned: true, banExpires: new Date(Date.now() - 1000) }),
    );
    await expect(requireApprovedUser()).resolves.toBeTruthy();
  });
});

describe("requireAdmin", () => {
  it("allows the approved Super Admin", async () => {
    getSessionMock.mockResolvedValue(sessionWith({ role: "admin", approvalStatus: "approved", banned: false }));
    await expect(requireAdmin()).resolves.toBeTruthy();
  });

  it.each([
    ["regular users", { role: "user", approvalStatus: "approved", banned: false }],
    ["pending users", { role: "user", approvalStatus: "pending" }],
    ["unapproved admins (cannot be created, defense in depth)", { role: "admin", approvalStatus: "pending" }],
  ])("denies %s", async (_label, fields) => {
    getSessionMock.mockResolvedValue(sessionWith(fields));
    await expect(requireAdmin()).rejects.toBeTruthy();
  });
});

describe("requireResourceOwnership", () => {
  it("rejects a client-supplied user id that differs from the session", async () => {
    expect(() => requireResourceOwnership(sessionWith({}) as never, "u-2")).toThrow();
    expect(() => requireResourceOwnership(sessionWith({}) as never, "u-1")).not.toThrow();
  });
});
