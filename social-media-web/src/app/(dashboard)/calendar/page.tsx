import { CalendarPanel, type CalendarPost } from "./calendar-panel";
import { scheduledPostStatus } from "@/lib/backend";

export default async function CalendarPage() {
  const posts = await scheduledPostStatus();

  const entries: CalendarPost[] = posts
    .filter((post) => post.status !== "cancelled")
    .map((post) => ({
      id: post.id,
      platform: post.platform,
      status: post.status,
      mediaType: post.mediaType,
      text: post.text,
      when: post.publishedAt ?? post.scheduledAt,
    }));

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Calendar</h1>
        <p className="text-sm text-muted-foreground">
          Scheduled and published posts across the month.
        </p>
      </div>
      <CalendarPanel posts={entries} />
    </>
  );
}
