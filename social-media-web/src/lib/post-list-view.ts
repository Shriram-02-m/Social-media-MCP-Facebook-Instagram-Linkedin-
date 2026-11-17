export type PostListStatus =
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled"
  | "held";
export type PostListPlatform = "facebook" | "instagram" | "linkedin";
export type PostListSort =
  | "date-newest"
  | "date-oldest"
  | "platform"
  | "status"
  | "text";

interface SearchablePost {
  platform: PostListPlatform;
  status: PostListStatus;
  text: string;
  scheduledAt: string;
  publishedAt?: string;
  error?: string;
  mediaType: string;
}

export function filterAndSortPosts<T extends SearchablePost>(
  posts: T[],
  {
    statuses,
    query,
    status,
    platform,
    sort,
  }: {
    statuses: readonly PostListStatus[];
    query: string;
    status: "all" | PostListStatus;
    platform: "all" | PostListPlatform;
    sort: PostListSort;
  },
): T[] {
  const search = query.trim().toLocaleLowerCase();
  const filtered = posts.filter((post) => {
    const matchesSearch =
      search.length === 0 ||
      [post.text, post.error ?? "", post.platform, post.status, post.mediaType].some(
        (value) => value.toLocaleLowerCase().includes(search),
      );
    return (
      statuses.includes(post.status) &&
      matchesSearch &&
      (status === "all" || post.status === status) &&
      (platform === "all" || post.platform === platform)
    );
  });

  const timestamp = (post: SearchablePost) => {
    const value = Date.parse(post.publishedAt ?? post.scheduledAt);
    return Number.isNaN(value) ? 0 : value;
  };

  return filtered.sort((left, right) => {
    switch (sort) {
      case "date-newest":
        return timestamp(right) - timestamp(left);
      case "date-oldest":
        return timestamp(left) - timestamp(right);
      case "platform":
        return left.platform.localeCompare(right.platform);
      case "status":
        return left.status.localeCompare(right.status);
      case "text":
        return left.text.localeCompare(right.text);
    }
  });
}

export function paginatePosts<T>(
  items: T[],
  requestedPage: number,
  pageSize: number,
): {
  items: T[];
  page: number;
  totalPages: number;
  start: number;
  end: number;
} {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = items.length === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, items.length);

  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    totalPages,
    start,
    end,
  };
}
