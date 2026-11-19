// Shared post status badge for both the admin panel and the user workspace.
// Colours come from the central semantic tokens so every status stays readable
// in light/dark mode without competing with the blue primary action colour.
// (src/components/admin/status-badge.tsx re-exports from here so existing
// admin imports keep working with a single implementation.)

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

const POST_CLASSES: Record<AdminPostStatus, string> = {
  scheduled:
    "border-info/20 bg-info/10 text-info dark:border-info/30 dark:bg-info/15",
  publishing:
    "border-primary/20 bg-primary/10 text-primary dark:border-primary/30 dark:bg-primary/15",
  published:
    "border-success/20 bg-success/10 text-success dark:border-success/30 dark:bg-success/15",
  failed:
    "border-rose/20 bg-rose/10 text-rose dark:border-rose/30 dark:bg-rose/15",
  cancelled:
    "border-border bg-muted text-muted-foreground dark:bg-muted/60",
  held:
    "border-warning/20 bg-warning/10 text-warning dark:border-warning/30 dark:bg-warning/15",
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

// Semantic tint per connection state: teal is healthy, amber needs
// reconnection, rose is a live error, neutral is simply not connected.
const SOCIAL_CLASSES: Record<SocialAccountStatus, string> = {
  connected:
    "border-success/20 bg-success/10 text-success dark:border-success/30 dark:bg-success/15",
  expired:
    "border-warning/20 bg-warning/10 text-warning dark:border-warning/30 dark:bg-warning/15",
  error:
    "border-rose/20 bg-rose/10 text-rose dark:border-rose/30 dark:bg-rose/15",
  disconnected:
    "border-border bg-muted text-muted-foreground dark:bg-muted/60",
};

export function SocialStatusBadge({ status }: { status: SocialAccountStatus }) {
  return (
    <Badge
      variant="outline"
      className={`px-1.5 text-[11px] ${SOCIAL_CLASSES[status]}`}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      {SOCIAL_LABELS[status]}
    </Badge>
  );
}

const USER_STATUS_LABELS: Record<string, string> = {
  approved: "Active",
  pending: "Pending",
  rejected: "Inactive",
  suspended: "Inactive",
  deleted: "Inactive",
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
