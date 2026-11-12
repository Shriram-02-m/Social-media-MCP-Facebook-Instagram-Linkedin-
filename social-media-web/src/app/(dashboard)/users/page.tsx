import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdminPage } from "@/lib/admin-page";
import { listUsers, type AdminUserCounts } from "@/lib/admin-users";
import { parseUserFilters } from "@/lib/admin-users-policy";

import { UsersFilters } from "./users-filters";
import { UsersTable } from "./users-table";

export const dynamic = "force-dynamic";

const SUMMARY: { key: keyof AdminUserCounts; label: string }[] = [
  { key: "total", label: "Total users" },
  { key: "pending", label: "Pending" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
];

export default async function UsersPage(props: PageProps<"/users">) {
  const session = await requireAdminPage();
  const filters = parseUserFilters(await props.searchParams);
  const { users, counts } = await listUsers(filters);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Review registrations, approve or reject accounts, and inspect user
          details.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SUMMARY.map(({ key, label }) => (
          <Card key={key}>
            <CardHeader>
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-2xl">{counts[key]}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Directory</CardTitle>
          <CardDescription>
            Showing {users.length} account{users.length === 1 ? "" : "s"} in this
            view. Only active users can use the console.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <UsersFilters
            initialQuery={filters.query}
            initialStatus={filters.status}
            initialRole={filters.role}
          />
          <UsersTable users={users} currentUserId={session.user.id} />
        </CardContent>
      </Card>
    </>
  );
}
