"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
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
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  mediaType: string;
  text: string;
  when: string;
}

const PLATFORM_LABELS: Record<CalendarPost["platform"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

function dayKey(date: Date): number {
  return date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate();
}

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
          <CardDescription>Days with scheduled or published posts are marked.</CardDescription>
        </CardHeader>
        <CardContent>
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
          <CardTitle>{selected ? selected.toDateString() : "Select a day"}</CardTitle>
          <CardDescription>
            {selected
              ? `${selectedPosts.length} post(s) on this day.`
              : "Pick a marked day to see its posts."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {selectedPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing on this day.</p>
          ) : (
            selectedPosts.map(({ post }) => (
              <div key={post.id} className="flex items-start justify-between gap-3 border-b pb-3 last:border-b-0 last:pb-0">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {PLATFORM_LABELS[post.platform]}
                  </span>
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {post.text || "—"}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(post.when).toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge variant="secondary">{post.mediaType}</Badge>
                  <Badge variant="outline">{post.status}</Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
