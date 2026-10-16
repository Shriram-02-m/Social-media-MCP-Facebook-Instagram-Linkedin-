import { CalendarClock, CheckCircle2, CircleAlert, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { scheduledPostStatus } from "@/lib/backend";

export const dynamic = "force-dynamic";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export default async function OverviewPage() {
  const posts = await scheduledPostStatus();

  const scheduled = posts.filter((post) => post.status === "scheduled").length;
  const published = posts.filter((post) => post.status === "published").length;
  const failed = posts.filter((post) => post.status === "failed").length;

  const stats = [
    { label: "Scheduled", value: scheduled, icon: CalendarClock },
    { label: "Published", value: published, icon: CheckCircle2 },
    { label: "Failed", value: failed, icon: CircleAlert },
    { label: "Total", value: posts.length, icon: Send },
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
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardDescription>{stat.label}</CardDescription>
              <stat.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <span className="text-3xl font-semibold">{stat.value}</span>
            </CardContent>
          </Card>
        ))}
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
