"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  History,
  LoaderCircle,
  ListChecks,
  RotateCcw,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { PostStatusBadge } from "@/components/admin/status-badge";
import { EmptyState } from "@/components/empty-state";
import { PlatformChip } from "@/components/platform-chip";
import { RescheduleDialog } from "@/components/reschedule-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  filterAndSortPosts,
  paginatePosts,
  type PostListSort,
} from "@/lib/post-list-view";

export interface ScheduledPostSummary {
  id: string;
  platform: "facebook" | "instagram" | "linkedin";
  text: string;
  scheduledAt: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "held";
  publishedAt?: string;
  error?: string;
  retryCount: number;
  mediaType: "none" | "image" | "video" | "carousel" | "document";
  failureStage?: "token_validation" | "image_validation" | "document_validation" | "publishing";
}

const PLATFORM_LABELS: Record<ScheduledPostSummary["platform"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

const STATUS_LABELS: Record<ScheduledPostSummary["status"], string> = {
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
  held: "Held",
};

const MEDIA_LABELS: Record<ScheduledPostSummary["mediaType"], string> = {
  none: "Text only",
  image: "Image",
  video: "Video",
  carousel: "Carousel",
  document: "Document",
};

const PLATFORM_ORDER: ScheduledPostSummary["platform"][] = [
  "facebook",
  "instagram",
  "linkedin",
];

type StatusFilter = "all" | ScheduledPostSummary["status"];
type PlatformFilter = "all" | ScheduledPostSummary["platform"];
type SortOption = PostListSort;

const PAGE_SIZE = 10;

function canRetry(post: ScheduledPostSummary): boolean {
  return (
    post.status === "failed" &&
    post.failureStage !== undefined &&
    post.failureStage !== "publishing"
  );
}

function canReschedule(post: ScheduledPostSummary): boolean {
  // Held posts can be rescheduled to a future time (which also returns them to
  // `scheduled`), matching the backend scheduler rules.
  return post.status === "scheduled" || post.status === "held";
}

function canCancel(post: ScheduledPostSummary): boolean {
  return post.status === "scheduled" || post.status === "held";
}

export function PostsList({
  statuses,
  showWorkerButton = false,
  showFilters = false,
  variant = "queue",
  emptyTitle = "No posts to show",
  emptyDescription,
}: {
  statuses: ScheduledPostSummary["status"][];
  showWorkerButton?: boolean;
  showFilters?: boolean;
  /** Selects the empty-state icon inside this client component (icons cannot
   * be passed from server pages to client components). */
  variant?: "queue" | "history";
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const EmptyIcon = variant === "history" ? History : ListChecks;
  const [posts, setPosts] = useState<ScheduledPostSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<ScheduledPostSummary | null>(null);
  const [cancelling, setCancelling] = useState<ScheduledPostSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortOption>(
    variant === "queue" ? "date-oldest" : "date-newest",
  );
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    return fetch("/api/posts", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          posts?: ScheduledPostSummary[];
          error?: string;
        };
        if (!response.ok) {
          setLoadError(body.error ?? "Could not load posts. Try again.");
          return;
        }
        setLoadError(null);
        setPosts(body.posts ?? []);
      })
      .catch((error: unknown) => {
        setLoadError(
          error instanceof Error ? error.message : "Could not load posts. Try again.",
        );
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = (posts ?? []).filter((post) => statuses.includes(post.status));
  const filtered = filterAndSortPosts(visible, {
    statuses,
    query,
    status: statusFilter,
    platform: platformFilter,
    sort: sortBy,
  });
  const pagination = paginatePosts(filtered, page, PAGE_SIZE);
  const currentPage = pagination.page;
  const filtersActive =
    query.trim().length > 0 || statusFilter !== "all" || platformFilter !== "all";

  function resetFilters() {
    setQuery("");
    setStatusFilter("all");
    setPlatformFilter("all");
    setPage(1);
  }

  async function runAction(
    id: string,
    path: string,
    successMessage: string,
  ) {
    setBusyId(id);
    try {
      const response = await fetch(path, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast.error(body.error ?? "Action failed.");
        return;
      }
      toast.success(successMessage);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusyId(null);
    }
  }

  async function runWorker() {
    setBusyId("worker");
    try {
      const response = await fetch("/api/worker/run", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        processed?: number;
        error?: string;
      };
      if (!response.ok) {
        toast.error(body.error ?? "Could not check due posts.");
        return;
      }
      toast.success(
        body.processed
          ? `Published ${body.processed} due post${body.processed === 1 ? "" : "s"}.`
          : "No posts were due right now.",
      );
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not check due posts.");
    } finally {
      setBusyId(null);
    }
  }

  async function cancelPost() {
    if (!cancelling) return;
    const post = cancelling;
    setCancelling(null);
    await runAction(post.id, `/api/posts/${post.id}/cancel`, "Post cancelled. It will not be published.");
  }

  return (
    <Card className="shadow-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Posts</CardTitle>
          <CardDescription>Live status from the publishing scheduler.</CardDescription>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            {showWorkerButton ? (
              <Button
                size="sm"
                variant="outline"
                onClick={runWorker}
                disabled={busyId !== null}
              >
                {busyId === "worker" ? (
                  <LoaderCircle className="animate-spin" aria-hidden="true" />
                ) : null}
                Check due posts
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" onClick={load} disabled={busyId !== null}>
              Refresh
            </Button>
          </div>
          {showWorkerButton ? (
            <span className="text-[11px] text-muted-foreground">
              The worker also runs automatically.
            </span>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {showFilters && posts !== null ? (
          <div className="mb-5 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(14rem,1fr)_12rem_12rem_12rem]">
              <Input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(1);
                }}
                placeholder="Search post text or errors"
                aria-label="Search posts by text, status, platform, media, or error"
                maxLength={200}
                className="sm:col-span-2 lg:col-span-1"
              />
              <Select
                value={statusFilter}
                onValueChange={(value) => {
                  setStatusFilter((value ?? "all") as StatusFilter);
                  setPage(1);
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Filter by status"
                >
                  <SelectValue>
                    {(value) =>
                      value === "all" || value == null
                        ? "All Statuses"
                        : STATUS_LABELS[value as ScheduledPostSummary["status"]]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  {statuses.map((status) => (
                    <SelectItem key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={platformFilter}
                onValueChange={(value) => {
                  setPlatformFilter((value ?? "all") as PlatformFilter);
                  setPage(1);
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Filter by platform"
                >
                  <SelectValue>
                    {(value) =>
                      value === "all" || value == null
                        ? "All Platforms"
                        : PLATFORM_LABELS[value as ScheduledPostSummary["platform"]]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Platforms</SelectItem>
                  {PLATFORM_ORDER.map((platform) => (
                    <SelectItem key={platform} value={platform}>
                      {PLATFORM_LABELS[platform]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={sortBy}
                onValueChange={(value) => {
                  setSortBy((value ?? "date-newest") as SortOption);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Sort posts">
                  <SelectValue>
                    {(value) =>
                      ({
                        "date-newest": "Newest first",
                        "date-oldest": "Oldest first",
                        platform: "Platform A–Z",
                        status: "Status A–Z",
                        text: "Post text A–Z",
                      })[value as SortOption] ?? "Sort posts"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date-newest">Newest first</SelectItem>
                  <SelectItem value="date-oldest">Oldest first</SelectItem>
                  <SelectItem value="platform">Platform A–Z</SelectItem>
                  <SelectItem value="status">Status A–Z</SelectItem>
                  <SelectItem value="text">Post text A–Z</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {filtered.length === 0
                  ? `No posts${filtersActive ? " match these filters" : ""}`
                  : `Showing ${pagination.start}–${pagination.end} of ${filtered.length}`}
              </span>
              {filtersActive ? (
                <Button size="sm" variant="ghost" onClick={resetFilters}>
                  Clear filters
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {loadError !== null ? (
          <EmptyState
            icon={CircleAlert}
            title="Could not load posts"
            description={loadError}
            action={
              <Button size="sm" variant="outline" onClick={load}>
                Try again
              </Button>
            }
          />
        ) : posts === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={EmptyIcon}
            title={emptyTitle}
            description={
              emptyDescription ??
              "When you create a post it appears here with its current publishing status."
            }
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={EmptyIcon}
            title="No posts match the selected filters"
            description="Try a different status or platform, or reset the filters."
            action={
              <Button size="sm" variant="outline" onClick={resetFilters}>
                Reset filters
              </Button>
            }
          />
        ) : (
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-xs text-muted-foreground">Platform</TableHead>
                <TableHead className="text-xs text-muted-foreground">Post</TableHead>
                <TableHead className="text-xs text-muted-foreground">When</TableHead>
                <TableHead className="hidden text-xs text-muted-foreground md:table-cell">Media</TableHead>
                <TableHead className="text-xs text-muted-foreground">Status</TableHead>
                <TableHead className="text-right text-xs text-muted-foreground">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagination.items.map((post) => (
                <TableRow key={post.id} className="border-border/60 hover:bg-muted/40">
                  <TableCell className="whitespace-nowrap">
                    <PlatformChip platform={post.platform} showLabel />
                  </TableCell>
                  <TableCell className="max-w-[24rem]">
                    <span className="line-clamp-2 text-sm">
                      {post.text || "—"}
                    </span>
                    {post.error ? (
                      <span className="mt-1 flex items-start gap-1 text-xs text-destructive">
                        <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                        {post.error}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm tabular-nums">
                    {new Date(post.publishedAt ?? post.scheduledAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-sm text-muted-foreground md:table-cell">
                    {MEDIA_LABELS[post.mediaType]}
                  </TableCell>
                  <TableCell>
                    <PostStatusBadge status={post.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {canRetry(post) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          aria-label={`Retry publishing this ${PLATFORM_LABELS[post.platform]} post`}
                          onClick={() =>
                            void runAction(
                              post.id,
                              `/api/posts/${post.id}/retry`,
                              "Retrying publishing now.",
                            )
                          }
                        >
                          <RotateCcw aria-hidden="true" />
                          Retry Publishing
                        </Button>
                      ) : null}
                      {canReschedule(post) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busyId !== null}
                          aria-label={`Reschedule this ${PLATFORM_LABELS[post.platform]} post`}
                          onClick={() => setRescheduling(post)}
                        >
                          <CalendarClock aria-hidden="true" />
                          Reschedule
                        </Button>
                      ) : null}
                      {canCancel(post) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          disabled={busyId !== null}
                          aria-label={`Cancel this ${PLATFORM_LABELS[post.platform]} post`}
                          onClick={() => setCancelling(post)}
                        >
                          <X aria-hidden="true" />
                          Cancel
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {posts !== null && !loadError && pagination.totalPages > 1 ? (
          <nav
            aria-label="Posts pagination"
            className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4"
          >
            <span className="text-xs text-muted-foreground">
              Page {currentPage} of {pagination.totalPages}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={currentPage <= 1}
                onClick={() => setPage(currentPage - 1)}
              >
                <ChevronLeft aria-hidden="true" />
                Previous
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={currentPage >= pagination.totalPages}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </nav>
        ) : null}
      </CardContent>

      {/* Cancel is destructive: it stops a scheduled post from ever publishing. */}
      <AlertDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this post?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelling
                ? `The scheduled ${PLATFORM_LABELS[cancelling.platform]} post will not be published. This cannot be undone, but you can always create a new post.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>
              Keep post
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busyId !== null}
              onClick={() => void cancelPost()}
            >
              Cancel post
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {rescheduling ? (
        <RescheduleDialog
          key={rescheduling.id}
          post={rescheduling}
          onOpenChange={(open) => {
            if (!open) setRescheduling(null);
          }}
          onRescheduled={load}
        />
      ) : null}
    </Card>
  );
}
