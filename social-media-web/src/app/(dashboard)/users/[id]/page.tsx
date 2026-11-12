import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdminPage } from "@/lib/admin-page";
import { getAdminUserContext } from "@/lib/admin-accounts";
import { PostStatusBadge, SocialStatusBadge } from "@/components/admin/status-badge";

import { AccountActions } from "./account-actions";
import { UserActions } from "./user-actions";

export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function dateTime(value: string | null): string {
  if (!value) return "—";
  return dateTimeFormatter.format(new Date(value));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function UserDetailPage(props: PageProps<"/users/[id]">) {
  const session = await requireAdminPage();
  const { id } = await props.params;
  const context = await getAdminUserContext(id);
  if (!context) notFound();
  const { detail, connections, posts } = context;

  return (
    <>
      <div>
        <Link
          href="/users"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowLeft />
          Back to users
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{detail.name}</h1>
          {detail.status === "active" ? (
            <Badge variant="secondary">Active</Badge>
          ) : detail.status === "inactive" ? (
            <Badge variant="destructive">Inactive</Badge>
          ) : (
            <Badge variant="outline">Pending</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{detail.email}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Account details</CardTitle>
            <CardDescription>
              Stored in the Better Auth user table; no duplicate user records are
              created.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Field label="Role">
                {detail.role === "admin" ? (
                  <Badge>Super Admin</Badge>
                ) : (
                  <Badge variant="secondary">User</Badge>
                )}
              </Field>
              <Field label="Status">
                {detail.status === "active" ? (
                  <Badge variant="secondary">Active</Badge>
                ) : detail.status === "inactive" ? (
                  <Badge variant="destructive">Inactive</Badge>
                ) : (
                  <Badge variant="outline">Pending</Badge>
                )}
              </Field>
              <Field label="Email verified">
                {detail.emailVerified ? "Yes" : "No"}
              </Field>
              <Field label="Password login">
                {detail.hasPassword ? "Configured" : "Not configured"}
              </Field>
              <Field label="Created">{dateTime(detail.createdAt)}</Field>
              <Field label="Last updated">{dateTime(detail.updatedAt)}</Field>
              <Field label="Active sessions">{detail.sessionCount}</Field>
              <Field label="Suspended">{detail.banned ? "Yes" : "No"}</Field>
              {detail.banned ? (
                <>
                  <Field label="Suspension reason">{detail.banReason ?? "—"}</Field>
                  <Field label="Suspension expires">{dateTime(detail.banExpires)}</Field>
                </>
              ) : null}
              <Field label="Deleted">{detail.deletedAt ? dateTime(detail.deletedAt) : "No"}</Field>
            </dl>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Status & role</CardTitle>
              <CardDescription>
                Status and role changes are authorized on the server and
                recorded in the activity log.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <UserActions
                id={detail.id}
                role={detail.role}
                approvalStatus={detail.approvalStatus}
                isSelf={detail.id === session.user.id}
                adminExists
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Account controls</CardTitle>
              <CardDescription>
                Suspend, reactivate, soft-delete, or revoke sessions. Suspended
                and deleted accounts cannot publish scheduled posts.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AccountActions
                id={detail.id}
                role={detail.role}
                banned={detail.banned}
                deletedAt={detail.deletedAt}
                isSelf={detail.id === session.user.id}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Social connections</CardTitle>
          <CardDescription>
            Connection metadata only. Access tokens are encrypted and never
            exposed in this console.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {connections.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              This user has not connected a social account.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last sync</TableHead>
                    <TableHead>Token expiry</TableHead>
                    <TableHead>Pages</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connections.map((connection) => (
                    <TableRow key={`${connection.userId}:${connection.platform}`}>
                      <TableCell className="capitalize">
                        {connection.platform}
                      </TableCell>
                      <TableCell>
                        {connection.accountName ?? connection.accountId ?? "—"}
                      </TableCell>
                      <TableCell>
                        <SocialStatusBadge status={connection.status} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {dateTime(connection.lastSyncAt)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {connection.expiresAt ? dateTime(connection.expiresAt) : "No expiry"}
                        {connection.expired ? (
                          <span className="ml-1 text-destructive">(expired)</span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {connection.pageCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent scheduled posts</CardTitle>
          <CardDescription>
            The most recent 20 posts for this account, including publishing
            history and failure details.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {posts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              This user has no scheduled posts.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Post</TableHead>
                    <TableHead>Platform</TableHead>
                    <TableHead>Scheduled</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Retries</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {posts.map((post) => (
                    <TableRow key={post.id}>
                      <TableCell className="max-w-64">
                        <span className="text-sm">{post.textPreview}</span>
                      </TableCell>
                      <TableCell className="capitalize">{post.platform}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {dateTime(post.scheduledAt)}
                        {post.publishedAt ? (
                          <span className="block text-xs">
                            Published {dateTime(post.publishedAt)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <PostStatusBadge status={post.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {post.retryCount}
                      </TableCell>
                      <TableCell className="max-w-56 text-sm text-muted-foreground">
                        {post.error ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
