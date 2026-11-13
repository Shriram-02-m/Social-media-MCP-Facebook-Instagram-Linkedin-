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

function RoleBadge({ role }: { role: AdminUserSummary["role"] }) {
  return role === "admin" ? (
    <Badge>Super Admin</Badge>
  ) : (
    <Badge variant="secondary">User</Badge>
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
          <TableHead>Name</TableHead>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Created</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.map((user) => (
          <TableRow key={user.id}>
            <TableCell className="font-medium">
              {user.name}
              {user.id === currentUserId ? (
                <span className="ml-2 text-xs text-muted-foreground">(you)</span>
              ) : null}
            </TableCell>
            <TableCell className="text-muted-foreground">{user.email}</TableCell>
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
