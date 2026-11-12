"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  KeyRoundIcon,
  PauseCircleIcon,
  PlayCircleIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
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
import { Separator } from "@/components/ui/separator";

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
    title: "Soft delete this account?",
    description:
      "Access is revoked, scheduled posts are held, and audit history is preserved. The account is not permanently removed and can be restored later.",
    label: "Soft delete account",
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

const STATUS_ACTIONS = {
  suspend: {
    label: "Suspend account",
    icon: PauseCircleIcon,
    description:
      "Temporarily block access. Sessions are revoked and unclaimed scheduled posts are held.",
  },
  reactivate: {
    label: "Reactivate account",
    icon: PlayCircleIcon,
    description:
      "Restore access for a suspended account and return future held posts to the queue.",
  },
  restore: {
    label: "Restore account",
    icon: RotateCcwIcon,
    description:
      "Undo the soft delete. The account becomes active again if it was approved.",
  },
} as const;

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
  const statusAction: keyof typeof STATUS_ACTIONS = isDeleted
    ? "restore"
    : banned
      ? "reactivate"
      : "suspend";
  const statusMeta = STATUS_ACTIONS[statusAction];
  const StatusIcon = statusMeta.icon;

  const canRevokeSessions = !isDeleted && !isSelf;
  const canSoftDelete = !isDeleted && !isSelf && !isProtectedAdmin;
  const statusDisabled =
    busy || isSelf || (isProtectedAdmin && statusAction === "suspend");

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

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Account status</h3>
          <p className="text-xs text-muted-foreground">
            {statusMeta.description}
          </p>
        </div>
        <div>
          <Button
            size="sm"
            variant={statusAction === "reactivate" ? "default" : "outline"}
            disabled={statusDisabled}
            onClick={() => setAction(statusAction)}
          >
            <StatusIcon aria-hidden="true" />
            {statusMeta.label}
          </Button>
        </div>
      </section>

      {canRevokeSessions ? (
        <>
          <Separator />
          <section className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Account security</h3>
              <p className="text-xs text-muted-foreground">
                Sign this user out of every browser. They must authenticate
                again to regain access.
              </p>
            </div>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setAction("revoke_sessions")}
              >
                <KeyRoundIcon aria-hidden="true" />
                Revoke sessions
              </Button>
            </div>
          </section>
        </>
      ) : null}

      {canSoftDelete ? (
        <>
          <Separator />
          <section className="flex flex-col gap-2.5">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">Account management</h3>
              <p className="text-xs text-muted-foreground">
                Soft delete removes access while keeping the user record, social
                connections, and publishing history for audit purposes.
              </p>
            </div>
            <div>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setAction("soft_delete")}
              >
                <Trash2Icon aria-hidden="true" />
                Soft delete account
              </Button>
            </div>
          </section>
        </>
      ) : null}

      {isSelf ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          You cannot suspend, delete, or revoke sessions for your own account.
        </p>
      ) : null}
      {isProtectedAdmin && !isSelf ? (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
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
            <AlertDialogAction
              variant={action === "soft_delete" ? "destructive" : "default"}
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? "Working…" : action ? CONFIRM[action].label : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
