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
  status,
}: {
  status: AdminUserSummary["status"];
}) {
  if (status === "active") return <Badge variant="secondary">Active</Badge>;
  if (status === "inactive") return <Badge variant="destructive">Inactive</Badge>;
  return <Badge variant="outline">Pending</Badge>;
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
      <p className="py-8 text-center text-sm text-muted-foreground">
        No users match these filters.
      </p>
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
              <StatusBadge status={user.status} />
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
