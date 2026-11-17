"use client";

import {
  ChevronDown,
  LogOut,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";

const ROUTE_LABELS: Record<string, string> = {
  accounts: "Accounts",
  admin: "Administration",
  calendar: "Calendar",
  compose: "Composer",
  history: "History",
  media: "Media Library",
  queue: "Queue",
  scheduler: "Scheduler",
  settings: "Settings",
  "social-accounts": "Social accounts",
  users: "Users",
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

function routeTitle(pathname: string): string {
  if (pathname === "/") return "Overview";
  if (pathname === "/admin") return "Admin overview";
  if (/^\/users\/[^/]+$/.test(pathname)) return "User details";

  const lastSegment = pathname.split("/").filter(Boolean).at(-1) ?? "";
  return ROUTE_LABELS[lastSegment] ?? "Overview";
}

function breadcrumbItems(pathname: string): { label: string; href?: string }[] {
  const title = routeTitle(pathname);
  if (pathname === "/") return [{ label: title }];
  if (pathname === "/admin") {
    return [{ label: title }];
  }
  if (pathname.startsWith("/admin/")) {
    return [
      { label: "Administration", href: "/admin" },
      { label: title },
    ];
  }
  if (pathname.startsWith("/users/")) {
    return [
      { label: "Administration", href: "/admin" },
      { label: "Users", href: "/users" },
      { label: title },
    ];
  }
  return [{ label: "Workspace", href: "/" }, { label: title }];
}

export function DashboardHeader({
  name,
  email,
  isAdmin,
}: {
  name: string;
  email: string;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const displayName = name.trim() || email;

  function signOut() {
    startTransition(async () => {
      await authClient.signOut();
      router.replace("/login");
      router.refresh();
    });
  }

  const items = breadcrumbItems(pathname);

  return (
    <header className="sticky top-0 z-20 flex min-h-14 min-w-0 items-center gap-3 border-b bg-background/90 px-3 backdrop-blur-sm sm:px-6">
      <SidebarTrigger aria-label="Toggle navigation" />
      <Separator orientation="vertical" className="hidden h-5 sm:block" />
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap gap-1 text-[13px]">
          {items.map((item, index) => (
            <Fragment key={`${item.label}-${index}`}>
              {index > 0 ? <BreadcrumbSeparator /> : null}
              <BreadcrumbItem className="min-w-0 truncate">
                {index === items.length - 1 ? (
                  <BreadcrumbPage className="truncate font-medium">
                    {item.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link href={item.href ?? "/"} />}>
                    {item.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="h-9 gap-2 px-2"
                aria-label={`Open profile menu for ${displayName}`}
              />
            }
          >
            <span
              aria-hidden="true"
              className="flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground"
            >
              {initials(displayName)}
            </span>
            <span className="hidden max-w-40 truncate text-sm font-medium sm:inline">
              {displayName}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {displayName}
              </span>
              <span className="truncate text-xs font-normal text-muted-foreground">
                {email}
              </span>
            </DropdownMenuLabel>
            {isAdmin ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem render={<Link href="/admin/settings" />}>
                  <Settings aria-hidden="true" />
                  Administration settings
                </DropdownMenuItem>
              </>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={pending}
              onClick={signOut}
            >
              <LogOut aria-hidden="true" />
              {pending ? "Signing out…" : "Sign out"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
