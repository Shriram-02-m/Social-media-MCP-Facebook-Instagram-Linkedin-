"use client";

import { useMemo, useState } from "react";

import { PostStatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PlatformChip } from "@/components/platform-chip";
import { CalendarDays } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";

export interface CalendarPost {
  id: string;
  platform: "facebook" | "instagram" | "linkedin";
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "held";
  mediaType: string;
  text: string;
  when: string;
}

function dayKey(date: Date): number {
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeStyle: "short",
});

export function CalendarPanel({ posts }: { posts: CalendarPost[] }) {
  const [selected, setSelected] = useState<Date | undefined>(undefined);

  const entries = useMemo(
    () =>
      posts.map((post) => ({
        post,
        date: new Date(post.when),
      })),
    [posts],
  );

  const scheduledDates = useMemo(() => entries.map((entry) => entry.date), [entries]);
  const selectedKey = selected ? dayKey(selected) : null;
  const selectedPosts = selectedKey === null
    ? []
    : entries.filter((entry) => dayKey(entry.date) === selectedKey);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Schedule</CardTitle>
          <CardDescription>
            Days with scheduled or published posts are marked. Select a day to
            see its posts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Calendar
            mode="single"
            selected={selected}
            onSelect={setSelected}
            modifiers={{ scheduled: scheduledDates }}
            modifiersClassNames={{ scheduled: "bg-primary/15 font-semibold" }}
            className="rounded-md border"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {selected ? dayFormatter.format(selected) : "Select a day"}
          </CardTitle>
          <CardDescription>
            {selected
              ? `${selectedPosts.length} post${selectedPosts.length === 1 ? "" : "s"} on this day.`
              : "Pick a marked day to see its posts."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {selectedPosts.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title={selected ? "Nothing on this day" : "No day selected"}
              description={
                selected
                  ? "No posts are scheduled or were published on this day."
                  : "Marked days in the calendar have scheduled or published posts."
              }
            />
          ) : (
            selectedPosts.map(({ post }) => (
              <div
                key={post.id}
                className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5">
                    <PlatformChip platform={post.platform} />
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="line-clamp-2 text-sm font-medium">
                      {post.text || "—"}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {timeFormatter.format(new Date(post.when))}
                    </span>
                  </div>
                </div>
                <PostStatusBadge status={post.status} />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
