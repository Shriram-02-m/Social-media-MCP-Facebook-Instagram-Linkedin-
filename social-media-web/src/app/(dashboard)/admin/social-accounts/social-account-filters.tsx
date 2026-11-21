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

const PLATFORM_LABELS: Record<string, string> = {
  all: "All platforms",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

const STATUS_LABELS: Record<string, string> = {
  all: "All statuses",
  connected: "Connected",
  expired: "Expired",
  error: "Error",
  disconnected: "Disconnected",
};

export function SocialAccountFilters({
  initialQuery,
  initialPlatform,
  initialStatus,
}: {
  initialQuery: string;
  initialPlatform: string;
  initialStatus: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const [platform, setPlatform] = useState(initialPlatform);
  const [status, setStatus] = useState(initialStatus);

  const optionItemClassName =
    "text-popover-foreground hover:bg-neutral-200 hover:text-popover-foreground focus:bg-neutral-200 focus:text-popover-foreground data-[highlighted]:bg-neutral-200 data-[highlighted]:text-popover-foreground data-[selected]:text-popover-foreground dark:hover:bg-neutral-800 dark:focus:bg-neutral-800 dark:data-[highlighted]:bg-neutral-800 not-data-[variant=destructive]:hover:**:text-popover-foreground not-data-[variant=destructive]:focus:**:text-popover-foreground not-data-[variant=destructive]:data-[highlighted]:**:text-popover-foreground";
  const triggerClassName =
    "w-40 hover:bg-transparent dark:hover:bg-transparent focus-visible:border-input focus-visible:ring-0 focus-visible:ring-offset-0";

  function apply(nextQuery: string, nextPlatform: string, nextStatus: string) {
    const params = new URLSearchParams();
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    if (nextPlatform !== "all") params.set("platform", nextPlatform);
    if (nextStatus !== "all") params.set("status", nextStatus);
    const search = params.toString();
    startTransition(() =>
      router.replace(search ? `${pathname}?${search}` : pathname),
    );
  }

  const active = query.trim() || platform !== "all" || status !== "all";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <form
        className="flex w-full gap-2 sm:max-w-sm"
        onSubmit={(event) => {
          event.preventDefault();
          apply(query, platform, status);
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search owner name or email"
          aria-label="Search social accounts by owner name or email"
          maxLength={100}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Search
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={platform}
          onValueChange={(value) => {
            const next = value ?? "all";
            setPlatform(next);
            apply(query, next, status);
          }}
        >
          <SelectTrigger size="sm" className={triggerClassName} aria-label="Filter by platform">
            <SelectValue>
              {(value) => PLATFORM_LABELS[value ?? "all"] ?? "All platforms"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value} className={optionItemClassName}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={status}
          onValueChange={(value) => {
            const next = value ?? "all";
            setStatus(next);
            apply(query, platform, next);
          }}
        >
          <SelectTrigger size="sm" className={triggerClassName} aria-label="Filter by connection status">
            <SelectValue>
              {(value) => STATUS_LABELS[value ?? "all"] ?? "All statuses"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value} className={optionItemClassName}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {active ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setQuery("");
              setPlatform("all");
              setStatus("all");
              apply("", "all", "all");
            }}
          >
            Reset
          </Button>
        ) : null}
      </div>
    </div>
  );
}
