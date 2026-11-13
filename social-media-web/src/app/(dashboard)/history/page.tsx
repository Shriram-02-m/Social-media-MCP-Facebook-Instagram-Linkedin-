import { PageHeader } from "@/components/page-header";
import { PostsList } from "@/components/posts-list";

export default function HistoryPage() {
  return (
    <>
      <PageHeader
        title="History"
        description="Published, failed, and cancelled posts, with the reason for any failure."
      />
      <PostsList
        statuses={["published", "cancelled", "failed"]}
        showFilters
        variant="history"
        emptyTitle="No publishing history yet"
        emptyDescription="Published posts and failed attempts appear here once the worker runs."
      />
    </>
  );
}
