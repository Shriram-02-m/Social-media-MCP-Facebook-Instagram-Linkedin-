"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";

export function PostActions({
  id,
  status,
}: {
  id: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "held";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const action = status === "scheduled" ? "hold" : status === "held" ? "resume" : null;

  if (!action) return <span className="text-xs text-muted-foreground">—</span>;

  async function submit() {
    setBusy(true);
    try {
      const response = await fetch(
        `/api/admin/scheduler/${encodeURIComponent(id)}/${action}`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        status?: string;
      };
      if (!response.ok) {
        toast.error(body.error ?? `Could not ${action} the post.`);
        return;
      }
      toast.success(
        action === "hold"
          ? "Post held. The worker will not publish it."
          : body.message ?? "Post resumed.",
      );
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not ${action} the post.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={action === "hold" ? "outline" : "default"}
        onClick={() => setOpen(true)}
      >
        {action === "hold" ? "Hold" : "Resume"}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {action === "hold" ? "Hold this post?" : "Resume this post?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {action === "hold"
                ? "The publishing worker will skip this post until it is resumed. Already-publishing posts cannot be held."
                : "The post returns to the queue at its original scheduled time. Overdue posts stay held to prevent an immediate duplicate publish; reschedule them explicitly instead."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void submit()}>
              {busy ? "Working…" : action === "hold" ? "Hold post" : "Resume post"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
