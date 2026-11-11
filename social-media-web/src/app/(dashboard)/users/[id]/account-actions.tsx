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

type AccountAction =
  | "suspend"
  | "reactivate"
  | "soft_delete"
  | "restore"
  | "revoke_sessions";

interface ActionResult {
  error?: string;
  sessionsRevoked?: number;
  postsHeld?: number;
  postsResumed?: number;
  postsStillHeld?: number;
}

const CONFIRM: Record<AccountAction, { title: string; description: string; label: string }> = {
  suspend: {
    title: "Suspend this account?",
    description:
      "The user loses access immediately, active sessions are revoked, and their unclaimed scheduled posts are held.",
    label: "Suspend account",
  },
  reactivate: {
    title: "Reactivate this account?",
    description:
      "Access is restored. Future held posts return to the queue; overdue held posts stay held until explicitly rescheduled.",
    label: "Reactivate account",
  },
  soft_delete: {
    title: "Delete this account?",
    description:
      "This is a soft delete: access is revoked, scheduled posts are held, and audit history is preserved. The account is not permanently removed.",
    label: "Delete account",
  },
  restore: {
    title: "Restore this account?",
    description:
      "The account becomes active again if it was approved. Future held posts may return to the queue.",
    label: "Restore account",
  },
  revoke_sessions: {
    title: "Revoke all sessions?",
    description:
      "Every active session for this user is deleted. The user must sign in again.",
    label: "Revoke sessions",
  },
};

export function AccountActions({
  id,
  role,
  banned,
  deletedAt,
  isSelf,
}: {
  id: string;
  role: string;
  banned: boolean;
  deletedAt: string | null;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [action, setAction] = useState<AccountAction | null>(null);
  const [busy, setBusy] = useState(false);

  const isDeleted = Boolean(deletedAt);
  const isProtectedAdmin = role === "admin";

  function summary(body: ActionResult): string {
    if (action === "revoke_sessions") {
      return `${body.sessionsRevoked ?? 0} session(s) revoked.`;
    }
    if (action === "suspend" || action === "soft_delete") {
      return `${body.sessionsRevoked ?? 0} session(s) revoked, ${body.postsHeld ?? 0} post(s) held.`;
    }
    if (action === "reactivate" || action === "restore") {
      const resumed = body.postsResumed ?? 0;
      const still = body.postsStillHeld ?? 0;
      return `${resumed} post(s) resumed${still ? `, ${still} still held` : ""}.`;
    }
    return "Account updated.";
  }

  async function submit() {
    if (!action) return;
    setBusy(true);
    try {
      const revoke = action === "revoke_sessions";
      const response = await fetch(
        revoke
          ? `/api/admin/users/${encodeURIComponent(id)}/sessions`
          : `/api/admin/users/${encodeURIComponent(id)}/account`,
        revoke
          ? { method: "DELETE" }
          : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
          },
      );
      const body = (await response.json().catch(() => ({}))) as ActionResult;
      if (!response.ok) {
        toast.error(body.error ?? "Could not update the account.");
        return;
      }
      toast.success(summary(body));
      setAction(null);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update the account.",
      );
    } finally {
      setBusy(false);
    }
  }

  const buttons: { action: AccountAction; label: string; variant: "default" | "outline" | "destructive" }[] = [];
  if (isDeleted) {
    buttons.push({ action: "restore", label: "Restore", variant: "outline" });
  } else if (banned) {
    buttons.push({ action: "reactivate", label: "Reactivate", variant: "default" });
  } else {
    buttons.push({ action: "suspend", label: "Suspend", variant: "outline" });
  }

  if (!isDeleted && !isSelf && !isProtectedAdmin) {
    buttons.push({ action: "soft_delete", label: "Delete", variant: "destructive" });
  }
  if (!isDeleted && !isSelf) {
    buttons.push({ action: "revoke_sessions", label: "Revoke sessions", variant: "outline" });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {buttons.map((button) => (
          <Button
            key={button.action}
            size="sm"
            variant={button.variant}
            disabled={busy || isSelf || (isProtectedAdmin && (button.action === "suspend" || button.action === "soft_delete"))}
            onClick={() => setAction(button.action)}
          >
            {button.label}
          </Button>
        ))}
      </div>

      {isSelf ? (
        <p className="text-xs text-muted-foreground">
          You cannot suspend, delete, or revoke sessions for your own account.
        </p>
      ) : null}
      {isProtectedAdmin && !isSelf ? (
        <p className="text-xs text-muted-foreground">
          The Super Admin account cannot be suspended or deleted.
        </p>
      ) : null}

      <AlertDialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{action ? CONFIRM[action].title : ""}</AlertDialogTitle>
            <AlertDialogDescription>
              {action ? CONFIRM[action].description : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void submit()}>
              {busy ? "Working…" : action ? CONFIRM[action].label : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
