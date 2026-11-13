import Link from "next/link";

import { PageHeader } from "@/components/page-header";
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

// Clickable cards mirror the admin overview so both pages read the same way.
const SUMMARY: {
  key: keyof AdminUserCounts;
  label: string;
  description: string;
  href: string;
  indicator: string;
}[] = [
  {
    key: "total",
    label: "Total users",
    description: "Every account except the Super Admin.",
    href: "/users",
    indicator: "bg-sky-500",
  },
  {
    key: "pending",
    label: "Pending",
    description: "Waiting for your approval.",
    href: "/users?status=pending",
    indicator: "bg-amber-500",
  },
  {
    key: "active",
    label: "Active",
    description: "Approved and able to sign in.",
    href: "/users?status=active",
    indicator: "bg-emerald-500",
  },
  {
    key: "inactive",
    label: "Inactive",
    description: "Rejected, suspended, or deleted.",
    href: "/users?status=inactive",
    indicator: "bg-destructive",
  },
];

export default async function UsersPage(props: PageProps<"/users">) {
  const session = await requireAdminPage();
  const filters = parseUserFilters(await props.searchParams);
  const { users, counts } = await listUsers(filters);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Users"
        description="Review registrations, approve or reject accounts, and inspect user details."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SUMMARY.map(({ key, label, description, href, indicator }) => (
          <Link
            key={key}
            href={href}
            className="group block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Card className="h-full transition-colors group-hover:bg-muted/50">
              <CardHeader>
                <CardDescription className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${indicator}`}
                    aria-hidden="true"
                  />
                  {label}
                </CardDescription>
                <CardTitle className="text-2xl tabular-nums">
                  {counts[key]}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">{description}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="gap-0 py-0">
        <CardHeader className="gap-1 border-b px-4 py-4 lg:px-5">
          <CardTitle>Directory</CardTitle>
          <CardDescription>
            {users.length} account{users.length === 1 ? "" : "s"} in this view.
            Only active users can use the console.
          </CardDescription>
        </CardHeader>

        <div className="border-b bg-muted/20 px-4 py-4 lg:px-5">
          <UsersFilters
            initialQuery={filters.query}
            initialStatus={filters.status}
            initialRole={filters.role}
          />
        </div>

        <CardContent className="p-0">
          <div className="px-4 py-4 lg:px-5">
            <UsersTable users={users} currentUserId={session.user.id} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
