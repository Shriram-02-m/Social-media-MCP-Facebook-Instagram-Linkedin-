import Link from "next/link";
import { UsersRound } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
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
  /** Highlighted when the count is non-zero (drives attention to work to do). */
  attention?: string;
}[] = [
  {
    key: "pending",
    label: "Pending Users",
    description: "Waiting for your approval before they can sign in.",
    href: "/users?status=pending",
    indicator: "bg-amber-500",
    attention:
      "ring-2 ring-amber-500/60 dark:ring-amber-400/50 focus-visible:ring-amber-500",
  },
  {
    key: "active",
    label: "Active Users",
    description: "Approved accounts with console access.",
    href: "/users?status=active",
    indicator: "bg-emerald-500",
  },
  {
    key: "inactive",
    label: "Inactive Users",
    description: "Rejected, suspended, or deleted accounts.",
    href: "/users?status=inactive",
    indicator: "bg-destructive",
  },
  {
    key: "total",
    label: "Total Users",
    description: "Every registered account except the Super Admin.",
    href: "/users",
    indicator: "bg-sky-500",
  },
];

function StatCard({
  stat,
  value,
}: {
  stat: (typeof STATS)[number];
  value: number;
}) {
  // Pending approvals are the one thing an administrator must act on, so the
  // card is highlighted while work is waiting.
  const attention = stat.attention && value > 0 ? stat.attention : undefined;

  return (
    <Link
      href={stat.href}
      className="group block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card
        className={`h-full transition-colors group-hover:bg-muted/50 ${attention ?? ""}`}
      >
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
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Admin overview"
        description="User registration and account status at a glance. Select a card to open the matching user list."
      />

      {stats.pending > 0 ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          <strong className="font-semibold">
            {stats.pending} user{stats.pending === 1 ? "" : "s"}
          </strong>
          <span>waiting for approval.</span>
          <Link
            href="/users?status=pending"
            className="font-medium underline underline-offset-2 hover:underline"
          >
            Review pending users
          </Link>
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {STATS.map((stat) => (
          <StatCard key={stat.key} stat={stat} value={stats[stat.key]} />
        ))}
      </div>

      {stats.total === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={UsersRound}
              title="No registered users yet"
              description="New sign-ups appear here as pending until you approve them from the Users page."
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
