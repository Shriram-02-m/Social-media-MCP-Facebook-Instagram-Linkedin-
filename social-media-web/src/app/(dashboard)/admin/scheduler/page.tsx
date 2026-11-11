import Link from "next/link";
import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Clock3,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";

import { AdminPagination } from "@/components/admin/admin-pagination";
import { DateRangeFilter } from "@/components/admin/date-range-filter";
import { PostStatusBadge } from "@/components/admin/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdminPage } from "@/lib/admin-page";
import {
  parsePostFilters,
  type AdminPlatform,
} from "@/lib/admin-policy";
import { listScheduledPosts } from "@/lib/admin-scheduler";

import { ErrorCell } from "./error-cell";
import { PostActions } from "./post-actions";
import { PostContentCell } from "./post-content-cell";
import { SchedulerFilters } from "./scheduler-filters";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(value: string | null): string {
  if (!value) return "—";
  return dateFormatter.format(new Date(value));
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return timeFormatter.format(new Date(value));
}

const PLATFORM_META: Record<
  AdminPlatform,
  { label: string; short: string; className: string }
> = {
  facebook: {
    label: "Facebook",
    short: "f",
    className:
      "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-900",
  },
  instagram: {
    label: "Instagram",
    short: "ig",
    className:
      "bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-950/50 dark:text-pink-300 dark:ring-pink-900",
  },
  linkedin: {
    label: "LinkedIn",
    short: "in",
    className:
      "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900",
  },
};

function StatCard({
  label,
  value,
  icon: Icon,
  iconClassName,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  iconClassName: string;
}) {
  return (
    <Card size="sm" className="gap-0 py-4">
      <CardContent className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-2xl font-semibold tabular-nums">{value}</span>
        </div>
        <span
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${iconClassName}`}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </CardContent>
    </Card>
  );
}

export default async function AdminSchedulerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminPage();
  const params = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value);
    else if (Array.isArray(value) && value[0]) query.set(key, value[0]);
  }
  const filters = parsePostFilters(query);
  const result = await listScheduledPosts(filters);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">Scheduler</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Manage scheduled posts across all connected social accounts, monitor
          publishing status, and handle failed or held posts.
        </p>
      </header>

      <section
        aria-label="Scheduler statistics"
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard
          label="Scheduled"
          value={result.counts.scheduled}
          icon={Clock3}
          iconClassName="bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300"
        />
        <StatCard
          label="Published"
          value={result.counts.published}
          icon={CheckCircle2}
          iconClassName="bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300"
        />
        <StatCard
          label="Failed"
          value={result.counts.failed}
          icon={CircleAlert}
          iconClassName="bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-300"
        />
        <StatCard
          label="Held"
          value={result.counts.held}
          icon={PauseCircle}
          iconClassName="bg-violet-50 text-violet-600 dark:bg-violet-950/50 dark:text-violet-300"
        />
      </section>

      <Card className="gap-0 py-0">
        <CardHeader className="gap-1 border-b px-4 py-4 lg:px-5">
          <CardTitle>All scheduled posts</CardTitle>
          <CardDescription>
            {result.total} post(s) match the current filters in this date range.
          </CardDescription>
        </CardHeader>

        <div className="flex flex-col gap-4 border-b bg-muted/20 px-4 py-4 lg:px-5">
          <SchedulerFilters
            initialQuery={filters.query}
            initialStatus={filters.status}
            initialPlatform={filters.platform}
          />
          <div className="border-t pt-4">
            <DateRangeFilter
              fromIso={filters.range.fromIso}
              toIso={filters.range.toIso}
              defaultDays={30}
            />
          </div>
        </div>

        <CardContent className="p-0">
          {result.posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <CalendarClock className="size-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">No scheduled posts</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                No posts match the current filters in this date range. Try
                adjusting the search, status, platform, or date range.
              </p>
            </div>
          ) : (
            <Table className="min-w-[1024px] table-fixed">
              <colgroup>
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[29%]" />
                <col className="w-[11%]" />
                <col className="w-[11%]" />
                <col className="w-[6%]" />
                <col className="w-[10%]" />
                <col className="w-[11%]" />
              </colgroup>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Owner
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Platform
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Post content
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Scheduled
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="h-11 px-3 text-center text-xs font-medium text-muted-foreground">
                    Retries
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Error
                  </TableHead>
                  <TableHead className="h-11 px-3 text-right text-xs font-medium text-muted-foreground">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.posts.map((post) => {
                  const platform = PLATFORM_META[post.platform];
                  return (
                    <TableRow key={post.id} className="h-[84px]">
                      <TableCell className="whitespace-normal px-3 py-3 align-top">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Link
                            href={`/users/${post.ownerId}`}
                            className="truncate font-medium hover:underline"
                            title={post.ownerName}
                          >
                            {post.ownerName}
                          </Link>
                          <span
                            className="truncate text-xs text-muted-foreground"
                            title={post.ownerEmail}
                          >
                            {post.ownerEmail}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 align-top">
                        <span className="inline-flex min-w-0 items-center gap-1">
                          <span
                            aria-hidden="true"
                            className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-[8px] font-semibold ring-1 ${platform.className}`}
                          >
                            {platform.short}
                          </span>
                          <span className="truncate text-xs">
                            {platform.label}
                          </span>
                        </span>
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 align-top">
                        <PostContentCell
                          text={post.text}
                          textPreview={post.textPreview}
                          mediaType={post.mediaType}
                        />
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 align-top">
                        <div className="flex flex-col gap-0.5 text-sm">
                          <span className="font-medium tabular-nums">
                            {formatDate(post.scheduledAt)}
                          </span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatTime(post.scheduledAt)} UTC
                          </span>
                          {post.publishedAt ? (
                            <span className="mt-1 text-[11px] text-muted-foreground">
                              Published {formatDate(post.publishedAt)}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 align-top">
                        <PostStatusBadge status={post.status} />
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 text-center align-top">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-sm font-medium tabular-nums">
                            {post.retryCount}
                          </span>
                          {post.failureStage ? (
                            <span
                              className="w-full truncate text-[10px] text-muted-foreground"
                              title={post.failureStage}
                            >
                              {post.failureStage}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 align-top">
                        <ErrorCell
                          error={post.error}
                          failureStage={post.failureStage}
                        />
                      </TableCell>

                      <TableCell className="whitespace-normal px-3 py-3 text-right align-top">
                        <PostActions
                          id={post.id}
                          status={post.status}
                          publishedUrl={post.publishedUrl}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>

        <div className="border-t px-4 py-3 lg:px-5">
          <AdminPagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
          />
        </div>
      </Card>
    </div>
  );
}
