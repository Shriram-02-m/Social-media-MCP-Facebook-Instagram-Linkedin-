import Link from "next/link";

import { AdminPagination } from "@/components/admin/admin-pagination";
import { SocialStatusBadge, UserStatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/empty-state";
import { UserSearch } from "lucide-react";
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
  type AdminPlatform,
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

function PlatformBadge({ platform }: { platform: AdminPlatform }) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      className={`inline-flex h-5 items-center rounded-full px-2 text-[10px] font-semibold ring-1 ${meta.className}`}
      title={meta.label}
    >
      {meta.label}
    </span>
  );
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
              <PlatformBadge platform={platform} />
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
      <div>
        <h1 className="text-2xl font-semibold">Social accounts</h1>
        <p className="text-sm text-muted-foreground">
          Monitor every connected social account across the platform. Only
          non-secret metadata is shown; access tokens are never exposed.
        </p>
      </div>

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
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3">Owner</TableHead>
                  <TableHead className="px-3">Platform</TableHead>
                  <TableHead className="px-3">Connected account</TableHead>
                  <TableHead className="px-3">Status</TableHead>
                  <TableHead className="px-3">Last sync</TableHead>
                  <TableHead className="px-3">Token expiry</TableHead>
                  <TableHead className="px-3">Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <OwnerRow key={row.userId} row={row} />
                ))}
              </TableBody>
            </Table>
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
