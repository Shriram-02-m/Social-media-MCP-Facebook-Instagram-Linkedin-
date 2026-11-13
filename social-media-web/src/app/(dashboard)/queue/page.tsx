import { PageHeader } from "@/components/page-header";
import { PostsList } from "@/components/posts-list";

export default function QueuePage() {
  return (
    <>
      <PageHeader
        title="Queue"
        description="Scheduled posts waiting to publish, in publishing order."
      />
      <PostsList
        statuses={["scheduled", "publishing"]}
        showWorkerButton
        variant="queue"
        emptyTitle="Nothing in the queue"
        emptyDescription="Create a post in the Composer and choose Schedule to add it here."
      />
    </>
  );
}
