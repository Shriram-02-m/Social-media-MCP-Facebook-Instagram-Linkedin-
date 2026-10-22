import { PostsList } from "@/components/posts-list";

export default function HistoryPage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">History</h1>
        <p className="text-sm text-muted-foreground">
          Published, failed, and cancelled posts.
        </p>
      </div>
      <PostsList statuses={["published", "cancelled", "failed"]} showFilters />
    </>
  );
}
