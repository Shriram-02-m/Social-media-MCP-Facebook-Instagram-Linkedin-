import { asc, inArray } from "drizzle-orm";

import {
  ADMIN_POST_STATUSES,
  type AdminPlatform,
  type AdminPostStatus,
  type PostFilters,
} from "@/lib/admin-policy";
import { ApiError } from "@/lib/api";
import {
  holdScheduledPostForUser,
  resumeScheduledPostsForUser,
} from "@/lib/backend";
import { db, pool } from "@/lib/db";
import { user } from "@/lib/db/schema";

export interface AdminScheduledPost {
  id: string;
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  platform: AdminPlatform;
  scheduledAt: string;
  status: AdminPostStatus;
  /** Short, single-purpose preview for the table. */
  textPreview: string;
  /** Full post text, used by the admin details dialog. */
  text: string;
  mediaType: string | null;
  createdAt: string;
  publishedAt: string | null;
  publishedUrl: string | null;
  error: string | null;
  retryCount: number;
  failureStage: string | null;
}

export interface AdminSchedulerResult {
  posts: AdminScheduledPost[];
  counts: Record<AdminPostStatus, number>;
  total: number;
  page: number;
  pageSize: number;
  range: { fromIso: string; toIso: string; days: number };
}

interface PostRow {
  id: string;
  user_id: string;
  platform: AdminPlatform;
  scheduled_at: Date;
  text: string;
  status: AdminPostStatus;
  media_type: string | null;
  created_at: Date;
  published_at: Date | null;
  result: { url?: string } | null;
  error: string | null;
  retry_count: number;
  failure_stage: string | null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function emptyCounts(): Record<AdminPostStatus, number> {
  return {
    scheduled: 0,
    publishing: 0,
    published: 0,
    failed: 0,
    cancelled: 0,
    held: 0,
  };
}

export async function listScheduledPosts(
  filters: PostFilters,
): Promise<AdminSchedulerResult> {
  // No scheduler tables (stdio-only install): return an empty, well-formed page
  // rather than breaking the admin navigation.
  try {
    const queryPattern = filters.query ? `%${escapeLike(filters.query)}%` : null;
    const status = filters.status === "all" ? null : filters.status;
    const platform = filters.platform === "all" ? null : filters.platform;

    const countsResult = await pool.query<{ status: AdminPostStatus; total: string }>(
      `SELECT post.status, COUNT(*)::text AS total
         FROM public.scheduled_posts AS post
         LEFT JOIN "user" AS owner ON owner.id = post.user_id
        WHERE post.scheduled_at >= $1 AND post.scheduled_at <= $2
          AND ($3::text IS NULL OR post.platform = $3)
          AND ($4::text IS NULL OR post.text ILIKE $4 OR owner.name ILIKE $4 OR owner.email ILIKE $4)
        GROUP BY post.status`,
      [filters.range.from, filters.range.to, platform, queryPattern],
    );

    const counts = emptyCounts();
    for (const row of countsResult.rows) {
      if (row.status in counts) counts[row.status] = Number(row.total);
    }

    const total = status === null
      ? Object.values(counts).reduce((sum, value) => sum + value, 0)
      : counts[status];

    const { rows } = await pool.query<PostRow>(
      `SELECT post.id, post.user_id, post.platform, post.scheduled_at, post.text,
              post.status, post.media_type, post.created_at, post.published_at,
              post.result, post.error, post.retry_count, post.failure_stage
         FROM public.scheduled_posts AS post
         LEFT JOIN "user" AS owner ON owner.id = post.user_id
        WHERE post.scheduled_at >= $1 AND post.scheduled_at <= $2
          AND ($3::text IS NULL OR post.status = $3)
          AND ($4::text IS NULL OR post.platform = $4)
          AND ($5::text IS NULL OR post.text ILIKE $5 OR owner.name ILIKE $5 OR owner.email ILIKE $5)
        ORDER BY post.scheduled_at DESC, post.created_at DESC
        LIMIT $6 OFFSET $7`,
      [
        filters.range.from,
        filters.range.to,
        status,
        platform,
        queryPattern,
        filters.pageSize,
        filters.offset,
      ],
    );

    const ownerIds = [...new Set(rows.map((row) => row.user_id))];
    const owners = ownerIds.length
      ? await db
        .select({ id: user.id, name: user.name, email: user.email })
        .from(user)
        .where(inArray(user.id, ownerIds))
        .orderBy(asc(user.email))
      : [];
    const ownersById = new Map(owners.map((owner) => [owner.id, owner]));

    return {
      posts: rows.map((row) => {
        const owner = ownersById.get(row.user_id);
        return {
          id: row.id,
          ownerId: row.user_id,
          ownerName: owner?.name ?? "Unknown user",
          ownerEmail: owner?.email ?? row.user_id,
          platform: row.platform,
          scheduledAt: row.scheduled_at.toISOString(),
          status: row.status,
          textPreview: row.text.length > 140 ? `${row.text.slice(0, 140)}…` : row.text,
          text: row.text,
          mediaType: row.media_type,
          createdAt: row.created_at.toISOString(),
          publishedAt: row.published_at ? row.published_at.toISOString() : null,
          publishedUrl: typeof row.result?.url === "string" ? row.result.url : null,
          error: row.error,
          retryCount: row.retry_count,
          failureStage: row.failure_stage,
        };
      }),
      counts,
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      range: {
        fromIso: filters.range.fromIso,
        toIso: filters.range.toIso,
        days: filters.range.days,
      },
    };
  } catch {
    return {
      posts: [],
      counts: emptyCounts(),
      total: 0,
      page: filters.page,
      pageSize: filters.pageSize,
      range: {
        fromIso: filters.range.fromIso,
        toIso: filters.range.toIso,
        days: filters.range.days,
      },
    };
  }
}

export interface AdminUserPost {
  id: string;
  platform: AdminPlatform;
  status: AdminPostStatus;
  scheduledAt: string;
  publishedAt: string | null;
  error: string | null;
  retryCount: number;
  textPreview: string;
  /** Full post text, used by the admin details dialog. */
  text: string;
  mediaType: string | null;
  failureStage: string | null;
  publishedUrl: string | null;
  createdAt: string;
}

/** Recent posts for one owner, used by the admin user detail page. */
export async function listUserScheduledPosts(
  userId: string,
  limit = 20,
): Promise<AdminUserPost[]> {
  try {
    const { rows } = await pool.query<{
      id: string;
      platform: AdminPlatform;
      status: AdminPostStatus;
      scheduled_at: Date;
      published_at: Date | null;
      error: string | null;
      retry_count: number;
      text: string;
      media_type: string | null;
      failure_stage: string | null;
      result: { url?: string } | null;
      created_at: Date;
    }>(
      `SELECT id, platform, status, scheduled_at, published_at, error,
              retry_count, text, media_type, failure_stage, result, created_at
         FROM public.scheduled_posts
        WHERE user_id = $1
        ORDER BY scheduled_at DESC
        LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      status: row.status,
      scheduledAt: row.scheduled_at.toISOString(),
      publishedAt: row.published_at ? row.published_at.toISOString() : null,
      error: row.error,
      retryCount: row.retry_count,
      textPreview: row.text.length > 100 ? `${row.text.slice(0, 100)}…` : row.text,
      text: row.text,
      mediaType: row.media_type,
      failureStage: row.failure_stage,
      publishedUrl: typeof row.result?.url === "string" ? row.result.url : null,
      createdAt: row.created_at.toISOString(),
    }));
  } catch {
    return [];
  }
}

async function postOwner(postId: string): Promise<{ ownerId: string; status: AdminPostStatus }> {
  try {
    const { rows } = await pool.query<{ user_id: string; status: AdminPostStatus }>(
      "SELECT user_id, status FROM public.scheduled_posts WHERE id = $1",
      [postId],
    );
    if (!rows[0]) throw new ApiError("Scheduled post not found.", 404);
    return { ownerId: rows[0].user_id, status: rows[0].status };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("The scheduler store is unavailable.", 503);
  }
}

/** Admin-only hold: atomic `scheduled -> held`, never touches publishing rows. */
export async function adminHoldPost(
  actorId: string,
  postId: string,
): Promise<{ id: string; status: "held" }> {
  const { ownerId, status } = await postOwner(postId);
  if (!(ADMIN_POST_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError("This post has an unknown status.", 409);
  }
  if (status !== "scheduled") {
    throw new ApiError(`Only scheduled posts can be held; this post is ${status}.`, 409);
  }
  try {
    const held = await holdScheduledPostForUser(ownerId, postId, {
      actorUserId: actorId,
      reason: "Held by the administrator before publishing.",
    });
    return { id: held.id, status: "held" };
  } catch (error) {
    throw new ApiError(
      error instanceof Error ? error.message : "Could not hold the scheduled post.",
      409,
    );
  }
}

/**
 * Admin-only resume. Future scheduled posts return to the queue; overdue held
 * posts stay held until an explicit reschedule, so a resume never triggers an
 * immediate duplicate/backlog publish.
 */
export async function adminResumePost(
  actorId: string,
  postId: string,
): Promise<{ id: string; status: "scheduled" | "held"; message: string }> {
  const { ownerId, status } = await postOwner(postId);
  if (status !== "held") {
    throw new ApiError(`Only held posts can be resumed; this post is ${status}.`, 409);
  }
  try {
    const result = await resumeScheduledPostsForUser(ownerId, postId, { actorUserId: actorId });
    if (result.resumed.length) {
      return {
        id: result.resumed[0]!.id,
        status: "scheduled",
        message: "Post resumed at its original scheduled time.",
      };
    }
    if (result.stillHeld.length) {
      return {
        id: result.stillHeld[0]!.id,
        status: "held",
        message:
          "The original schedule time has passed. The post stays held; reschedule it explicitly to publish.",
      };
    }
    throw new ApiError("The post could not be resumed.", 409);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      error instanceof Error ? error.message : "Could not resume the scheduled post.",
      409,
    );
  }
}
