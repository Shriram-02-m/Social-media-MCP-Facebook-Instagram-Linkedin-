"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

  const active = Boolean(query.trim()) || status !== "all" || platform !== "all";

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Label
          htmlFor="scheduler-search"
          className="text-xs font-medium text-muted-foreground"
        >
          Search
        </Label>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply(query, status, platform);
          }}
        >
          <Input
            id="scheduler-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search owner or post text"
            aria-label="Search scheduled posts by owner or text"
            maxLength={100}
            className="min-w-0"
          />
          <Button type="submit" variant="outline" disabled={pending}>
            Search
          </Button>
        </form>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:w-[380px] lg:shrink-0">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            Status
          </Label>
          <Select
            value={status}
            onValueChange={(value) => {
              const next = value ?? "all";
              setStatus(next);
              apply(query, next, platform);
            }}
          >
            <SelectTrigger
              className="w-full"
              aria-label="Filter by post status"
            >
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
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-muted-foreground">
            Platform
          </Label>
          <Select
            value={platform}
            onValueChange={(value) => {
              const next = value ?? "all";
              setPlatform(next);
              apply(query, status, next);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Filter by platform">
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
        </div>
      </div>

      {active ? (
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          className="self-start lg:self-end"
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
  );
}
