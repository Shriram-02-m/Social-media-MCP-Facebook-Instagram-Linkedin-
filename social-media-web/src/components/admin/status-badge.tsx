import { Badge } from "@/components/ui/badge";
import type { AdminPostStatus, SocialAccountStatus } from "@/lib/admin-policy";

const POST_LABELS: Record<AdminPostStatus, string> = {
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
  held: "Held",
};

const POST_VARIANTS: Record<
  AdminPostStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  scheduled: "outline",
  publishing: "secondary",
  published: "default",
  failed: "destructive",
  cancelled: "secondary",
  held: "outline",
};

export function PostStatusBadge({ status }: { status: AdminPostStatus }) {
  return <Badge variant={POST_VARIANTS[status]}>{POST_LABELS[status]}</Badge>;
}

const SOCIAL_LABELS: Record<SocialAccountStatus, string> = {
  connected: "Connected",
  expired: "Expired",
  error: "Error",
  disconnected: "Disconnected",
};

export function SocialStatusBadge({ status }: { status: SocialAccountStatus }) {
  if (status === "connected") return <Badge>{SOCIAL_LABELS[status]}</Badge>;
  if (status === "expired") return <Badge variant="outline">{SOCIAL_LABELS[status]}</Badge>;
  if (status === "error") return <Badge variant="destructive">{SOCIAL_LABELS[status]}</Badge>;
  return <Badge variant="secondary">{SOCIAL_LABELS[status]}</Badge>;
}

const USER_STATUS_LABELS: Record<string, string> = {
  approved: "Approved",
  pending: "Pending",
  rejected: "Rejected",
  suspended: "Suspended",
  deleted: "Deleted",
};

export function UserStatusBadge({ status }: { status: string }) {
  const label = USER_STATUS_LABELS[status] ?? status;
  if (status === "approved" || status === "connected") {
    return <Badge variant="secondary">{label}</Badge>;
  }
  if (status === "rejected" || status === "suspended" || status === "deleted") {
    return <Badge variant="destructive">{label}</Badge>;
  }
  return <Badge variant="outline">{label}</Badge>;
}
