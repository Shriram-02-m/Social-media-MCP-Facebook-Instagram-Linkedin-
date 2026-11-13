import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  getAdminProfile,
  listAdminSessions,
} from "@/lib/admin-security";
import { requireAdminPage } from "@/lib/admin-page";
import { classifyUserStatus } from "@/lib/admin-user-status";
import { readAccountState } from "@/lib/session";

import { SessionActions } from "./session-actions";
import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function dateTime(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

function device(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Unknown";
  const os = /Windows/.test(userAgent)
    ? "Windows"
    : /Mac OS X|Macintosh/.test(userAgent)
      ? "macOS"
      : /Android/.test(userAgent)
        ? "Android"
        : /iPhone|iPad|iOS/.test(userAgent)
          ? "iOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-sm text-muted-foreground">{children}</dd>
    </div>
  );
}

export default async function AdminSettingsPage() {
  const session = await requireAdminPage();
  const state = readAccountState(session);
  const status = state
    ? classifyUserStatus({
        approvalStatus: state.approvalStatus,
        banned: state.banActive,
        deleted: state.deleted,
      })
    : null;
  const statusLabel = status
    ? `${status.charAt(0).toUpperCase()}${status.slice(1)}`
    : "Unknown";

  const [profile, sessions] = await Promise.all([
    getAdminProfile(session.user.id),
    listAdminSessions(session.user.id, session.session.id),
  ]);

  const otherSessions = sessions.filter((item) => !item.current);

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Administration settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your profile and password. Changes to individual accounts are
          made from the Users pages.
        </p>
      </div>

      <SettingsClient profile={profile} />

      <Card>
        <CardHeader>
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Every browser currently signed in as this administrator. Session
            tokens are never displayed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-3">
            {sessions.map((item) => (
              <li
                key={item.id}
                className="flex flex-col gap-2 border-b pb-3 last:border-b-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{device(item.userAgent)}</span>
                    {item.current ? <Badge variant="secondary">This device</Badge> : null}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    Last active {dateTime(item.updatedAt)} · Expires {dateTime(item.expiresAt)}
                    {item.ipAddress ? ` · ${item.ipAddress}` : ""}
                  </span>
                </div>
              </li>
            ))}
            {sessions.length === 0 ? (
              <li className="text-sm text-muted-foreground">No active sessions.</li>
            ) : null}
          </ul>
          <SessionActions otherSessionCount={otherSessions.length} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Signed-in administrator</CardTitle>
            <CardDescription>
              The verified server-side session for this console.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl>
              <Row label="Name">{profile.name}</Row>
              <Row label="Email">{profile.email}</Row>
              <Row label="Role">{state?.isAdmin ? "Super Admin" : state?.role}</Row>
              <Row label="Status">{statusLabel}</Row>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Account model</CardTitle>
            <CardDescription>
              Exactly one Super Admin is allowed by a database unique index.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex list-disc flex-col gap-2 pl-4 text-sm text-muted-foreground">
              <li>New registrations start as pending until approved.</li>
              <li>Suspension revokes sessions and holds scheduled posts.</li>
              <li>Deletion is a soft delete that preserves audit history.</li>
              <li>The Super Admin cannot be suspended or deleted.</li>
              <li>Admins cannot suspend, delete, or revoke their own sessions.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Publishing safety</CardTitle>
            <CardDescription>
              Controls that prevent duplicate or unauthorized publishing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex list-disc flex-col gap-2 pl-4 text-sm text-muted-foreground">
              <li>The worker claims due posts with row-level locks.</li>
              <li>Suspended or deleted accounts cannot claim posts.</li>
              <li>Held posts are skipped until an administrator resumes them.</li>
              <li>Overdue held posts stay held to avoid immediate duplicates.</li>
              <li>Every hold, resume, retry, and publish is activity-logged.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data handling</CardTitle>
            <CardDescription>
              Secrets never appear in the admin console or audit trail.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex list-disc flex-col gap-2 pl-4 text-sm text-muted-foreground">
              <li>Social tokens stay encrypted and are never displayed.</li>
              <li>Activity metadata is sanitized before it is stored.</li>
              <li>Only active users can access the application.</li>
              <li>Every admin API verifies the Super Admin server-side.</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Quick links</CardTitle>
          <CardDescription>Common administration tasks.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Link href="/users" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Manage users
          </Link>
          <Link
            href="/admin/social-accounts"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Review social accounts
          </Link>
          <Link
            href="/admin/scheduler"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Open scheduler
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
