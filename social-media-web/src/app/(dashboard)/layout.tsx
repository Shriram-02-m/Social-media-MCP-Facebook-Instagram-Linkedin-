import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { DashboardHeader } from "@/components/dashboard-header";
import { SessionUnavailable } from "@/components/session-unavailable";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
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
      <AppSidebar
        isAdmin={state?.isAdmin ?? false}
        name={session.user.name}
        email={session.user.email}
      />
      <SidebarInset>
        <DashboardHeader />
        <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4 sm:gap-6 sm:px-6 sm:py-6">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
