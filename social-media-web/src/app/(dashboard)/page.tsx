import {
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  PenSquare,
} from "lucide-react";
import Link from "next/link";

import { PostStatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PlatformChip } from "@/components/platform-chip";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { loadTokenMetadata, scheduledPostStatus, type TokenMetadata } from "@/lib/backend";
import { requireApprovedUser } from "@/lib/session";
import { PLATFORMS } from "@/lib/admin-policy";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  // The Overview is the default post-login destination for every role, so it
  // must only require an approved account - not the Super Admin role. Admin
  // accounts pass this check too.
  const session = await requireApprovedUser();
  const [posts, tokens] = await Promise.all([
    scheduledPostStatus(session.user.id),
    // Display-only metadata (account name, expiry) from the stored tokens.
    // Provider APIs are not contacted here, so the page stays fast.
    loadTokenMetadata(session.user.id).catch(() => [] as TokenMetadata[]),
  ]);

  const scheduled = posts.filter((post) => post.status === "scheduled");
  const published = posts.filter((post) => post.status === "published");
  const failed = posts.filter((post) => post.status === "failed");

  const tokenByPlatform = new Map(tokens.map((t) => [t.platform, t]));
  const connected = PLATFORMS.filter(
    (platform) => tokenByPlatform.has(platform),
  );
  const expired = connected.filter(
    (platform) => tokenByPlatform.get(platform)?.expired,
  );

  const upcoming = scheduled
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .slice(0, 5);

  const stats: {
    label: string;
    value: number;
    icon: typeof CalendarClock;
    tint: string;
    href: string;
  }[] = [
    {
      label: "Scheduled",
      value: scheduled.length,
      icon: CalendarClock,
      tint: "bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300",
      href: "/queue",
    },
    {
      label: "Published",
      value: published.length,
      icon: CheckCircle2,
      tint: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300",
      href: "/history",
    },
    {
      label: "Failed",
      value: failed.length,
      icon: CircleAlert,
      tint: "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-300",
      href: "/history",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Overview"
        description="A summary of your accounts, upcoming posts, and publishing results."
        actions={
          <Link href="/compose" className={buttonVariants({ size: "sm" })}>
            <PenSquare aria-hidden="true" />
            New post
          </Link>
        }
      />

      {failed.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <strong className="font-semibold">
            {failed.length} post{failed.length === 1 ? "" : "s"} failed to
            publish.
          </strong>
          <Link
            href="/history"
            className="font-medium underline underline-offset-2 hover:underline"
          >
            Review failures
          </Link>
        </p>
      ) : null}
      {expired.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <strong className="font-semibold">
            {expired
              .map((platform) => PLATFORM_LABEL(platform))
              .join(", ")}{" "}
            access has expired.
          </strong>
          <Link
            href="/accounts"
            className="font-medium underline underline-offset-2 hover:underline"
          >
            Reconnect account{expired.length === 1 ? "" : "s"}
          </Link>
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((stat) => (
          <Link
            key={stat.label}
            href={stat.href}
            className="group block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Card className="h-full transition-colors group-hover:bg-muted/50">
              <CardContent className="flex items-center justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm text-muted-foreground">
                    {stat.label}
                  </span>
                  <span className="text-2xl font-semibold tabular-nums">
                    {stat.value}
                  </span>
                </div>
                <span
                  className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${stat.tint}`}
                >
                  <stat.icon className="size-4" aria-hidden="true" />
                </span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Connected accounts</CardTitle>
            <CardDescription>
              {connected.length === 0
                ? "No accounts connected yet. Connect one to start publishing."
                : `${connected.length} of ${PLATFORMS.length} platforms connected.`}
            </CardDescription>
          </div>
          <Link
            href="/accounts"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Manage accounts
          </Link>
        </CardHeader>
        <CardContent>
          {connected.length === 0 ? (
            <EmptyState
              icon={PenSquare}
              title="No connected accounts"
              description="Connect Facebook, Instagram, or LinkedIn from the Accounts page to start publishing."
            />
          ) : (
            <ul className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:gap-x-6 sm:gap-y-2">
              {connected.map((platform) => {
                const token = tokenByPlatform.get(platform);
                return (
                  <li
                    key={platform}
                    className="flex min-w-0 items-center gap-2.5"
                  >
                    <PlatformChip platform={platform} size="md" />
                    <span className="min-w-0 flex-col">
                      <span className="block truncate text-sm font-medium">
                        {token?.accountName ?? PLATFORM_LABEL(platform)}
                      </span>
                      <span
                        className={`text-xs ${
                          token?.expired
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground"
                        }`}
                      >
                        {token?.expired ? "Expired — reconnect" : "Connected"}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Upcoming</CardTitle>
            <CardDescription>
              The next scheduled posts due to publish.
            </CardDescription>
          </div>
          <Link
            href="/calendar"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View calendar
          </Link>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {upcoming.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing scheduled"
              description="Create a post in the Composer and pick Schedule to see it here."
            />
          ) : (
            upcoming.map((post) => (
              <div
                key={post.id}
                className="flex items-center justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <PlatformChip platform={post.platform} />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {post.text || `${PLATFORM_LABEL(post.platform)} post`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(post.scheduledAt).toLocaleString()}
                    </span>
                  </div>
                </div>
                <PostStatusBadge status="scheduled" />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PLATFORM_LABEL(platform: string): string {
  return (
    {
      facebook: "Facebook",
      instagram: "Instagram",
      linkedin: "LinkedIn",
    }[platform] ?? platform
  );
}
