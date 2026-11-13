import Link from "next/link";
import {
  CalendarClock,
  ChevronRight,
  FileDown,
  Link2,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAdminProfile } from "@/lib/admin-security";
import { requireAdminPage } from "@/lib/admin-page";

import { SettingsClient } from "./settings-client";

export const dynamic = "force-dynamic";

/** Small muted icon chip used by the quick action tiles. */
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

export default async function AdminSettingsPage() {
  const session = await requireAdminPage();

  const profile = await getAdminProfile(session.user.id);

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

      {/* Security guide download: the only reference content kept on the page. */}
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
