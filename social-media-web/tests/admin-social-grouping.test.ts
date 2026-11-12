import { describe, expect, it } from "vitest";

import {
  groupConnectionsByOwner,
  type AdminSocialConnectionRow,
} from "@/lib/admin-social-grouping";

function connection(
  overrides: Partial<AdminSocialConnectionRow> = {},
): AdminSocialConnectionRow {
  return {
    userId: "user-1",
    userName: "Shriram",
    userEmail: "shriram@example.com",
    userStatus: "approved",
    platform: "facebook",
    status: "connected",
    accountName: "Shriram",
    accountId: "fb-1",
    expiresAt: null,
    expired: false,
    scopes: [],
    pageCount: 0,
    connectedAt: null,
    lastSyncAt: null,
    lastError: null,
    lastErrorAt: null,
    ...overrides,
  };
}

describe("groupConnectionsByOwner", () => {
  it("collapses three platforms for one owner into a single row", () => {
    const rows = groupConnectionsByOwner([
      connection({ platform: "linkedin", accountName: "Shriram LI" }),
      connection({ platform: "facebook", accountName: "Shriram FB" }),
      connection({ platform: "instagram", accountName: "IG account" }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe("user-1");
    expect(rows[0].connections.map((row) => row.platform)).toEqual([
      "facebook",
      "instagram",
      "linkedin",
    ]);
  });

  it("keeps distinct owners separate even when names or emails collide", () => {
    const rows = groupConnectionsByOwner([
      connection({ userId: "user-1" }),
      connection({
        userId: "user-2",
        platform: "instagram",
        accountName: "Second account",
      }),
    ]);

    expect(rows.map((row) => row.userId)).toEqual(["user-1", "user-2"]);
    expect(rows[0].connections).toHaveLength(1);
    expect(rows[1].connections).toHaveLength(1);
  });

  it("preserves each platform's metadata without merging values", () => {
    const rows = groupConnectionsByOwner([
      connection({
        platform: "facebook",
        accountName: "FB name",
        status: "connected",
        lastSyncAt: "2026-01-01T10:00:00.000Z",
        expiresAt: "2026-02-01T10:00:00.000Z",
      }),
      connection({
        platform: "instagram",
        accountName: "IG name",
        status: "expired",
        expired: true,
        lastSyncAt: "2026-01-02T10:00:00.000Z",
        lastError: "Token expired",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].connections).toHaveLength(2);
    expect(rows[0].connections[0]).toMatchObject({
      platform: "facebook",
      accountName: "FB name",
      status: "connected",
      expiresAt: "2026-02-01T10:00:00.000Z",
    });
    expect(rows[0].connections[1]).toMatchObject({
      platform: "instagram",
      accountName: "IG name",
      status: "expired",
      expired: true,
      lastError: "Token expired",
    });
  });

  it("preserves owner order and handles empty input", () => {
    const rows = groupConnectionsByOwner([
      connection({ userId: "user-2", userEmail: "b@example.com" }),
      connection({
        userId: "user-1",
        userEmail: "a@example.com",
        platform: "linkedin",
      }),
      connection({
        userId: "user-2",
        userEmail: "b@example.com",
        platform: "instagram",
      }),
    ]);

    expect(rows.map((row) => row.userId)).toEqual(["user-2", "user-1"]);
    expect(rows[1].connections.map((row) => row.platform)).toEqual(["linkedin"]);
    expect(groupConnectionsByOwner([])).toEqual([]);
  });
});
