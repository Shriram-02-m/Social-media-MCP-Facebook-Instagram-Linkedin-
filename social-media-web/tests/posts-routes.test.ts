import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Queue previously hid `held` posts and the cancel route rejected them,
// even though the scheduler's cancel/reschedule rules accept `scheduled` and
// `held`. These tests pin the aligned behaviour at the route and UI level.

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ApiError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireApiSession: vi.fn(),
    scheduledPostStatus: vi.fn(),
    cancelScheduledPost: vi.fn(),
    // Mirror the real scheduler helpers so the route test checks the exact
    // status set without touching the built MCP package.
    canCancelScheduledPost: (status: string) =>
      status === "scheduled" || status === "held",
    UnauthorizedError,
    ApiError,
  };
});

vi.mock("@/lib/session", () => ({
  UnauthorizedError: mocks.UnauthorizedError,
}));

vi.mock("@/lib/api", () => ({
  ApiError: mocks.ApiError,
  requireApiSession: mocks.requireApiSession,
  apiErrorResponse: (error: unknown) => {
    if (error instanceof mocks.ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof mocks.UnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    return Response.json({ error: "Unexpected error." }, { status: 500 });
  },
}));

vi.mock("@/lib/backend", () => ({
  scheduledPostStatus: mocks.scheduledPostStatus,
  cancelScheduledPost: mocks.cancelScheduledPost,
  canCancelScheduledPost: mocks.canCancelScheduledPost,
}));

import { POST as cancelPOST } from "@/app/api/posts/[id]/cancel/route";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const session = { user: { id: "user-1" } };

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  mocks.requireApiSession.mockReset();
  mocks.scheduledPostStatus.mockReset();
  mocks.cancelScheduledPost.mockReset();
});

describe("POST /api/posts/[id]/cancel", () => {
  it("requires an approved session", async () => {
    mocks.requireApiSession.mockRejectedValue(
      new mocks.UnauthorizedError("Authentication required."),
    );

    const response = await cancelPOST(new Request("http://localhost"), params("post-1"));

    expect(response.status).toBe(401);
    expect(mocks.cancelScheduledPost).not.toHaveBeenCalled();
  });

  it("returns 404 for a post the user does not own", async () => {
    mocks.requireApiSession.mockResolvedValue(session);
    mocks.scheduledPostStatus.mockResolvedValue([]);

    const response = await cancelPOST(new Request("http://localhost"), params("post-1"));

    expect(response.status).toBe(404);
    expect(mocks.cancelScheduledPost).not.toHaveBeenCalled();
  });

  it("cancels a held post as well as a scheduled one", async () => {
    mocks.requireApiSession.mockResolvedValue(session);

    for (const status of ["scheduled", "held"] as const) {
      mocks.scheduledPostStatus.mockResolvedValue([
        { id: "post-1", status, platform: "facebook" },
      ]);
      mocks.cancelScheduledPost.mockResolvedValue({ id: "post-1", status: "cancelled" });

      const response = await cancelPOST(new Request("http://localhost"), params("post-1"));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        cancelled: { id: "post-1", status: "cancelled" },
      });
    }

    expect(mocks.cancelScheduledPost).toHaveBeenCalledTimes(2);
    expect(mocks.cancelScheduledPost).toHaveBeenCalledWith("user-1", "post-1");
  });

  it("rejects posts that are already publishing or finished", async () => {
    mocks.requireApiSession.mockResolvedValue(session);

    for (const status of ["publishing", "published", "failed", "cancelled"] as const) {
      mocks.scheduledPostStatus.mockResolvedValue([
        { id: "post-1", status, platform: "facebook" },
      ]);

      const response = await cancelPOST(new Request("http://localhost"), params("post-1"));

      expect(response.status).toBe(400);
    }

    expect(mocks.cancelScheduledPost).not.toHaveBeenCalled();
  });
});

describe("Queue and posts list expose held posts", () => {
  const queue = source("src/app/(dashboard)/queue/page.tsx");
  const postsList = source("src/components/posts-list.tsx");

  it("includes held posts in the Queue filter", () => {
    expect(queue).toMatch(/statuses=\{\["scheduled", "publishing", "held"\]\}/);
  });

  it("offers reschedule and cancel for held posts", () => {
    expect(postsList).toMatch(
      /post\.status === "scheduled" \|\| post\.status === "held"/,
    );
    expect(postsList).toMatch(/canCancel\(post\)/);
  });
});
