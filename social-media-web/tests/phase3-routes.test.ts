import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ApprovalRequiredError extends Error {
    code = "rejected";
  }
  class ApiError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireAdmin: vi.fn(),
    getAdminUserStats: vi.fn(),
    listSocialAccounts: vi.fn(),
    listScheduledPosts: vi.fn(),
    adminHoldPost: vi.fn(),
    adminResumePost: vi.fn(),
    performAccountAction: vi.fn(),
    UnauthorizedError,
    ApprovalRequiredError,
    ApiError,
  };
});

vi.mock("@/lib/session", () => ({
  requireAdmin: mocks.requireAdmin,
  UnauthorizedError: mocks.UnauthorizedError,
  ApprovalRequiredError: mocks.ApprovalRequiredError,
}));

vi.mock("@/lib/api", () => ({
  ApiError: mocks.ApiError,
  apiErrorResponse: (error: unknown) => {
    if (error instanceof mocks.ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof mocks.UnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof mocks.ApprovalRequiredError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    return Response.json({ error: "Unexpected error." }, { status: 500 });
  },
}));

vi.mock("@/lib/admin-overview", () => ({
  getAdminUserStats: mocks.getAdminUserStats,
}));
vi.mock("@/lib/admin-social-accounts", () => ({
  listSocialAccounts: mocks.listSocialAccounts,
}));
vi.mock("@/lib/admin-scheduler", () => ({
  listScheduledPosts: mocks.listScheduledPosts,
  adminHoldPost: mocks.adminHoldPost,
  adminResumePost: mocks.adminResumePost,
}));
vi.mock("@/lib/admin-accounts", () => ({
  performAccountAction: mocks.performAccountAction,
}));

import { GET as overviewGET } from "@/app/api/admin/overview/route";
import { GET as schedulerGET } from "@/app/api/admin/scheduler/route";
import { POST as holdPOST } from "@/app/api/admin/scheduler/[id]/hold/route";
import { POST as resumePOST } from "@/app/api/admin/scheduler/[id]/resume/route";
import { GET as socialGET } from "@/app/api/admin/social-accounts/route";
import { POST as accountPOST } from "@/app/api/admin/users/[id]/account/route";
import { DELETE as sessionsDELETE } from "@/app/api/admin/users/[id]/sessions/route";

const adminSession = {
  session: { id: "sess-admin", token: "tok" },
  user: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin" },
};

function url(pathname: string): Request {
  return new Request(`http://localhost${pathname}`);
}

beforeEach(() => {
  mocks.requireAdmin.mockReset();
  mocks.getAdminUserStats.mockReset();
  mocks.listSocialAccounts.mockReset();
  mocks.listScheduledPosts.mockReset();
  mocks.adminHoldPost.mockReset();
  mocks.adminResumePost.mockReset();
  mocks.performAccountAction.mockReset();
});

describe("admin API authorization", () => {
  it("returns 401 when there is no session", async () => {
    mocks.requireAdmin.mockRejectedValue(new mocks.UnauthorizedError("Authentication required."));
    const response = await overviewGET();
    expect(response.status).toBe(401);
  });

  it("returns 403 for a signed-in regular user", async () => {
    mocks.requireAdmin.mockRejectedValue(
      new mocks.ApprovalRequiredError("Admin access required."),
    );
    for (const response of [
      await overviewGET(),
      await socialGET(url("/api/admin/social-accounts")),
      await schedulerGET(url("/api/admin/scheduler")),
    ]) {
      expect(response.status).toBe(403);
    }
  });

  it("serves data to the Super Admin", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.getAdminUserStats.mockResolvedValue({
      total: 4,
      pending: 1,
      active: 2,
      inactive: 1,
    });
    const response = await overviewGET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      total: 4,
      pending: 1,
      active: 2,
      inactive: 1,
    });
    expect(mocks.getAdminUserStats).toHaveBeenCalledOnce();
  });

  it("checks the admin guard before doing any data work", async () => {
    mocks.requireAdmin.mockRejectedValue(new mocks.UnauthorizedError("Authentication required."));
    await schedulerGET(url("/api/admin/scheduler"));
    expect(mocks.listScheduledPosts).not.toHaveBeenCalled();

    await socialGET(url("/api/admin/social-accounts"));
    expect(mocks.listSocialAccounts).not.toHaveBeenCalled();
  });
});

describe("scheduler hold/resume APIs", () => {
  it("passes the verified admin id and post id to the hold helper", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.adminHoldPost.mockResolvedValue({ id: "post-1", status: "held" });
    const response = await holdPOST(url("/api/admin/scheduler/post-1/hold"), {
      params: Promise.resolve({ id: "post-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.adminHoldPost).toHaveBeenCalledWith("admin-1", "post-1");
  });

  it("resumes only through the resume helper", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.adminResumePost.mockResolvedValue({
      id: "post-1",
      status: "held",
      message: "still held",
    });
    const response = await resumePOST(url("/api/admin/scheduler/post-1/resume"), {
      params: Promise.resolve({ id: "post-1" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.adminResumePost).toHaveBeenCalledWith("admin-1", "post-1");
  });

  it("rejects an empty post id", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    const response = await holdPOST(url("/api/admin/scheduler/empty/hold"), {
      params: Promise.resolve({ id: "   " }),
    });
    expect(response.status).toBe(400);
    expect(mocks.adminHoldPost).not.toHaveBeenCalled();
  });
});

describe("account control APIs", () => {
  it("uses the session actor id, not client-supplied data", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.performAccountAction.mockResolvedValue({
      id: "user-2",
      action: "suspend",
      banned: true,
      deletedAt: null,
      sessionsRevoked: 2,
      postsHeld: 3,
      postsResumed: 0,
      postsStillHeld: 0,
    });
    const response = await accountPOST(
      new Request("http://localhost/api/admin/users/user-2/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "suspend", actorId: "attacker" }),
      }),
      { params: Promise.resolve({ id: "user-2" }) },
    );
    // Unknown/strict body keys are rejected rather than trusted.
    expect(response.status).toBe(400);
    expect(mocks.performAccountAction).not.toHaveBeenCalled();
  });

  it("performs a valid suspension", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.performAccountAction.mockResolvedValue({
      id: "user-2",
      action: "suspend",
      banned: true,
      deletedAt: null,
      sessionsRevoked: 2,
      postsHeld: 3,
      postsResumed: 0,
      postsStillHeld: 0,
    });
    const response = await accountPOST(
      new Request("http://localhost/api/admin/users/user-2/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "suspend", reason: "abuse report" }),
      }),
      { params: Promise.resolve({ id: "user-2" }) },
    );
    expect(response.status).toBe(200);
    expect(mocks.performAccountAction).toHaveBeenCalledWith(
      "admin-1",
      "user-2",
      "suspend",
      "abuse report",
    );
  });

  it("revokes sessions through the dedicated endpoint", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.performAccountAction.mockResolvedValue({
      id: "user-2",
      action: "revoke_sessions",
      banned: false,
      deletedAt: null,
      sessionsRevoked: 4,
      postsHeld: 0,
      postsResumed: 0,
      postsStillHeld: 0,
    });
    const response = await sessionsDELETE(url("/api/admin/users/user-2/sessions"), {
      params: Promise.resolve({ id: "user-2" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.performAccountAction).toHaveBeenCalledWith(
      "admin-1",
      "user-2",
      "revoke_sessions",
    );
  });

  it("returns the self-lockout violation from the server policy", async () => {
    mocks.requireAdmin.mockResolvedValue(adminSession);
    mocks.performAccountAction.mockRejectedValue(
      new mocks.ApiError("You cannot suspend or delete your own account.", 409),
    );
    const response = await accountPOST(
      new Request("http://localhost/api/admin/users/admin-1/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "suspend" }),
      }),
      { params: Promise.resolve({ id: "admin-1" }) },
    );
    expect(response.status).toBe(409);
  });
});
