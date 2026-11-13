import Link from "next/link";
import {
  BadgeCheck,
  CalendarClock,
  ChevronRight,
  FileDown,
  Link2,
  LockKeyhole,
  Monitor,
  ShieldCheck,
  Smartphone,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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

function isMobileDevice(userAgent: string | null): boolean {
  return /Android|iPhone|iPad|iOS/.test(userAgent ?? "");
}

/** Small muted icon chip for informational/reference cards. */
function InfoIcon({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span
      className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
      aria-hidden="true"
    >
      <Icon className="size-4" />
    </span>
  );
}

/** Compact, visually quiet reference card for non-interactive information. */
function ReferenceCard({
  title,
  description,
  icon,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <Card size="sm" className="h-full gap-3">
      <CardHeader className="gap-2">
        <CardTitle className="flex items-center gap-2.5 text-sm">
          <InfoIcon icon={icon} />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {children}
      </CardContent>
    </Card>
  );
}

const QUICK_ACTIONS: Array<{
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    href: "/users",
    label: "Manage users",
    description: "Approve, suspend, and review accounts.",
    icon: UsersRound,
  },
  {
    href: "/admin/social-accounts",
    label: "Review social accounts",
    description: "Audit connected Facebook, Instagram, and LinkedIn accounts.",
    icon: Link2,
  },
  {
    href: "/admin/scheduler",
    label: "Open scheduler",
    description: "Monitor and manage scheduled posts.",
    icon: CalendarClock,
  },
];

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-xs font-medium">{label}</dt>
      <dd className="text-xs text-muted-foreground sm:text-right">{children}</dd>
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
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">
          Administration settings
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Update your profile, secure your account, and review how this console
          protects publishing. Changes to individual user accounts are made from
          the Users pages.
        </p>
      </header>

      {/* Editable settings get the strongest visual priority. */}
      <SettingsClient profile={profile} />

      <Card className="gap-0 py-0">
        <CardHeader className="gap-1 border-b px-4 py-4 lg:px-5">
          <CardTitle>Active sessions</CardTitle>
          <CardDescription>
            Every browser currently signed in as this administrator. Session
            tokens are never displayed.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Monitor className="size-5" aria-hidden="true" />
              </span>
              <p className="text-sm font-medium">No active sessions</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                You are not signed in on any device right now.
              </p>
            </div>
          ) : (
            <ul>
              {sessions.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-2 border-b px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center sm:justify-between lg:px-5"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
                        item.current
                          ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                      aria-hidden="true"
                    >
                      {isMobileDevice(item.userAgent) ? (
                        <Smartphone className="size-4" />
                      ) : (
                        <Monitor className="size-4" />
                      )}
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {device(item.userAgent)}
                          {item.current ? " (this device)" : ""}
                        </span>
                        {item.current ? (
                          <Badge className="border-transparent bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 ring-inset dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900">
                            Current session
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        Last active {dateTime(item.updatedAt)} · Expires{" "}
                        {dateTime(item.expiresAt)}
                        {item.ipAddress ? ` · ${item.ipAddress}` : ""}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
        <CardFooter className="flex-col items-start gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-5">
          <p className="text-xs text-muted-foreground">
            {otherSessions.length === 0
              ? "No other devices are signed in to this account."
              : `${otherSessions.length} other device(s) are signed in to this account.`}
          </p>
          <SessionActions otherSessionCount={otherSessions.length} />
        </CardFooter>
      </Card>

      {/* Informational reference: intentionally quieter than the editable
          settings above so the two groups read differently at a glance. */}
      <section aria-label="Administration reference" className="flex flex-col gap-3">
        <a
          href="/Social-Console-Security-Guide.pdf"
          download="Social-Console-Security-Guide.pdf"
          className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <span
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-950/50 dark:text-sky-300"
            aria-hidden="true"
          >
            <FileDown className="size-4" />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
              How this console protects your account
              <Badge
                variant="secondary"
                className="text-[10px] font-semibold uppercase tracking-wide"
              >
                PDF
              </Badge>
            </span>
            <span className="text-xs text-muted-foreground">
              Read our security and account protection guide (PDF) — it downloads
              automatically. Reference only: these policies are enforced by the
              server and cannot be changed here.
            </span>
          </span>
        </a>
        <div className="grid gap-4 md:grid-cols-2">
          <ReferenceCard
            title="Signed-in administrator"
            description="The verified server-side session for this console."
            icon={BadgeCheck}
          >
            <dl>
              <InfoRow label="Name">{profile.name}</InfoRow>
              <InfoRow label="Email">{profile.email}</InfoRow>
              <InfoRow label="Role">
                {state?.isAdmin ? "Super Admin" : state?.role}
              </InfoRow>
              <InfoRow label="Status">{statusLabel}</InfoRow>
            </dl>
          </ReferenceCard>

          <ReferenceCard
            title="Account model"
            description="Exactly one Super Admin is allowed by a database unique index."
            icon={Users}
          >
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted-foreground">
              <li>New registrations start as pending until approved.</li>
              <li>Suspension revokes sessions and holds scheduled posts.</li>
              <li>Deletion is a soft delete that preserves audit history.</li>
              <li>The Super Admin cannot be suspended or deleted.</li>
              <li>Admins cannot suspend, delete, or revoke their own sessions.</li>
            </ul>
          </ReferenceCard>

          <ReferenceCard
            title="Publishing safety"
            description="Controls that prevent duplicate or unauthorized publishing."
            icon={ShieldCheck}
          >
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted-foreground">
              <li>The worker claims due posts with row-level locks.</li>
              <li>Suspended or deleted accounts cannot claim posts.</li>
              <li>Held posts are skipped until an administrator resumes them.</li>
              <li>Overdue held posts stay held to avoid immediate duplicates.</li>
              <li>Every hold, resume, retry, and publish is activity-logged.</li>
            </ul>
          </ReferenceCard>

          <ReferenceCard
            title="Data handling"
            description="Secrets never appear in the admin console or audit trail."
            icon={LockKeyhole}
          >
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-xs text-muted-foreground">
              <li>Social tokens stay encrypted and are never displayed.</li>
              <li>Activity metadata is sanitized before it is stored.</li>
              <li>Only active users can access the application.</li>
              <li>Every admin API verifies the Super Admin server-side.</li>
            </ul>
          </ReferenceCard>
        </div>
      </section>

      <Card className="gap-0 py-0">
        <CardHeader className="gap-1 border-b px-4 py-4 lg:px-5">
          <CardTitle>Quick actions</CardTitle>
          <CardDescription>Common administration tasks.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-3 lg:p-5">
          {QUICK_ACTIONS.map((action) => (
            <Link
              key={action.href}
              href={action.href}
              className="group flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <InfoIcon icon={action.icon} />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium">{action.label}</span>
                <span className="text-xs text-muted-foreground">
                  {action.description}
                </span>
              </span>
              <ChevronRight
                className="ml-auto size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
