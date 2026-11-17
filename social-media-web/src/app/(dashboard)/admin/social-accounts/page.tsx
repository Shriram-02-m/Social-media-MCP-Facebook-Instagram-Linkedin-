import Link from "next/link";
import { UserSearch } from "lucide-react";

import { AdminPagination } from "@/components/admin/admin-pagination";
import { SocialStatusBadge, UserStatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PlatformChip } from "@/components/platform-chip";
import { Badge } from "@/components/ui/badge";
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
  parseSocialAccountFilters,
  PLATFORMS,
} from "@/lib/admin-policy";
import { PLATFORM_META } from "@/lib/platform-meta";
import {
  listSocialAccounts,
  type AdminSocialConnectionRow,
  type AdminSocialOwnerRow,
} from "@/lib/admin-social-accounts";

import { SocialAccountFilters } from "./social-account-filters";

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

function accountLabel(connection: AdminSocialConnectionRow): string {
  return connection.accountName ?? connection.accountId ?? "—";
}

function OwnerRow({ row }: { row: AdminSocialOwnerRow }) {
  // Every user row always shows all three platforms; connections that do not
  // exist render "Not connected" with "—" placeholders in the detail columns.
  const connectionByPlatform = new Map(
    row.connections.map((connection) => [connection.platform, connection] as const),
  );

  return (
    <TableRow>
      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/users/${row.userId}`}
            className="truncate font-medium hover:underline"
            title={row.userName}
          >
            {row.userName}
          </Link>
          <span
            className="truncate text-xs text-muted-foreground"
            title={row.userEmail}
          >
            {row.userEmail}
          </span>
          <div>
            <UserStatusBadge status={row.userStatus} />
          </div>
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {PLATFORMS.map((platform) => (
            <div
              key={platform}
              className="flex h-9 items-center"
            >
              <PlatformChip platform={platform} showLabel />
            </div>
          ))}
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {PLATFORMS.map((platform) => {
            const connection = connectionByPlatform.get(platform);
            return (
              <div
                key={platform}
                className="flex h-9 min-w-0 items-center gap-1.5"
              >
                <span
                  className="w-5 shrink-0 text-[10px] font-semibold text-muted-foreground"
                  title={PLATFORM_META[platform].label}
                >
                  {PLATFORM_META[platform].short}
                </span>
                <span
                  className="min-w-0 truncate text-sm"
                  title={connection ? accountLabel(connection) : undefined}
                >
                  {connection ? accountLabel(connection) : "—"}
                </span>
                {connection && connection.pageCount > 0 ? (
                  <span
                    className="shrink-0 text-[11px] text-muted-foreground"
                    title={`${connection.pageCount} connected page(s)`}
                  >
                    · {connection.pageCount} pages
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {PLATFORMS.map((platform) => {
            const connection = connectionByPlatform.get(platform);
            return (
              <div key={platform} className="flex h-9 items-center">
                {connection ? (
                  <SocialStatusBadge status={connection.status} />
                ) : (
                  <Badge variant="secondary">Not connected</Badge>
                )}
              </div>
            );
          })}
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {PLATFORMS.map((platform) => {
            const connection = connectionByPlatform.get(platform);
            return (
              <div
                key={platform}
                className="flex h-9 min-w-0 flex-col justify-center"
              >
                <span
                  className="truncate text-xs font-medium tabular-nums"
                  title={connection ? dateTime(connection.lastSyncAt) : undefined}
                >
                  {connection ? formatDate(connection.lastSyncAt) : "—"}
                </span>
                {connection?.lastSyncAt ? (
                  <span className="truncate text-[11px] tabular-nums text-muted-foreground">
                    {formatTime(connection.lastSyncAt)} UTC
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {PLATFORMS.map((platform) => {
            const connection = connectionByPlatform.get(platform);
            return (
              <div key={platform} className="flex h-9 min-w-0 items-center">
                {connection ? (
                  connection.expiresAt ? (
                    <div
                      className={`flex h-9 min-w-0 flex-col justify-center ${
                        connection.expired
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }`}
                      title={`${dateTime(connection.expiresAt)}${
                        connection.expired ? " (expired)" : ""
                      }`}
                    >
                      <span className="truncate text-xs font-medium tabular-nums">
                        {formatDate(connection.expiresAt)}
                      </span>
                      <span className="truncate text-[11px] tabular-nums">
                        {formatTime(connection.expiresAt)} UTC
                      </span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No expiry
                    </span>
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            );
          })}
        </div>
      </TableCell>

      <TableCell className="whitespace-normal px-3 py-3 align-top">
        <div className="flex flex-col gap-1">
          {PLATFORMS.map((platform) => {
            const connection = connectionByPlatform.get(platform);
            return (
              <div key={platform} className="flex h-9 min-w-0 items-center">
                {connection?.lastError ? (
                  <p
                    className="line-clamp-2 w-full text-[11px] leading-4 break-words text-red-600 dark:text-red-400"
                    title={connection.lastError}
                  >
                    {connection.lastError}
                  </p>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </div>
            );
          })}
        </div>
      </TableCell>
    </TableRow>
  );
}

function OwnerCard({ row }: { row: AdminSocialOwnerRow }) {
  const connectionByPlatform = new Map(
    row.connections.map((connection) => [connection.platform, connection] as const),
  );

  return (
    <article className="rounded-xl border bg-card p-4 shadow-card">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-2 border-b pb-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={`/users/${row.userId}`}
            className="truncate text-sm font-semibold hover:underline"
            title={row.userName}
          >
            {row.userName}
          </Link>
          <span className="truncate text-xs text-muted-foreground" title={row.userEmail}>
            {row.userEmail}
          </span>
        </div>
        <UserStatusBadge status={row.userStatus} />
      </header>

      <div className="divide-y">
        {PLATFORMS.map((platform) => {
          const connection = connectionByPlatform.get(platform);
          return (
            <section key={platform} className="flex flex-col gap-3 py-3 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PlatformChip platform={platform} showLabel />
                {connection ? (
                  <SocialStatusBadge status={connection.status} />
                ) : (
                  <Badge variant="secondary">Not connected</Badge>
                )}
              </div>
              <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Connected account</dt>
                  <dd className="truncate font-medium" title={connection ? accountLabel(connection) : undefined}>
                    {connection ? accountLabel(connection) : "—"}
                    {connection && connection.pageCount > 0
                      ? ` · ${connection.pageCount} page${connection.pageCount === 1 ? "" : "s"}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last sync</dt>
                  <dd className="font-medium tabular-nums">
                    {connection ? dateTime(connection.lastSyncAt) : "—"}
                    {connection?.lastSyncAt ? " UTC" : ""}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Token expiry</dt>
                  <dd
                    className={`font-medium tabular-nums ${
                      connection?.expired ? "text-destructive" : ""
                    }`}
                  >
                    {connection
                      ? connection.expiresAt
                        ? `${dateTime(connection.expiresAt)}${connection.expired ? " (expired)" : ""}`
                        : "No expiry"
                      : "—"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Last error</dt>
                  <dd
                    className="line-clamp-2 break-words font-medium text-destructive"
                    title={connection?.lastError ?? undefined}
                  >
                    {connection?.lastError ?? "—"}
                  </dd>
                </div>
              </dl>
            </section>
          );
        })}
      </div>
    </article>
  );
}

export default async function AdminSocialAccountsPage({
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
  const filters = parseSocialAccountFilters(query);
  const result = await listSocialAccounts(filters);

  return (
    <>
      <PageHeader
        title="Social accounts"
        description="Monitor every connected social account across the platform. Only non-secret metadata is shown; access tokens are never exposed."
      />

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            {result.filteredConnections} of {result.totalConnections} connections
            {" · "}
            {result.filteredUsers} user{result.filteredUsers === 1 ? "" : "s"}{" "}
            shown, one row per owner.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SocialAccountFilters
            initialQuery={filters.query}
            initialPlatform={filters.platform}
            initialStatus={filters.status}
          />

          {result.rows.length === 0 ? (
            <EmptyState
              icon={UserSearch}
              title="No users match these filters"
              description="Try a different search term, platform, or status filter."
            />
          ) : (
            <>
              <div className="hidden xl:block">
                <Table className="min-w-[960px] table-fixed">
                  <colgroup>
                    <col className="w-[17%]" />
                    <col className="w-[11%]" />
                    <col className="w-[20%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <TableHeader className="bg-muted/40">
                    <TableRow>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Owner</TableHead>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Platform</TableHead>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Connected account</TableHead>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Status</TableHead>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Last sync</TableHead>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Token expiry</TableHead>
                      <TableHead className="px-3 text-xs font-medium text-muted-foreground">Last error</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.rows.map((row) => (
                      <OwnerRow key={row.userId} row={row} />
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="grid gap-3 p-3 xl:hidden sm:p-4">
                {result.rows.map((row) => (
                  <OwnerCard key={row.userId} row={row} />
                ))}
              </div>
            </>
          )}

          <AdminPagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.filteredUsers}
          />
        </CardContent>
      </Card>
    </>
  );
}
