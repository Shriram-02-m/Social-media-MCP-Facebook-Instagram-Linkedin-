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

export function SessionActions({ otherSessionCount }: { otherSessionCount: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function revokeOthers() {
    setBusy(true);
    try {
      const response = await fetch("/api/admin/security/sessions", {
        method: "DELETE",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        revoked?: number;
      };
      if (!response.ok) {
        toast.error(body.error ?? "Could not revoke other sessions.");
        return;
      }
      toast.success(`${body.revoked ?? 0} other session(s) signed out.`);
      setOpen(false);
      router.refresh();
    } catch {
      toast.error("Could not revoke other sessions.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={otherSessionCount === 0}
          onClick={() => setOpen(true)}
        >
          Sign out other sessions
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {otherSessionCount === 0
          ? "No other active sessions."
          : `${otherSessionCount} other active session(s).`}
      </p>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out other sessions?</AlertDialogTitle>
            <AlertDialogDescription>
              Every other browser and device signed in as this administrator will
              be signed out immediately. This session stays active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void revokeOthers()}>
              {busy ? "Signing out..." : "Sign out others"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
