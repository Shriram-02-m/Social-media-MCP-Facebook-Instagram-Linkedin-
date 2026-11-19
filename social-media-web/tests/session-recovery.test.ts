import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  deleteSession: vi.fn(),
  withDatabaseRecovery: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
      deleteSession: mocks.deleteSession,
    },
  },
  ADMIN_ROLE: "admin",
}));

vi.mock("@/lib/db", () => ({
  withDatabaseRecovery: mocks.withDatabaseRecovery,
}));

vi.mock("@/lib/db/diagnostics", () => ({
  newDatabaseCorrelationId: () => "corr-test",
}));

vi.mock("next/headers", () => ({
  headers: () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  unstable_rethrow: (error: unknown) => {
    if (error instanceof Error && error.name === "NextControlFlowError") throw error;
  },
}));

import {
  ApprovalRequiredError,
  getSession,
  requireAdmin,
  requireApprovedUser,
  requireAuthenticatedUser,
  SessionUnavailableError,
  UnauthorizedError,
} from "@/lib/session";

function sessionWith(fields: Record<string, unknown>) {
  return {
    session: { id: "sess-1", token: "test-token" },
    user: {
      id: "u-1",
      name: "Test User",
      email: "user@example.com",
      role: "user",
      approvalStatus: "approved",
      banned: false,
      ...fields,
    },
  };
}

const opaqueOutageError = Object.assign(new Error("Failed to get session"), {
  body: { code: "FAILED_TO_GET_SESSION" },
});

function passthroughRecovery(): void {
  mocks.withDatabaseRecovery.mockImplementation(
    async (operation: () => Promise<unknown>) => operation(),
  );
}

function retryOnceRecovery(): void {
  mocks.withDatabaseRecovery.mockImplementation(
    async (operation: () => Promise<unknown>) => {
      try {
        return await operation();
      } catch {
        return await operation();
      }
    },
  );
}

beforeEach(() => {
  mocks.getSession.mockReset();
  mocks.deleteSession.mockReset();
  mocks.withDatabaseRecovery.mockReset();
  passthroughRecovery();
});

describe("session verification with database recovery", () => {
  it("returns a verified session through the recovery wrapper", async () => {
    const verified = sessionWith({});
    mocks.getSession.mockResolvedValue(verified);

    await expect(getSession()).resolves.toEqual(verified);
    expect(mocks.withDatabaseRecovery).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        operation: "auth.get_session",
        correlationId: "corr-test",
        maxAttempts: 2,
      }),
    );
  });

  it("rejects an invalid or absent session without an outage error", async () => {
    mocks.getSession.mockResolvedValue(null);

    await expect(getSession()).resolves.toBeNull();
    await expect(requireAuthenticatedUser()).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it("keeps a valid session signed in when a temporary outage recovers", async () => {
    const verified = sessionWith({});
    mocks.getSession
      .mockRejectedValueOnce(opaqueOutageError)
      .mockResolvedValueOnce(verified);
    retryOnceRecovery();

    await expect(getSession()).resolves.toEqual(verified);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    // A temporary outage must never delete the DB row or call sign-out.
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it("surfaces SESSION_UNAVAILABLE for a persistent outage without deleting sessions", async () => {
    mocks.getSession.mockRejectedValue(opaqueOutageError);
    retryOnceRecovery();

    await expect(getSession()).rejects.toBeInstanceOf(SessionUnavailableError);
    expect(mocks.getSession).toHaveBeenCalledTimes(2);
    expect(mocks.deleteSession).not.toHaveBeenCalled();
  });

  it("lets Next.js control-flow errors bypass the outage mapping", async () => {
    const controlError = Object.assign(new Error("dynamic usage"), {
      name: "NextControlFlowError",
    });
    mocks.getSession.mockRejectedValue(controlError);

    await expect(getSession()).rejects.toThrow(controlError);
    await expect(getSession()).rejects.not.toBeInstanceOf(SessionUnavailableError);
  });

  it("preserves admin authorization and approval enforcement", async () => {
    mocks.getSession.mockResolvedValue(sessionWith({ role: "admin" }));
    await expect(requireAdmin()).resolves.toMatchObject({ user: { id: "u-1" } });

    mocks.getSession.mockResolvedValue(sessionWith({ approvalStatus: "pending" }));
    await expect(requireApprovedUser()).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(requireApprovedUser()).rejects.toMatchObject({ code: "pending" });
  });
});
