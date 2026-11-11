import Link from "next/link";

import { AdminPagination } from "@/components/admin/admin-pagination";
import { SocialStatusBadge, UserStatusBadge } from "@/components/admin/status-badge";
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
import { parseSocialAccountFilters } from "@/lib/admin-policy";
import { listSocialAccounts } from "@/lib/admin-social-accounts";

import { SocialAccountFilters } from "./social-account-filters";

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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Total connections</CardDescription>
            <CardTitle className="text-2xl">{result.totalConnections}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Connected</CardDescription>
            <CardTitle className="text-2xl">{result.counts.connected}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Expired</CardDescription>
            <CardTitle className="text-2xl">{result.counts.expired}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Errors</CardDescription>
            <CardTitle className="text-2xl">{result.counts.error}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>
            {result.filteredConnections} of {result.totalConnections} connections
            across {result.totalUsers} matching user(s).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <SocialAccountFilters
            initialQuery={filters.query}
            initialPlatform={filters.platform}
            initialStatus={filters.status}
          />

          {result.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No social connections match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Owner</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Connected account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sync</TableHead>
                    <TableHead>Token expiry</TableHead>
                    <TableHead>Last error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={`${row.userId}:${row.platform}`}>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Link
                            href={`/users/${row.userId}`}
                            className="font-medium hover:underline"
                          >
                            {row.userName}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {row.userEmail}
                          </span>
                          <UserStatusBadge status={row.userStatus} />
                        </div>
                      </TableCell>
                      <TableCell className="capitalize">{row.platform}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <span className="text-sm">
                            {row.accountName ?? row.accountId ?? "—"}
                          </span>
                          {row.pageCount > 0 ? (
                            <span className="text-xs text-muted-foreground">
                              {row.pageCount} page(s)
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        <SocialStatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {dateTime(row.lastSyncAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {row.expiresAt ? dateTime(row.expiresAt) : "No expiry"}
                        {row.expired ? (
                          <span className="ml-1 text-destructive">(expired)</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-56 text-sm text-muted-foreground">
                        {row.lastError ?? "—"}
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
            total={result.filteredConnections}
          />
        </CardContent>
      </Card>
    </>
  );
}
