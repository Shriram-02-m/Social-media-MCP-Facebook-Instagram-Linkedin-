import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { SessionUnavailable } from "@/components/session-unavailable";
import { SignOutButton } from "@/components/sign-out-button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  SessionUnavailableError,
  getSession,
  readAccountState,
  type AdminSession,
} from "@/lib/session";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  let session: AdminSession | null;
  try {
    session = await getSession();
  } catch (error) {
    // A failed session lookup (database unreachable, timeout, pool exhausted)
    // is an infrastructure outage, not an invalid session. Without this catch
    // it escapes the layout - which the sibling `error.tsx` cannot wrap - and
    // Next replaces the entire app with its built-in global error page. Render
    // a retryable state instead, and never treat the outage as a logout.
    if (error instanceof SessionUnavailableError) return <SessionUnavailable />;
    throw error;
  }
  if (!session) redirect("/login");

  // Server-side account lifecycle enforcement: pending and rejected users
  // (and any lingering suspended/deleted session that was not revoked by an
  // admin action) can never render the dashboard. The Super Admin passes as
  // an approved account.
  const state = readAccountState(session);
  if (state?.deleted) redirect("/login");
  if (state?.banActive) redirect("/login");
  if (state && state.approvalStatus !== "approved") redirect("/pending");

  return (
    <SidebarProvider>
      <AppSidebar isAdmin={state?.isAdmin ?? false} />
      <SidebarInset>
        <header className="flex h-14 min-w-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <span className="hidden min-w-0 truncate text-sm text-muted-foreground sm:inline">
            {session.user.email}
          </span>
          <div className="ml-auto shrink-0">
            <SignOutButton />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 px-4 py-4 sm:gap-6 sm:p-6">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
