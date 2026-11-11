"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
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

const STATUS_LABELS: Record<string, string> = {
  all: "All statuses",
  scheduled: "Scheduled",
  publishing: "Publishing",
  published: "Published",
  failed: "Failed",
  cancelled: "Cancelled",
  held: "Held",
};

const PLATFORM_LABELS: Record<string, string> = {
  all: "All platforms",
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
};

export function SchedulerFilters({
  initialQuery,
  initialStatus,
  initialPlatform,
}: {
  initialQuery: string;
  initialStatus: string;
  initialPlatform: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const [status, setStatus] = useState(initialStatus);
  const [platform, setPlatform] = useState(initialPlatform);

  // Preserve the date range (from/to) while changing other filters.
  function apply(nextQuery: string, nextStatus: string, nextPlatform: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    if (nextStatus !== "all") params.set("status", nextStatus);
    else params.delete("status");
    if (nextPlatform !== "all") params.set("platform", nextPlatform);
    else params.delete("platform");
    const search = params.toString();
    startTransition(() =>
      router.replace(search ? `${pathname}?${search}` : pathname),
    );
  }

  const active = query.trim() || status !== "all" || platform !== "all";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <form
        className="flex w-full gap-2 sm:max-w-sm"
        onSubmit={(event) => {
          event.preventDefault();
          apply(query, status, platform);
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search owner or post text"
          aria-label="Search scheduled posts by owner or text"
          maxLength={100}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Search
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={status}
          onValueChange={(value) => {
            const next = value ?? "all";
            setStatus(next);
            apply(query, next, platform);
          }}
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Filter by post status">
            <SelectValue>
              {(value) => STATUS_LABELS[value ?? "all"] ?? "All statuses"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={platform}
          onValueChange={(value) => {
            const next = value ?? "all";
            setPlatform(next);
            apply(query, status, next);
          }}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Filter by platform">
            <SelectValue>
              {(value) => PLATFORM_LABELS[value ?? "all"] ?? "All platforms"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(PLATFORM_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
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
              setStatus("all");
              setPlatform("all");
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
