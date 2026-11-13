import { PageHeader } from "@/components/page-header";
import { CalendarPanel, type CalendarPost } from "./calendar-panel";
import { scheduledPostStatus } from "@/lib/backend";
import { requireApprovedUser } from "@/lib/session";

export default async function CalendarPage() {
  // Calendar is in the shared sidebar navigation for every approved account.
  const session = await requireApprovedUser();
  const posts = await scheduledPostStatus(session.user.id);

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
      <PageHeader
        title="Calendar"
        description="Scheduled and published posts across the month, one platform per mark."
      />
      <CalendarPanel posts={entries} />
    </>
  );
}
