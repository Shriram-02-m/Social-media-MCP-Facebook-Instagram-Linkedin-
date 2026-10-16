import { PostsList } from "@/components/posts-list";

export default function QueuePage() {
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Queue</h1>
        <p className="text-sm text-muted-foreground">
          Scheduled posts waiting to publish.
        </p>
      </div>
      <PostsList statuses={["scheduled", "publishing"]} showWorkerButton />
    </>
  );
}
