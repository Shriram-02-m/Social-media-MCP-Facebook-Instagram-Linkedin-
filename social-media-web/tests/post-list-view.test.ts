import { describe, expect, it } from "vitest";

import {
  filterAndSortPosts,
  paginatePosts,
  type PostListPlatform,
  type PostListStatus,
} from "../src/lib/post-list-view";

interface TestPost {
  id: string;
  platform: PostListPlatform;
  status: PostListStatus;
  text: string;
  scheduledAt: string;
  mediaType: string;
  error?: string;
}

const posts: TestPost[] = [
  {
    id: "1",
    platform: "instagram",
    status: "failed",
    text: "Campaign alpha",
    scheduledAt: "2026-03-03T10:00:00.000Z",
    mediaType: "image",
    error: "Token expired",
  },
  {
    id: "2",
    platform: "facebook",
    status: "published",
    text: "Campaign beta",
    scheduledAt: "2026-03-04T10:00:00.000Z",
    mediaType: "none",
  },
  {
    id: "3",
    platform: "linkedin",
    status: "scheduled",
    text: "Campaign gamma",
    scheduledAt: "2026-03-05T10:00:00.000Z",
    mediaType: "document",
  },
];

describe("post list view helpers", () => {
  it("combines status and platform filters with text and error search", () => {
    const result = filterAndSortPosts(posts, {
      statuses: ["failed", "published"],
      query: "expired",
      status: "all",
      platform: "instagram",
      sort: "date-newest",
    });

    expect(result.map((post) => post.id)).toEqual(["1"]);
  });

  it("sorts dates in either direction without mutating the source array", () => {
    const originalIds = posts.map((post) => post.id);
    const options = {
      statuses: ["failed", "published", "scheduled"],
      query: "",
      status: "all",
      platform: "all",
    } as const;

    expect(
      filterAndSortPosts(posts, { ...options, sort: "date-oldest" }).map((post) => post.id),
    ).toEqual(["1", "2", "3"]);
    expect(
      filterAndSortPosts(posts, { ...options, sort: "date-newest" }).map((post) => post.id),
    ).toEqual(["3", "2", "1"]);
    expect(posts.map((post) => post.id)).toEqual(originalIds);
  });

  it("returns bounded pages and clamps a stale page after filtering", () => {
    const first = paginatePosts(posts, 1, 2);
    expect(first).toMatchObject({ page: 1, totalPages: 2, start: 1, end: 2 });
    expect(first.items.map((post) => post.id)).toEqual(["1", "2"]);

    const last = paginatePosts(posts.slice(0, 1), 4, 2);
    expect(last).toMatchObject({ page: 1, totalPages: 1, start: 1, end: 1 });
    expect(last.items.map((post) => post.id)).toEqual(["1"]);
  });
});
