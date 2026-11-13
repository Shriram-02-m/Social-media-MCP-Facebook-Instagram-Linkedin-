import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// Admin Activity Logs page regression tests. The data layer is verified
// against a live database elsewhere; here the page's own contract is tested
// with mocks: the admin gate, the session-unavailable retry state, structured
// error logging on database failures, empty states, nullable metadata, and the
// pagination/filter wiring.

const requireAdminPageMock = vi.hoisted(() => vi.fn());
const listActivityMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/admin-page", () => ({
  requireAdminPage: requireAdminPageMock,
}));

vi.mock("@/lib/admin-activity", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/admin-activity")
  >();
  return { ...actual, listActivity: listActivityMock };
});

vi.mock("@/lib/db", () => ({ db: {}, pool: {} }));

const { SessionUnavailableError } = vi.hoisted(() => {
  class SessionUnavailableError extends Error {}
  return { SessionUnavailableError };
});
vi.mock("@/lib/session", () => ({ SessionUnavailableError }));

import AdminActivityPage from "@/app/(dashboard)/admin/activity/page";
import { AdminPagination } from "@/components/admin/admin-pagination";
import { DateRangeFilter } from "@/components/admin/date-range-filter";
import { SessionUnavailable } from "@/components/session-unavailable";
import { ActivityFiltersForm } from "@/app/(dashboard)/admin/activity/activity-filters";
import { parseMetadata } from "@/lib/admin-activity";
import { SessionUnavailableError as SessionUnavailableErrorType } from "@/lib/session";
import type { AdminActivityResult } from "@/lib/admin-activity";

function collectText(node: ReactNode, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return out;
  }
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  const element = node as ReactElement;
  if (element.props) {
    collectText((element.props as { children?: ReactNode }).children, out);
  }
  return out;
}

function findElements(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean,
  out: ReactElement[] = [],
): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, out);
    return out;
  }
  const element = node as ReactElement;
  if (!element || typeof element !== "object" || !element.props) return out;
  if (predicate(element)) out.push(element);
  findElements((element.props as { children?: ReactNode }).children, predicate, out);
  return out;
}

const baseResult: AdminActivityResult = {
  entries: [
    {
      id: "evt-1",
      action: "user_approved",
      resourceType: "user",
      resourceId: "u-2",
      actorUserId: "admin-1",
      actorName: "Ram",
      actorEmail: "admin@example.com",
      targetUserId: "u-2",
      targetName: "Ramesh",
      targetEmail: "ramesh@example.com",
      metadata: { role: "user" },
      createdAt: "2026-11-12T14:16:04.148Z",
    },
  ],
  total: 37,
  page: 1,
  pageSize: 25,
  actions: ["user_approved", "user_login"],
  range: {
    fromIso: "2026-10-15T00:00:00.000Z",
    toIso: "2026-11-13T00:00:00.000Z",
    days: 30,
  },
};

beforeEach(() => {
  requireAdminPageMock.mockReset();
  requireAdminPageMock.mockResolvedValue(undefined);
  listActivityMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin activity page", () => {
  it("loads and renders the audit trail for an admin", async () => {
    listActivityMock.mockResolvedValue(baseResult);

    const element = await AdminActivityPage({ searchParams: Promise.resolve({}) });
    const text = collectText(element).join(" ").replace(/\s+/g, " ");

    expect(text).toContain("Activity logs");
    expect(text).toContain("Audit trail");
    expect(text).toContain("37 event(s) in this range. Showing page 1");
    expect(text).toContain("user_approved");
    expect(text).toContain("Ram");
    expect(text).toContain("Ramesh");

    expect(requireAdminPageMock).toHaveBeenCalledTimes(1);
    expect(listActivityMock).toHaveBeenCalledTimes(1);
    const filters = listActivityMock.mock.calls[0]![0] as {
      page: number;
      pageSize: number;
      query: string;
    };
    expect(filters.page).toBe(1);
    expect(filters.pageSize).toBe(25);
    expect(filters.query).toBe("");
  });

  it("wires filters and pagination through to the shared components", async () => {
    listActivityMock.mockResolvedValue(baseResult);

    const element = await AdminActivityPage({
      searchParams: Promise.resolve({ page: "2", pageSize: "100", q: "user" }),
    });

    const filters = listActivityMock.mock.calls[0]![0] as {
      page: number;
      pageSize: number;
      query: string;
      offset: number;
    };
    expect(filters.page).toBe(2);
    expect(filters.pageSize).toBe(100);
    expect(filters.offset).toBe(100);
    expect(filters.query).toBe("user");

    const pagination = findElements(
      element,
      (candidate) => candidate.type === AdminPagination,
    );
    expect(pagination).toHaveLength(1);
    // The mocked result carries its own page/pageSize; the page must forward
    // the resolved values, not the raw query parameters.
    expect(pagination[0]!.props).toMatchObject({ page: 1, pageSize: 25, total: 37 });

    const rangeFilter = findElements(
      element,
      (candidate) => candidate.type === DateRangeFilter,
    );
    expect(rangeFilter).toHaveLength(1);
    // The page forwards the parsed range (from/to clamped to now), not the
    // fixture values, so assert against the filters it passed to listActivity.
    const passedFilters = listActivityMock.mock.calls[0]![0] as {
      range: { fromIso: string; toIso: string };
    };
    expect(rangeFilter[0]!.props).toMatchObject({
      fromIso: passedFilters.range.fromIso,
      toIso: passedFilters.range.toIso,
      defaultDays: 30,
    });

    const filterForm = findElements(
      element,
      (candidate) => candidate.type === ActivityFiltersForm,
    );
    expect(filterForm).toHaveLength(1);
    expect(filterForm[0]!.props).toMatchObject({
      initialQuery: "user",
      actions: ["user_approved", "user_login"],
    });
  });

  it("shows the empty state when no activity matches", async () => {
    listActivityMock.mockResolvedValue({
      ...baseResult,
      entries: [],
      total: 0,
    });

    const element = await AdminActivityPage({ searchParams: Promise.resolve({}) });
    const text = collectText(element).join(" ").replace(/\s+/g, " ");

    expect(text).toContain("No activity matches these filters.");
    expect(text).toContain("0 event(s) in this range");
    expect(text).not.toContain("user_approved");
  });

  it("renders entries with null, empty, and malformed metadata without crashing", async () => {
    expect(parseMetadata(null)).toEqual({});
    expect(parseMetadata(undefined)).toEqual({});
    expect(parseMetadata({ role: "user" })).toEqual({ role: "user" });
    expect(parseMetadata('{"role":"user"}')).toEqual({ role: "user" });
    expect(parseMetadata("not-json")).toBe("not-json");
    expect(parseMetadata("")).toBe("");
    expect(parseMetadata(7)).toBe(7);

    listActivityMock.mockResolvedValue({
      ...baseResult,
      entries: [
        { ...baseResult.entries[0]!, metadata: null, id: "evt-null" },
        { ...baseResult.entries[0]!, metadata: "broken json {", id: "evt-broken" },
        { ...baseResult.entries[0]!, metadata: { ok: true }, id: "evt-ok" },
      ],
    });

    const element = await AdminActivityPage({ searchParams: Promise.resolve({}) });
    const text = collectText(element).join(" ").replace(/\s+/g, " ");

    expect(text).toContain("user_approved");
    expect(text).toContain('{"ok":true}');
  });

  it("renders the retry state when the admin session is unavailable", async () => {
    requireAdminPageMock.mockRejectedValue(new SessionUnavailableErrorType());

    const element = await AdminActivityPage({ searchParams: Promise.resolve({}) });

    const retry = findElements(
      element,
      (candidate) => candidate.type === SessionUnavailable,
    );
    expect(retry).toHaveLength(1);
    expect(listActivityMock).not.toHaveBeenCalled();
  });

  it("propagates authorization redirects instead of swallowing them", async () => {
    requireAdminPageMock.mockRejectedValue(new Error("NEXT_REDIRECT"));

    await expect(
      AdminActivityPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(listActivityMock).not.toHaveBeenCalled();
  });

  it("logs structured context (without secrets) when the database fails, then rethrows", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = Object.assign(
      new Error('relation "activity_log" does not exist'),
      { code: "42P01" },
    );
    listActivityMock.mockRejectedValue(failure);

    await expect(
      AdminActivityPage({
        searchParams: Promise.resolve({ q: "user", page: "2" }),
      }),
    ).rejects.toThrow("does not exist");

    expect(consoleError).toHaveBeenCalledTimes(1);
    const logged = String(consoleError.mock.calls[0]![0]);
    const payload = JSON.parse(logged) as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "admin_activity_load_failed",
      page: 2,
      pageSize: 25,
      hasQuery: true,
      errorName: "Error",
      errorMessage: 'relation "activity_log" does not exist',
      errorCode: "42P01",
    });
    // Never leaks connection strings or secret material into the response path.
    expect(logged).not.toMatch(/postgres:\/\//);
    expect(logged).not.toMatch(/BETTER_AUTH|SERVICE_ROLE|ENCRYPTION_KEY|DATABASE_URL/);
  });
});
