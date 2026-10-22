"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { RescheduleDialog } from "@/components/reschedule-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

export interface ScheduledPostSummary {
  id: string;
  platform: "facebook" | "instagram" | "linkedin";
  text: string;
  scheduledAt: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled";
  publishedAt?: string;
  error?: string;
  retryCount: number;
  mediaType: "none" | "image" | "video" | "carousel" | "document";
  failureStage?: "token_validation" | "image_validation" | "document_validation" | "publishing";
}

const STATUS_TONES: Record<ScheduledPostSummary["status"], "default" | "secondary" | "destructive" | "outline"> = {
  scheduled: "secondary",
  publishing: "default",
  published: "default",
  failed: "destructive",
  cancelled: "outline",
};

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
};

const PLATFORM_ORDER: ScheduledPostSummary["platform"][] = [
  "facebook",
  "instagram",
  "linkedin",
];

type StatusFilter = "all" | ScheduledPostSummary["status"];
type PlatformFilter = "all" | ScheduledPostSummary["platform"];

function canRetry(post: ScheduledPostSummary): boolean {
  return (
    post.status === "failed" &&
    post.failureStage !== undefined &&
    post.failureStage !== "publishing"
  );
}

function canReschedule(post: ScheduledPostSummary): boolean {
  return post.status === "scheduled";
}

export function PostsList({
  statuses,
  showWorkerButton = false,
  showFilters = false,
}: {
  statuses: ScheduledPostSummary["status"][];
  showWorkerButton?: boolean;
  showFilters?: boolean;
}) {
  const [posts, setPosts] = useState<ScheduledPostSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState<ScheduledPostSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>("all");

  const load = useCallback(() => {
    return fetch("/api/posts", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as {
          posts?: ScheduledPostSummary[];
          error?: string;
        };
        if (!response.ok) {
          toast.error(body.error ?? "Could not load posts.");
          return;
        }
        setPosts(body.posts ?? []);
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "Could not load posts.");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = (posts ?? []).filter((post) => statuses.includes(post.status));
  const filtered = visible.filter(
    (post) =>
      (statusFilter === "all" || post.status === statusFilter) &&
      (platformFilter === "all" || post.platform === platformFilter),
  );
  const filtersActive = statusFilter !== "all" || platformFilter !== "all";

  function resetFilters() {
    setStatusFilter("all");
    setPlatformFilter("all");
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
        toast.error(body.error ?? "Worker run failed.");
        return;
      }
      toast.success(`Processed ${body.processed ?? 0} due post(s).`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Worker run failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Posts</CardTitle>
          <CardDescription>Live status from the publishing scheduler.</CardDescription>
        </div>
        <div className="flex gap-2">
          {showWorkerButton ? (
            <Button
              size="sm"
              variant="outline"
              onClick={runWorker}
              disabled={busyId !== null}
            >
              Run worker now
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={load} disabled={busyId !== null}>
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showFilters && posts !== null ? (
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Select
                value={statusFilter}
                onValueChange={(value) =>
                  setStatusFilter((value ?? "all") as StatusFilter)
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-44"
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
                onValueChange={(value) => setPlatformFilter((value ?? "all") as PlatformFilter)}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full sm:w-40"
                  aria-label="Filter by app"
                >
                  <SelectValue>
                    {(value) =>
                      value === "all" || value == null
                        ? "All Apps"
                        : PLATFORM_LABELS[value as ScheduledPostSummary["platform"]]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Apps</SelectItem>
                  {PLATFORM_ORDER.map((platform) => (
                    <SelectItem key={platform} value={platform}>
                      {PLATFORM_LABELS[platform]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Showing {filtered.length} of {visible.length}
              </span>
              {filtersActive ? (
                <Button size="sm" variant="ghost" onClick={resetFilters}>
                  Reset
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {posts === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No posts to show.</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              No posts match the selected filters.
            </p>
            <Button size="sm" variant="outline" onClick={resetFilters}>
              Reset filters
            </Button>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Platform</TableHead>
                <TableHead>Text</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Media</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((post) => (
                <TableRow key={post.id}>
                  <TableCell className="whitespace-nowrap">
                    {PLATFORM_LABELS[post.platform]}
                  </TableCell>
                  <TableCell className="max-w-[24rem]">
                    <span className="line-clamp-2 text-sm">
                      {post.text || "—"}
                    </span>
                    {post.error ? (
                      <span className="mt-1 block text-xs text-destructive">
                        {post.error}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-sm">
                    {new Date(post.publishedAt ?? post.scheduledAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{post.mediaType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_TONES[post.status]}>{post.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {canRetry(post) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() =>
                            void runAction(post.id, `/api/posts/${post.id}/retry`, "Post retried.")
                          }
                        >
                          Retry
                        </Button>
                      ) : null}
                      {canReschedule(post) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() => setRescheduling(post)}
                        >
                          Reschedule
                        </Button>
                      ) : null}
                      {post.status === "scheduled" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busyId !== null}
                          onClick={() =>
                            void runAction(post.id, `/api/posts/${post.id}/cancel`, "Post cancelled.")
                          }
                        >
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
      </CardContent>
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
