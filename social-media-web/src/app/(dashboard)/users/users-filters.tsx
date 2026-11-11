"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const APPROVAL_LABELS: Record<string, string> = {
  all: "All statuses",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
};

const ROLE_LABELS: Record<string, string> = {
  all: "All roles",
  admin: "Super Admin",
  user: "User",
};

export function UsersFilters({
  initialQuery,
  initialApproval,
  initialRole,
}: {
  initialQuery: string;
  initialApproval: string;
  initialRole: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const [approval, setApproval] = useState(initialApproval);
  const [role, setRole] = useState(initialRole);

  function apply(nextQuery: string, nextApproval: string, nextRole: string) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextApproval !== "all") params.set("approval", nextApproval);
    if (nextRole !== "all") params.set("role", nextRole);
    const search = params.toString();
    startTransition(() =>
      router.replace(search ? `${pathname}?${search}` : pathname),
    );
  }

  const filtersActive =
    query.trim().length > 0 || approval !== "all" || role !== "all";

  function reset() {
    setQuery("");
    setApproval("all");
    setRole("all");
    apply("", "all", "all");
  }

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <form
        className="flex w-full gap-2 sm:max-w-sm"
        onSubmit={(event) => {
          event.preventDefault();
          apply(query, approval, role);
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search name or email"
          aria-label="Search users by name or email"
          maxLength={100}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Search
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={approval}
          onValueChange={(value) => {
            const next = value ?? "all";
            setApproval(next);
            apply(query, next, role);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            aria-label="Filter by approval status"
          >
            <SelectValue>
              {(value) => APPROVAL_LABELS[value ?? "all"] ?? "All statuses"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(APPROVAL_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={role}
          onValueChange={(value) => {
            const next = value ?? "all";
            setRole(next);
            apply(query, approval, next);
          }}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Filter by role">
            <SelectValue>
              {(value) => ROLE_LABELS[value ?? "all"] ?? "All roles"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(ROLE_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filtersActive ? (
          <Button size="sm" variant="ghost" onClick={reset} disabled={pending}>
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}
