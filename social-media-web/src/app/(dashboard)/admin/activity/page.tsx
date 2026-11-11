import { AdminPagination } from "@/components/admin/admin-pagination";
import { DateRangeFilter } from "@/components/admin/date-range-filter";
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
import { listActivity } from "@/lib/admin-activity";
import { requireAdminPage } from "@/lib/admin-page";
import { parseActivityFilters } from "@/lib/admin-policy";

import { ActivityFiltersForm } from "./activity-filters";

export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function metadataPreview(metadata: unknown): string {
  try {
    const text = JSON.stringify(metadata);
    if (!text || text === "{}") return "—";
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  } catch {
    return "—";
  }
}

export default async function AdminActivityPage({
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
  const filters = parseActivityFilters(query);
  const result = await listActivity(filters);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Activity logs</h1>
        <p className="text-sm text-muted-foreground">
          Audit trail for registrations, logins, approvals, account controls,
          social connections, scheduling, and publishing. Credentials and tokens
          are never recorded.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Audit trail</CardTitle>
          <CardDescription>
            {result.total} event(s) in this range. Showing page {result.page}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <ActivityFiltersForm
              initialQuery={filters.query}
              initialAction={filters.action}
              initialUserId={filters.userId}
              actions={result.actions}
            />
            <DateRangeFilter
              fromIso={filters.range.fromIso}
              toIso={filters.range.toIso}
              defaultDays={30}
            />
          </div>

          {result.entries.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No activity matches these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Actor</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {dateTime(entry.createdAt)}
                      </TableCell>
                      <TableCell className="font-medium">{entry.action}</TableCell>
                      <TableCell className="text-sm">
                        <span className="block">{entry.actorName ?? "—"}</span>
                        <span className="text-xs text-muted-foreground">
                          {entry.actorEmail ?? entry.actorUserId ?? ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm">
                        <span className="block">{entry.targetName ?? "—"}</span>
                        <span className="text-xs text-muted-foreground">
                          {entry.targetEmail ?? entry.targetUserId ?? ""}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {entry.resourceType}
                        {entry.resourceId ? (
                          <span className="block max-w-48 truncate text-xs">
                            {entry.resourceId}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="max-w-64 text-xs text-muted-foreground">
                        {metadataPreview(entry.metadata)}
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
