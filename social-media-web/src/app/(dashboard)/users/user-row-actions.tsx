"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

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
      toast.success(next === "approved" ? "User approved." : "User rejected.");
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
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => void setApproval("rejected")}
        >
          Reject
        </Button>
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
