import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  XCircle,
} from "lucide-react";

import { PostStatusBadge, SocialStatusBadge } from "@/components/admin/status-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { getAdminUserContext } from "@/lib/admin-accounts";
import { requireAdminPage } from "@/lib/admin-page";
import type { AdminPlatform } from "@/lib/admin-policy";
import type { AdminUserPost } from "@/lib/admin-scheduler";
import type { AdminSocialConnectionRow } from "@/lib/admin-social-accounts";
import type { UserStatus } from "@/lib/admin-user-status";

import { AccountActions } from "./account-actions";
import { PostDetails } from "./post-details";
import { UserActions } from "./user-actions";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
  timeZone: "UTC",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
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

function dateTime(value: string | null): string {
  if (!value) return "—";
  return dateTimeFormatter.format(new Date(value));
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function mediaLabel(mediaType: string | null): string | null {
  if (!mediaType || mediaType === "none") return null;
  return mediaType
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

const ACCOUNT_STATUS_META: Record<
  UserStatus,
  { label: string; className: string }
> = {
  active: {
    label: "Active",
    className:
      "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  pending: {
    label: "Pending",
    className:
      "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  },
  inactive: {
    label: "Inactive",
    className:
      "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  },
};

function AccountStatusBadge({ status }: { status: UserStatus }) {
  const meta = ACCOUNT_STATUS_META[status];
  return (
    <Badge variant="outline" className={`px-2 ${meta.className}`}>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      {meta.label}
    </Badge>
  );
}

function RoleBadge({ role }: { role: string }) {
  return role === "admin" ? (
    <Badge>Super Admin</Badge>
  ) : (
    <Badge variant="secondary">User</Badge>
  );
}

const PLATFORM_META: Record<
  AdminPlatform,
  { label: string; mark: string; className: string }
> = {
  facebook: {
    label: "Facebook",
    mark: "f",
    className:
      "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-900",
  },
  instagram: {
    label: "Instagram",
    mark: "ig",
    className:
      "bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-950/50 dark:text-pink-300 dark:ring-pink-900",
  },
  linkedin: {
    label: "LinkedIn",
    mark: "in",
    className:
      "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900",
  },
};

const PLATFORMS: AdminPlatform[] = ["facebook", "instagram", "linkedin"];

function InfoItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function SocialRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs font-medium break-words">
        {children}
      </dd>
    </div>
  );
}

function SocialConnectionCard({
  platform,
  connection,
}: {
  platform: AdminPlatform;
  connection: AdminSocialConnectionRow | undefined;
}) {
  const meta = PLATFORM_META[platform];
  const accountLabel =
    connection?.accountName ?? connection?.accountId ?? "Unknown account";

  return (
    <div className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className={`flex size-9 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold uppercase ring-1 ${meta.className}`}
          >
            {meta.mark}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{meta.label}</p>
            <p className="text-xs text-muted-foreground">
              {connection ? "Connected account" : "Not connected"}
            </p>
          </div>
        </div>
        {connection ? (
          <SocialStatusBadge status={connection.status} />
        ) : (
          <Badge variant="outline">Disconnected</Badge>
        )}
      </div>

      {connection ? (
        <dl className="flex flex-col gap-2">
          <SocialRow label="Account">
            <span className="truncate" title={accountLabel}>
              {accountLabel}
            </span>
          </SocialRow>
          <SocialRow label="Last sync">
            {connection.lastSyncAt ? dateTime(connection.lastSyncAt) : "Never synced"}
          </SocialRow>
          <SocialRow label="Token expiry">
            {connection.expiresAt ? (
              <span className={connection.expired ? "text-destructive" : undefined}>
                {dateTime(connection.expiresAt)}
                {connection.expired ? " · Expired" : ""}
              </span>
            ) : (
              "No expiry"
            )}
          </SocialRow>
          {connection.pageCount > 0 ? (
            <SocialRow label="Connected pages">{connection.pageCount}</SocialRow>
          ) : null}
        </dl>
      ) : (
        <p className="rounded-md border border-dashed bg-muted/30 px-3 py-3 text-xs text-muted-foreground">
          No {meta.label} account is connected for this user.
        </p>
      )}
    </div>
  );
}

function PostRow({ post }: { post: AdminUserPost }) {
  const media = mediaLabel(post.mediaType);

  return (
    <TableRow className="h-[76px]">
      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex min-w-0 flex-col gap-0.5">
          <p
            className="line-clamp-2 text-sm leading-snug font-medium break-words"
            title={post.text}
          >
            {post.textPreview}
          </p>
          {media ? (
            <span className="text-[11px] text-muted-foreground">{media}</span>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`flex size-[18px] shrink-0 items-center justify-center rounded-full text-[8px] font-semibold ring-1 ${PLATFORM_META[post.platform].className}`}
          >
            {PLATFORM_META[post.platform].mark}
          </span>
          <span className="truncate text-xs">
            {PLATFORM_META[post.platform].label}
          </span>
        </span>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-0.5 text-sm">
          <span className="font-medium tabular-nums">
            {formatDate(post.scheduledAt)}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatTime(post.scheduledAt)} UTC
          </span>
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        {post.publishedAt ? (
          <div className="flex flex-col gap-0.5 text-sm">
            <span className="font-medium tabular-nums">
              {formatDate(post.publishedAt)}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatTime(post.publishedAt)} UTC
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Not published</span>
        )}
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <PostStatusBadge status={post.status} />
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 text-center align-top">
        <span className="text-sm font-medium tabular-nums">
          {post.retryCount}
        </span>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        {post.error ? (
          <p
            className="line-clamp-2 text-xs leading-snug break-words text-red-600 dark:text-red-400"
            title={post.error}
          >
            {post.error}
          </p>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 text-right align-top">
        <PostDetails post={post} />
      </TableCell>
    </TableRow>
  );
}

export default async function UserDetailPage(props: PageProps<"/users/[id]">) {
  const session = await requireAdminPage();
  const { id } = await props.params;
  const context = await getAdminUserContext(id);
  if (!context) notFound();
  const { detail, connections, posts } = context;

  const connectionsByPlatform = new Map(
    connections.map((connection) => [connection.platform, connection]),
  );
  const connectedPlatformCount = new Set(
    connections.map((connection) => connection.platform),
  ).size;
  const failedPosts = posts.filter((post) => post.status === "failed").length;
  const expiredConnections = connections.filter(
    (connection) =>
      connection.expired ||
      connection.status === "expired" ||
      connection.status === "error",
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <Link
          href="/users"
          className={buttonVariants({
            variant: "ghost",
            size: "sm",
            className: "-ml-2 w-fit",
          })}
        >
          <ArrowLeft aria-hidden="true" />
          Back to users
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div
              aria-hidden="true"
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary ring-1 ring-primary/20"
            >
              {initials(detail.name)}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-2xl font-semibold tracking-tight">
                  {detail.name}
                </h1>
                <AccountStatusBadge status={detail.status} />
                <RoleBadge role={detail.role} />
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {detail.email}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Account created {dateTime(detail.createdAt)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground sm:justify-end">
            <span className="inline-flex items-center gap-1.5">
              {detail.emailVerified ? (
                <CheckCircle2
                  className="size-3.5 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              ) : (
                <XCircle
                  className="size-3.5 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              )}
              {detail.emailVerified ? "Email verified" : "Email not verified"}
            </span>
            <span>
              {detail.sessionCount} active session
              {detail.sessionCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </header>

      {failedPosts > 0 || expiredConnections > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
          <span className="font-medium">Needs attention</span>
          {failedPosts > 0 ? (
            <span>
              {failedPosts} failed post{failedPosts === 1 ? "" : "s"}
            </span>
          ) : null}
          {expiredConnections > 0 ? (
            <span>
              {expiredConnections} connection
              {expiredConnections === 1 ? "" : "s"} need reconnecting
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Account information</CardTitle>
            <CardDescription>
              Identity, access, and lifecycle details for this account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
              <InfoItem label="Full name">{detail.name}</InfoItem>
              <InfoItem label="Email address">{detail.email}</InfoItem>
              <InfoItem label="Role">
                <RoleBadge role={detail.role} />
              </InfoItem>
              <InfoItem label="Account status">
                <AccountStatusBadge status={detail.status} />
              </InfoItem>
              <InfoItem label="Email verification">
                <span className="inline-flex items-center gap-1.5">
                  {detail.emailVerified ? (
                    <CheckCircle2
                      className="size-3.5 text-emerald-600 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <XCircle
                      className="size-3.5 text-amber-600 dark:text-amber-400"
                      aria-hidden="true"
                    />
                  )}
                  {detail.emailVerified ? "Verified" : "Not verified"}
                </span>
              </InfoItem>
              <InfoItem label="Password login">
                {detail.hasPassword ? "Configured" : "Not configured"}
              </InfoItem>
              <InfoItem label="Account created">
                {dateTime(detail.createdAt)}
              </InfoItem>
              <InfoItem label="Last updated">
                {dateTime(detail.updatedAt)}
              </InfoItem>
              <InfoItem label="Active sessions">{detail.sessionCount}</InfoItem>
              <InfoItem label="Suspended">
                {detail.banned ? (
                  <span className="text-destructive">Yes</span>
                ) : (
                  "No"
                )}
              </InfoItem>
              {detail.banned ? (
                <InfoItem label="Suspension reason">
                  {detail.banReason ?? "—"}
                </InfoItem>
              ) : null}
              {detail.banned ? (
                <InfoItem label="Suspension expires">
                  {dateTime(detail.banExpires)}
                </InfoItem>
              ) : null}
              <InfoItem label="Deleted">
                {detail.deletedAt ? (
                  <span className="text-destructive">
                    Yes · {dateTime(detail.deletedAt)}
                  </span>
                ) : (
                  "No"
                )}
              </InfoItem>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account management</CardTitle>
            <CardDescription>
              Approve, suspend, secure, or remove access. Changes are authorized
              on the server and recorded in the activity log.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <UserActions
              id={detail.id}
              role={detail.role}
              approvalStatus={detail.approvalStatus}
              isSelf={detail.id === session.user.id}
              adminExists
            />
            <Separator />
            <AccountActions
              id={detail.id}
              role={detail.role}
              banned={detail.banned}
              deletedAt={detail.deletedAt}
              isSelf={detail.id === session.user.id}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Social media connections</CardTitle>
          <CardDescription>
            {connectedPlatformCount} of {PLATFORMS.length} platforms connected.
            Connection metadata only; access tokens are never exposed in this
            console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {PLATFORMS.map((platform) => (
              <SocialConnectionCard
                key={platform}
                platform={platform}
                connection={connectionsByPlatform.get(platform)}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="gap-0 py-0">
        <CardHeader className="gap-1 border-b px-4 py-4 lg:px-5">
          <CardTitle>Recent scheduled posts</CardTitle>
          <CardDescription>
            The most recent {posts.length} post{posts.length === 1 ? "" : "s"}{" "}
            for this account, including publishing history and failure details.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <CalendarClock className="size-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">No scheduled posts</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                This user has no scheduled, published, or failed posts yet.
              </p>
            </div>
          ) : (
            <Table className="min-w-[960px] table-fixed">
              <colgroup>
                <col className="w-[25%]" />
                <col className="w-[10%]" />
                <col className="w-[13%]" />
                <col className="w-[13%]" />
                <col className="w-[11%]" />
                <col className="w-[6%]" />
                <col className="w-[15%]" />
                <col className="w-[7%]" />
              </colgroup>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Post
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Platform
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Scheduled
                  </TableHead>
                  <TableHead className="h-11 px-3 text-xs font-medium text-muted-foreground">
                    Published
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
                {posts.map((post) => (
                  <PostRow key={post.id} post={post} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
