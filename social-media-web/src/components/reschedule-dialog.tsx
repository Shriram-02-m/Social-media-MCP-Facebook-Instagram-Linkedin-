"use client";

import { useState } from "react";
import { toast } from "sonner";

import type { ScheduledPostSummary } from "@/components/posts-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PLATFORM_LABELS: Record<ScheduledPostSummary["platform"], string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function toLocalInputValue(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function minLocalInputValue(): string {
  const date = new Date(Date.now() + 60_000);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function RescheduleDialog({
  post,
  onOpenChange,
  onRescheduled,
}: {
  post: ScheduledPostSummary;
  onOpenChange: (open: boolean) => void;
  onRescheduled: () => void | Promise<void>;
}) {
  const [scheduledAt, setScheduledAt] = useState(() => toLocalInputValue(post.scheduledAt));
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsed = new Date(scheduledAt);
    if (Number.isNaN(parsed.getTime())) {
      toast.error("Choose a valid date and time.");
      return;
    }
    if (parsed.getTime() <= Date.now()) {
      toast.error("The new schedule time must be in the future.");
      return;
    }

    setPending(true);
    try {
      const response = await fetch(`/api/posts/${post.id}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scheduledAt: parsed.toISOString() }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        toast.error(body.error ?? "Could not reschedule the post.");
        return;
      }
      toast.success("Post rescheduled.");
      onOpenChange(false);
      await onRescheduled();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not reschedule the post.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule post</DialogTitle>
          <DialogDescription>
            Update when this {PLATFORM_LABELS[post.platform]} post is published.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Platform</span>
              <Badge variant="secondary">{PLATFORM_LABELS[post.platform]}</Badge>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-muted-foreground">Caption</span>
              <span className="line-clamp-3">{post.text || "—"}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Currently scheduled</span>
              <span>{new Date(post.scheduledAt).toLocaleString()}</span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Only the {PLATFORM_LABELS[post.platform]} scheduled post is updated. Other platforms
            keep their current schedule.
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="reschedule-at">New date and time</Label>
            <Input
              id="reschedule-at"
              type="datetime-local"
              value={scheduledAt}
              min={minLocalInputValue()}
              onChange={(event) => setScheduledAt(event.target.value)}
              required
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !scheduledAt}>
              {pending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
