"use client";

import Link from "next/link";
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
import { Button, buttonVariants } from "@/components/ui/button";
import type { AdminUserSummary } from "@/lib/admin-users";

export function UserRowActions({
  id,
  approvalStatus,
  isSelf,
}: {
  id: string;
  approvalStatus: AdminUserSummary["approvalStatus"];
  isSelf: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);

  async function setApproval(next: "approved" | "rejected") {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalStatus: next }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        toast.error(body.error ?? "Could not update the user.");
        return;
      }
      toast.success(
        next === "approved"
          ? "User approved. They can now sign in."
          : "User rejected. They cannot sign in.",
      );
      setRejectOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update the user.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex justify-end gap-2">
      {!isSelf && approvalStatus !== "approved" ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void setApproval("approved")}
        >
          Approve
        </Button>
      ) : null}
      {!isSelf && approvalStatus !== "rejected" ? (
        <>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() => setRejectOpen(true)}
          >
            Reject
          </Button>
          <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reject this user?</AlertDialogTitle>
                <AlertDialogDescription>
                  The account stays registered but cannot sign in. You can
                  approve it again later from this list.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy}
                  onClick={() => void setApproval("rejected")}
                >
                  {busy ? "Working…" : "Reject user"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
      <Link
        href={`/users/${id}`}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        View
      </Link>
    </div>
  );
}
