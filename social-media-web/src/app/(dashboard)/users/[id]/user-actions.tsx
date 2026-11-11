"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

  return (
    <div className="flex flex-col gap-4">
      {isSelf ? (
        <p className="text-sm text-muted-foreground">
          This is your account. You cannot change your own role or approval
          status, so you cannot lock yourself out of the console.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {approvalStatus !== "approved" ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void update({ approvalStatus: "approved" }, "User approved.")}
            >
              Approve
            </Button>
          ) : null}
          {approvalStatus !== "rejected" ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void update({ approvalStatus: "rejected" }, "User rejected.")}
            >
              Reject
            </Button>
          ) : null}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Role</span>
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
        <p className="text-xs text-muted-foreground">
          The database allows exactly one Super Admin. Promoting another account
          is only possible when no admin exists.
        </p>
      </div>
    </div>
  );
}
