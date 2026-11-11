import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdminPage } from "@/lib/admin-page";
import { readAccountState } from "@/lib/session";

export const dynamic = "force-dynamic";

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

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Administration settings</h1>
        <p className="text-sm text-muted-foreground">
          Read-only summary of the security model that protects this console.
          Changes to individual accounts are made from the Users pages.
        </p>
      </div>

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
              <Row label="Name">{session.user.name}</Row>
              <Row label="Email">{session.user.email}</Row>
              <Row label="Role">{state?.isAdmin ? "Super Admin" : state?.role}</Row>
              <Row label="Approval">{state?.approvalStatus}</Row>
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
              <li>Only approved users can access the application.</li>
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
          <Link
            href="/admin/activity"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Review activity logs
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
