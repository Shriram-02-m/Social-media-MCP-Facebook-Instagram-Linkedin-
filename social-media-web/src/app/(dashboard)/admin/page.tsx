import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdminPage } from "@/lib/admin-page";
import { getAdminUserStats, type AdminUserStats } from "@/lib/admin-overview";

export const dynamic = "force-dynamic";

type StatKey = keyof AdminUserStats;

const STATS: {
  key: StatKey;
  label: string;
  description: string;
  href: string;
  indicator: string;
}[] = [
  {
    key: "total",
    label: "Total Users",
    description: "Every registered account, including suspended and soft-deleted records.",
    href: "/users",
    indicator: "bg-sky-500",
  },
  {
    key: "approved",
    label: "Approved Users",
    description: "Active accounts cleared for console access.",
    href: "/users?approval=approved",
    indicator: "bg-emerald-500",
  },
  {
    key: "pending",
    label: "Pending Users",
    description: "Users waiting for administrator approval.",
    href: "/users?approval=pending",
    indicator: "bg-amber-500",
  },
  {
    key: "rejected",
    label: "Rejected Users",
    description: "Active registration requests denied by the administrator.",
    href: "/users?approval=rejected",
    indicator: "bg-destructive",
  },
];

function StatCard({
  stat,
  value,
}: {
  stat: (typeof STATS)[number];
  value: number;
}) {
  return (
    <Link
      href={stat.href}
      className="group block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="h-full transition-colors group-hover:bg-muted/50">
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <span
              className={`size-2 rounded-full ${stat.indicator}`}
              aria-hidden="true"
            />
            {stat.label}
          </CardDescription>
          <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{stat.description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function AdminOverviewPage() {
  await requireAdminPage();
  const stats = await getAdminUserStats();

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Admin overview</h1>
        <p className="text-sm text-muted-foreground">
          User registration and approval statistics from live database records.
          Select a card to open the matching user list.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STATS.map((stat) => (
          <StatCard key={stat.key} stat={stat} value={stats[stat.key]} />
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Total includes every registered account. Approved, pending, and rejected
        counts exclude suspended and soft-deleted accounts.
      </p>
    </>
  );
}
