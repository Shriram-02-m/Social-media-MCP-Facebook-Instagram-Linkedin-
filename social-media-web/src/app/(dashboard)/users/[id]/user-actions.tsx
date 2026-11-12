"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon, XIcon } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ROLE_LABELS: Record<string, string> = {
  admin: "Super Admin",
  user: "User",
};

export function UserActions({
  id,
  role,
  approvalStatus,
  isSelf,
  adminExists,
}: {
  id: string;
  role: string;
  approvalStatus: string;
  isSelf: boolean;
  adminExists: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  async function update(
    body: { approvalStatus?: "approved" | "rejected"; role?: "admin" | "user" },
    successMessage: string,
  ) {
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        toast.error(data.error ?? "Could not update the user.");
        return;
      }
      toast.success(successMessage);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not update the user.",
      );
    } finally {
      setBusy(false);
    }
  }

  const isApproved = approvalStatus === "approved";
  const isRejected = approvalStatus === "rejected";

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Registration</h3>
          <p className="text-xs text-muted-foreground">
            Approve this registration to grant access, or reject it to keep the
            account inactive.
          </p>
        </div>

        {isSelf ? (
          <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            This is your account. You cannot change your own approval status or
            role, so you cannot lock yourself out of the console.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {!isApproved ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void update({ approvalStatus: "approved" }, "User approved.")
                }
              >
                <CheckIcon aria-hidden="true" />
                Approve
              </Button>
            ) : null}
            {!isRejected ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirmReject(true)}
              >
                <XIcon aria-hidden="true" />
                Reject
              </Button>
            ) : null}
            {isApproved ? (
              <span className="text-xs text-muted-foreground">
                Registration approved.
              </span>
            ) : isRejected ? (
              <span className="text-xs text-muted-foreground">
                Registration rejected.
              </span>
            ) : null}
          </div>
        )}
      </section>

      <Separator />

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">Role</h3>
          <p className="text-xs text-muted-foreground">
            The database allows exactly one Super Admin. Promoting another
            account is only possible when no admin exists.
          </p>
        </div>
        <Select
          value={role}
          disabled={isSelf || busy}
          onValueChange={(value) => {
            if (!value || value === role) return;
            void update(
              { role: value as "admin" | "user" },
              `Role changed to ${ROLE_LABELS[value] ?? value}.`,
            );
          }}
        >
          <SelectTrigger className="w-48" aria-label="Change user role">
            <SelectValue>
              {(value) => ROLE_LABELS[value ?? role] ?? role}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">User</SelectItem>
            <SelectItem value="admin" disabled={adminExists && role !== "admin"}>
              Super Admin
            </SelectItem>
          </SelectContent>
        </Select>
      </section>

      <AlertDialog open={confirmReject} onOpenChange={setConfirmReject}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this registration?</AlertDialogTitle>
            <AlertDialogDescription>
              The account is marked inactive and cannot access the application.
              Existing records, social connections, and publishing history are
              preserved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmReject(false);
                void update({ approvalStatus: "rejected" }, "User rejected.");
              }}
            >
              Reject registration
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
