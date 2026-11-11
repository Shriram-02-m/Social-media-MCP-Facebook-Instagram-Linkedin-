import Link from "next/link";

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
import { parsePostFilters } from "@/lib/admin-policy";
import { listScheduledPosts } from "@/lib/admin-scheduler";

import { PostActions } from "./post-actions";
import { SchedulerFilters } from "./scheduler-filters";

export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function dateTime(value: string | null): string {
  if (!value) return "—";
  return dateTimeFormatter.format(new Date(value));
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
    <>
      <div>
        <h1 className="text-2xl font-semibold">Scheduler</h1>
        <p className="text-sm text-muted-foreground">
          Every scheduled post across all accounts, including failures, retries,
          and held posts. Hold prevents a post from being claimed; resume never
          triggers an immediate duplicate publish.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Scheduled</CardDescription>
            <CardTitle className="text-2xl">{result.counts.scheduled}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Published</CardDescription>
            <CardTitle className="text-2xl">{result.counts.published}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Failed</CardDescription>
            <CardTitle className="text-2xl">{result.counts.failed}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Held</CardDescription>
            <CardTitle className="text-2xl">{result.counts.held}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All scheduled posts</CardTitle>
          <CardDescription>
            {result.total} post(s) match the current filters in this date range.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <SchedulerFilters
              initialQuery={filters.query}
              initialStatus={filters.status}
              initialPlatform={filters.platform}
            />
            <DateRangeFilter
              fromIso={filters.range.fromIso}
              toIso={filters.range.toIso}
              defaultDays={30}
            />
          </div>

          {result.posts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No scheduled posts match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Owner</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Post</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Retries</TableHead>
                    <TableHead>Error</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.posts.map((post) => (
                    <TableRow key={post.id}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Link
                            href={`/users/${post.ownerId}`}
                            className="font-medium hover:underline"
                          >
                            {post.ownerName}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {post.ownerEmail}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{post.platform}</TableCell>
                      <TableCell className="max-w-64">
                        <p className="text-sm">{post.textPreview}</p>
                        {post.mediaType ? (
                          <span className="text-xs text-muted-foreground">
                            {post.mediaType}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {dateTime(post.scheduledAt)}
                        {post.publishedAt ? (
                          <span className="block text-xs">
                            Published {dateTime(post.publishedAt)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <PostStatusBadge status={post.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {post.retryCount}
                        {post.failureStage ? (
                          <span className="block text-xs">{post.failureStage}</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-56 text-sm text-muted-foreground">
                        {post.error ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <PostActions id={post.id} status={post.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <AdminPagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
          />
        </CardContent>
      </Card>
    </>
  );
}
