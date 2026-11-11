import { and, count, gte, isNull, lte } from "drizzle-orm";

import type { DateRange } from "@/lib/admin-policy";
import { loadTokenMetadata } from "@/lib/backend";
import { db, pool } from "@/lib/db";
import { user } from "@/lib/db/schema";

export interface OverviewRange {
  fromIso: string;
  toIso: string;
  days: number;
}

export interface UserOverview {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  suspended: number;
  deleted: number;
  newInRange: number;
}

export interface SocialAccountOverview {
  connected: number;
  expired: number;
}

export interface PostStatusCounts {
  scheduled: number;
  publishing: number;
  published: number;
  failed: number;
  cancelled: number;
  held: number;
}

export interface PostOverview extends PostStatusCounts {
  inRange: PostStatusCounts;
}

export interface OverviewSeriesPoint {
  date: string;
  users: number;
  scheduled: number;
  published: number;
  failed: number;
}

export interface AdminOverview {
  range: OverviewRange;
  users: UserOverview;
  socialAccounts: SocialAccountOverview;
  posts: PostOverview;
  series: OverviewSeriesPoint[];
}

function emptyPostCounts(): PostStatusCounts {
  return {
    scheduled: 0,
    publishing: 0,
    published: 0,
    failed: 0,
    cancelled: 0,
    held: 0,
  };
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function buildBuckets(range: DateRange): Map<string, OverviewSeriesPoint> {
  const buckets = new Map<string, OverviewSeriesPoint>();
  const cursor = new Date(range.from);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= range.to.getTime()) {
    const key = dateKey(cursor);
    buckets.set(key, { date: key, users: 0, scheduled: 0, published: 0, failed: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return buckets;
}

async function userOverview(range: DateRange): Promise<UserOverview> {
  const rows = await db
    .select({
      approvalStatus: user.approvalStatus,
      banned: user.banned,
      deletedAt: user.deletedAt,
      total: count(),
    })
    .from(user)
    .groupBy(user.approvalStatus, user.banned, user.deletedAt);

  const summary: UserOverview = {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    suspended: 0,
    deleted: 0,
    newInRange: 0,
  };

  for (const row of rows) {
    const total = Number(row.total);
    summary.total += total;
    if (row.deletedAt) {
      summary.deleted += total;
      continue;
    }
    if (row.banned) {
      summary.suspended += total;
      continue;
    }
    if (row.approvalStatus === "approved") summary.approved += total;
    else if (row.approvalStatus === "rejected") summary.rejected += total;
    else summary.pending += total;
  }

  const [newUsers] = await db
    .select({ total: count() })
    .from(user)
    .where(and(gte(user.createdAt, range.from), lte(user.createdAt, range.to)));
  summary.newInRange = Number(newUsers?.total ?? 0);

  return summary;
}

async function postOverview(range: DateRange): Promise<PostOverview> {
  const overview: PostOverview = { ...emptyPostCounts(), inRange: emptyPostCounts() };
  try {
    const { rows } = await pool.query<{
      status: keyof PostStatusCounts;
      total: string;
      in_range: string;
    }>(
      `SELECT status,
              COUNT(*)::text AS total,
              COUNT(*) FILTER (
                WHERE (status = 'published' AND published_at >= $1 AND published_at <= $2)
                   OR (status <> 'published' AND created_at >= $1 AND created_at <= $2)
              )::text AS in_range
         FROM public.scheduled_posts
        GROUP BY status`,
      [range.from, range.to],
    );
    for (const row of rows) {
      if (!(row.status in overview)) continue;
      overview[row.status] = Number(row.total);
      overview.inRange[row.status] = Number(row.in_range);
    }
  } catch {
    // A database without the scheduler tables (stdio-only install) reports
    // zeros instead of failing the whole admin dashboard.
  }
  return overview;
}

async function socialAccountOverview(): Promise<SocialAccountOverview> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(isNull(user.deletedAt));

  const result: SocialAccountOverview = { connected: 0, expired: 0 };
  const settled = await Promise.allSettled(rows.map((row) => loadTokenMetadata(row.id)));
  for (const item of settled) {
    if (item.status !== "fulfilled") continue;
    result.connected += item.value.length;
    result.expired += item.value.filter((token) => token.expired).length;
  }
  return result;
}

async function overviewSeries(range: DateRange): Promise<OverviewSeriesPoint[]> {
  const buckets = buildBuckets(range);

  const userRows = await db
    .select({ createdAt: user.createdAt })
    .from(user)
    .where(and(gte(user.createdAt, range.from), lte(user.createdAt, range.to)));
  for (const row of userRows) {
    const bucket = buckets.get(dateKey(row.createdAt));
    if (bucket) bucket.users += 1;
  }

  try {
    const { rows } = await pool.query<{
      status: string;
      created_at: Date;
      published_at: Date | null;
    }>(
      `SELECT status, created_at, published_at
         FROM public.scheduled_posts
        WHERE (created_at >= $1 AND created_at <= $2)
           OR (published_at >= $1 AND published_at <= $2)`,
      [range.from, range.to],
    );
    for (const row of rows) {
      const createdKey = dateKey(row.created_at);
      const createdBucket = buckets.get(createdKey);
      if (createdBucket && row.status === "scheduled") createdBucket.scheduled += 1;
      if (createdBucket && row.status === "failed") createdBucket.failed += 1;
      if (row.published_at) {
        const publishedBucket = buckets.get(dateKey(row.published_at));
        if (publishedBucket && row.status === "published") publishedBucket.published += 1;
      }
    }
  } catch {
    // Scheduler tables are optional for the admin overview.
  }

  return [...buckets.values()];
}

export async function getAdminOverview(range: DateRange): Promise<AdminOverview> {
  const [users, posts, socialAccounts, series] = await Promise.all([
    userOverview(range),
    postOverview(range),
    socialAccountOverview(),
    overviewSeries(range),
  ]);

  return {
    range: { fromIso: range.fromIso, toIso: range.toIso, days: range.days },
    users,
    socialAccounts,
    posts,
    series,
  };
}
