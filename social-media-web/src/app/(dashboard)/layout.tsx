import { redirect } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { getSession, readAccountState } from "@/lib/session";

export default async function DashboardLayout({ children }: LayoutProps<"/">) {
  const session = await getSession();
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
        <header className="flex h-14 items-center gap-2 border-b px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-5" />
          <span className="text-sm text-muted-foreground">
            {session.user.email}
          </span>
          <div className="ml-auto">
            <SignOutButton />
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-6 p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
