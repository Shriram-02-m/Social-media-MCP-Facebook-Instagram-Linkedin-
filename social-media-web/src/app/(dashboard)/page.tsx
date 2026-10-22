import { CalendarClock, CheckCircle2, CircleAlert, Send } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { scheduledPostStatus } from "@/lib/backend";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export default async function OverviewPage() {
  const session = await requireAdmin();
  const posts = await scheduledPostStatus(session.user.id);

  const scheduled = posts.filter((post) => post.status === "scheduled").length;
  const published = posts.filter((post) => post.status === "published").length;
  const failed = posts.filter((post) => post.status === "failed").length;

  const stats: {
    label: string;
    value: number;
    icon: typeof CalendarClock;
    href?: string;
  }[] = [
    { label: "Scheduled", value: scheduled, icon: CalendarClock, href: "/queue" },
    { label: "Published", value: published, icon: CheckCircle2, href: "/history" },
    { label: "Failed", value: failed, icon: CircleAlert, href: "/history" },
    { label: "Total", value: posts.length, icon: Send, href: "/history" },
  ];

  const upcoming = posts
    .filter((post) => post.status === "scheduled")
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
    .slice(0, 5);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">
          Delivery status across connected platforms.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const contents = (
            <>
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardDescription>{stat.label}</CardDescription>
                <stat.icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <span className="text-3xl font-semibold">{stat.value}</span>
              </CardContent>
            </>
          );

          if (stat.href) {
            return (
              <Link
                key={stat.label}
                href={stat.href}
                className="cursor-pointer rounded-xl outline-none transition-colors hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Card className="h-full">{contents}</Card>
              </Link>
            );
          }

          return <Card key={stat.label}>{contents}</Card>;
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming</CardTitle>
          <CardDescription>Next scheduled posts due to publish.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {upcoming.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing scheduled.</p>
          ) : (
            upcoming.map((post) => (
              <div
                key={post.id}
                className="flex items-center justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">
                    {PLATFORM_LABELS[post.platform] ?? post.platform}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(post.scheduledAt).toLocaleString()}
                  </span>
                </div>
                <Badge variant="secondary">{post.mediaType}</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </>
  );
}
