"use client";

import {
  CalendarClock,
  CalendarDays,
  History,
  Image as ImageIcon,
  LayoutDashboard,
  Link2,
  ListChecks,
  PenSquare,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const NAV_ITEMS = [
  { title: "Overview", href: "/", icon: LayoutDashboard },
  { title: "Composer", href: "/compose", icon: PenSquare },
  { title: "Media", href: "/media", icon: ImageIcon },
  { title: "Calendar", href: "/calendar", icon: CalendarDays },
  { title: "Queue", href: "/queue", icon: ListChecks },
  { title: "History", href: "/history", icon: History },
  { title: "Accounts", href: "/accounts", icon: Link2 },
];

const ADMIN_NAV_ITEMS = [
  { title: "Overview", href: "/admin", icon: ShieldCheck, exact: true },
  { title: "Users", href: "/users", icon: Users, exact: false },
  { title: "Social Accounts", href: "/admin/social-accounts", icon: Link2, exact: false },
  { title: "Scheduler", href: "/admin/scheduler", icon: CalendarClock, exact: false },
  { title: "Settings", href: "/admin/settings", icon: Settings, exact: false },
];

function isActive(href: string, pathname: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppSidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  // The server enforces admin access on the page and APIs; this only keeps the
  // admin navigation out of the regular-user interface.
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              render={<Link href="/" />}
              tooltip="Social Console"
            >
              <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">
                SC
              </div>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate font-semibold">Social Console</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {/* Super Admins see Administration first; regular users only ever get
            the Workspace group, so their sidebar order is unchanged. */}
        {isAdmin ? (
          <SidebarGroup>
            <SidebarGroupLabel>Administration</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {ADMIN_NAV_ITEMS.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={isActive(item.href, pathname, item.exact)}
                      tooltip={item.title}
                    >
                      <item.icon />
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : null}

        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={<Link href={item.href} />}
                    isActive={isActive(item.href, pathname, item.href === "/")}
                    tooltip={item.title}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}
