import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

import { DateRangeFilter } from "@/components/admin/date-range-filter";
import { OverviewChart } from "@/components/admin/overview-chart";
import { PostStatusBadge, UserStatusBadge } from "@/components/admin/status-badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdminPage } from "@/lib/admin-page";
import { listActivity } from "@/lib/admin-activity";
import { parseActivityFilters, parseDateRange } from "@/lib/admin-policy";
import { getAdminOverview } from "@/lib/admin-overview";

export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}

export default async function AdminOverviewPage({
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

  const range = parseDateRange(query, { defaultDays: 30, maxDays: 366 });
  const overview = await getAdminOverview(range);
  const activity = await listActivity({
    ...parseActivityFilters(query),
    page: 1,
    pageSize: 8,
    offset: 0,
  });

  const { users, socialAccounts, posts, series } = overview;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Admin overview</h1>
        <p className="text-sm text-muted-foreground">
          Platform-wide health for users, connected accounts, and scheduled
          publishing. All figures come from live database records.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Showing activity from {dateTime(range.fromIso)} to {dateTime(range.toIso)}.
        </p>
        <DateRangeFilter
          fromIso={range.fromIso}
          toIso={range.toIso}
          defaultDays={30}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Total users"
          value={users.total}
          hint={`${users.newInRange} registered in this range`}
        />
        <Stat
          label="Pending approvals"
          value={users.pending}
          hint={`${users.approved} approved · ${users.rejected} rejected`}
        />
        <Stat
          label="Suspended accounts"
          value={users.suspended}
          hint={`${users.deleted} soft-deleted`}
        />
        <Stat
          label="Connected social accounts"
          value={socialAccounts.connected}
          hint={`${socialAccounts.expired} expired token(s)`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Scheduled posts"
          value={posts.scheduled + posts.publishing}
          hint={`${posts.inRange.scheduled + posts.inRange.publishing} in this range`}
        />
        <Stat
          label="Published posts"
          value={posts.published}
          hint={`${posts.inRange.published} published in this range`}
        />
        <Stat
          label="Failed posts"
          value={posts.failed}
          hint={`${posts.inRange.failed} failed in this range`}
        />
        <Stat
          label="Held posts"
          value={posts.held}
          hint="Prevented from publishing until resumed"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Daily activity</CardTitle>
          <CardDescription>
            New users and post activity over the selected range. The most recent
            30 days are charted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OverviewChart series={series} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            The latest administrative and publishing events across all accounts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {activity.entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No activity recorded in this range.
            </p>
          ) : (
            <ul className="divide-y">
              {activity.entries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{entry.action}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.actorName ?? entry.actorEmail ?? entry.actorUserId ?? "System"}
                      {entry.targetEmail ? ` → ${entry.targetEmail}` : ""}
                    </p>
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {dateTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="pt-4">
            <Link
              href="/admin/activity"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              View activity logs
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Publishing snapshot</CardTitle>
          <CardDescription>
            Current status of every scheduled post in the system.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <PostStatusBadge status="scheduled" />
          <span className="text-sm text-muted-foreground">{posts.scheduled}</span>
          <PostStatusBadge status="publishing" />
          <span className="text-sm text-muted-foreground">{posts.publishing}</span>
          <PostStatusBadge status="published" />
          <span className="text-sm text-muted-foreground">{posts.published}</span>
          <PostStatusBadge status="failed" />
          <span className="text-sm text-muted-foreground">{posts.failed}</span>
          <PostStatusBadge status="cancelled" />
          <span className="text-sm text-muted-foreground">{posts.cancelled}</span>
          <PostStatusBadge status="held" />
          <span className="text-sm text-muted-foreground">{posts.held}</span>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account health</CardTitle>
          <CardDescription>
            A quick view of account states. Detailed management lives on the
            Users page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            <UserStatusBadge status="approved" /> {users.approved}
          </span>
          <span className="flex items-center gap-2">
            <UserStatusBadge status="pending" /> {users.pending}
          </span>
          <span className="flex items-center gap-2">
            <UserStatusBadge status="rejected" /> {users.rejected}
          </span>
          <span className="flex items-center gap-2">
            <UserStatusBadge status="suspended" /> {users.suspended}
          </span>
          <span className="flex items-center gap-2">
            <UserStatusBadge status="deleted" /> {users.deleted}
          </span>
        </CardContent>
      </Card>
    </>
  );
}
