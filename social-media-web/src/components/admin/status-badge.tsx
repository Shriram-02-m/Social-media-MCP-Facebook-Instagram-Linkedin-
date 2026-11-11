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

// Distinct, low-saturation colours keep every status readable at a glance
// without competing with the primary action colours in the table.
const POST_CLASSES: Record<AdminPostStatus, string> = {
  scheduled:
    "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300",
  publishing:
    "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  published:
    "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  failed:
    "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300",
  cancelled:
    "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
  held: "border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300",
};

export function PostStatusBadge({ status }: { status: AdminPostStatus }) {
  return (
    <Badge
      variant="outline"
      className={`px-1.5 text-[11px] ${POST_CLASSES[status]}`}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      {POST_LABELS[status]}
    </Badge>
  );
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
