import { UserSearch } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AdminUserSummary } from "@/lib/admin-users";

import { UserRowActions } from "./user-row-actions";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function RoleBadge({ role }: { role: AdminUserSummary["role"] }) {
  return role === "admin" ? (
    <Badge variant="secondary">Super Admin</Badge>
  ) : (
    <Badge variant="outline">User</Badge>
  );
}

function StatusBadge({
  user,
}: {
  user: AdminUserSummary;
}) {
  const label =
    user.status === "active"
      ? "Active"
      : user.status === "inactive"
        ? "Inactive"
        : "Pending";
  const badge =
    user.status === "active" ? (
      <Badge variant="secondary">{label}</Badge>
    ) : user.status === "inactive" ? (
      <Badge variant="destructive">{label}</Badge>
    ) : (
      <Badge variant="outline">{label}</Badge>
    );

  // Inactive covers three different lifecycle states; naming the exact reason
  // keeps Suspended and Deleted apart without changing the shared buckets.
  const reason = user.deletedAt
    ? "Deleted"
    : user.banned
      ? "Suspended"
      : user.status === "inactive"
        ? "Rejected"
        : null;

  return (
    <div className="flex flex-col gap-1">
      {badge}
      {reason ? (
        <span className="text-[11px] text-muted-foreground">{reason}</span>
      ) : null}
    </div>
  );
}

export function UsersTable({
  users,
  currentUserId,
}: {
  users: AdminUserSummary[];
  currentUserId: string;
}) {
  if (users.length === 0) {
    return (
      <EmptyState
        icon={UserSearch}
        title="No users match these filters"
        description="Try a different search term, status, or role filter."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-xs font-medium text-muted-foreground">
            Name
          </TableHead>
          <TableHead className="text-xs font-medium text-muted-foreground">
            Role
          </TableHead>
          <TableHead className="text-xs font-medium text-muted-foreground">
            Status
          </TableHead>
          <TableHead className="text-xs font-medium text-muted-foreground">
            Created
          </TableHead>
          <TableHead className="text-right text-xs font-medium text-muted-foreground">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="whitespace-normal">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-semibold text-muted-foreground"
                >
                  {initials(user.name)}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">
                    {user.name}
                    {user.id === currentUserId ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        (you)
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </div>
              </div>
            </TableCell>
            <TableCell>
              <RoleBadge role={user.role} />
            </TableCell>
            <TableCell>
              <StatusBadge user={user} />
            </TableCell>
            <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
              {dateFormatter.format(new Date(user.createdAt))}
            </TableCell>
            <TableCell className="text-right">
              <UserRowActions
                id={user.id}
                approvalStatus={user.approvalStatus}
                isSelf={user.id === currentUserId}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
