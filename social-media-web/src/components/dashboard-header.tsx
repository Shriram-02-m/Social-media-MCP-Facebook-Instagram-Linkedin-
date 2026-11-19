"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";

import { BrandLogo } from "@/components/brand-logo";
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

export function DashboardHeader() {
  const pathname = usePathname();
  const items = breadcrumbItems(pathname);

  return (
    <header className="sticky top-0 z-20 flex min-h-14 min-w-0 items-center gap-3 border-b bg-background/90 px-3 backdrop-blur-sm sm:px-6">
      <SidebarTrigger aria-label="Toggle navigation" />
      <BrandLogo compact showName={false} />
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
    </header>
  );
}
