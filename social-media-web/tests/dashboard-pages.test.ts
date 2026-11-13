import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Overview ("/", the default post-login destination) and Calendar pages are
// reachable by every approved account, not just the Super Admin. They must use
// the approval gate; calling requireAdmin() here throws for regular users and
// surfaces as an unhandled server-render error (Next's built-in 500 page).
const requireApprovedUserMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("requireAdmin must not be called by shared dashboard pages");
  }),
);
const scheduledPostStatusMock = vi.hoisted(() => vi.fn());
// The Overview also reads display-only token metadata (account name, expiry)
// to show connected accounts. It must stay stubbed so the test never touches
// the real token store.
const loadTokenMetadataMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/session", () => ({
  requireApprovedUser: requireApprovedUserMock,
  requireAdmin: requireAdminMock,
}));

vi.mock("@/lib/backend", () => ({
  scheduledPostStatus: scheduledPostStatusMock,
  loadTokenMetadata: loadTokenMetadataMock,
}));

import OverviewPage from "@/app/(dashboard)/page";
import CalendarPage from "@/app/(dashboard)/calendar/page";

const regularUserSession = {
  session: { id: "sess-1", token: "tok" },
  user: { id: "regular-user", name: "Regular", email: "regular@example.com", role: "user" },
} as never;

beforeEach(() => {
  requireApprovedUserMock.mockReset();
  requireAdminMock.mockClear();
  scheduledPostStatusMock.mockReset();
  scheduledPostStatusMock.mockResolvedValue([]);
  loadTokenMetadataMock.mockReset();
  loadTokenMetadataMock.mockResolvedValue([]);
});

describe("dashboard pages reachable by approved non-admin users", () => {
  it("renders Overview for an approved regular user", async () => {
    requireApprovedUserMock.mockResolvedValue(regularUserSession);

    const element = await OverviewPage();

    expect(element).toBeTruthy();
    expect(requireApprovedUserMock).toHaveBeenCalledTimes(1);
    expect(requireAdminMock).not.toHaveBeenCalled();
    expect(scheduledPostStatusMock).toHaveBeenCalledWith("regular-user");
  });

  it("renders Calendar for an approved regular user", async () => {
    requireApprovedUserMock.mockResolvedValue(regularUserSession);

    const element = await CalendarPage();

    expect(element).toBeTruthy();
    expect(requireApprovedUserMock).toHaveBeenCalledTimes(1);
    expect(requireAdminMock).not.toHaveBeenCalled();
    expect(scheduledPostStatusMock).toHaveBeenCalledWith("regular-user");
  });

  it("no longer imports requireAdmin in either page", () => {
    for (const file of ["src/app/(dashboard)/page.tsx", "src/app/(dashboard)/calendar/page.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\brequireAdmin\b/);
      expect(source).toMatch(/\brequireApprovedUser\b/);
    }
  });
});
