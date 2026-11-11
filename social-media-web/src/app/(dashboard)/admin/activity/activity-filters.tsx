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

export function ActivityFiltersForm({
  initialQuery,
  initialAction,
  initialUserId,
  actions,
}: {
  initialQuery: string;
  initialAction: string;
  initialUserId: string;
  actions: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);
  const [action, setAction] = useState(initialAction || "all");
  const [userId, setUserId] = useState(initialUserId);

  function apply(nextQuery: string, nextAction: string, nextUserId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    const trimmed = nextQuery.trim();
    if (trimmed) params.set("q", trimmed);
    else params.delete("q");
    if (nextAction && nextAction !== "all") params.set("action", nextAction);
    else params.delete("action");
    const id = nextUserId.trim();
    if (id) params.set("userId", id);
    else params.delete("userId");
    const search = params.toString();
    startTransition(() =>
      router.replace(search ? `${pathname}?${search}` : pathname),
    );
  }

  const active = query.trim() || (action && action !== "all") || userId.trim();
  const options = ["all", ...actions];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <form
          className="flex w-full gap-2 sm:max-w-sm"
          onSubmit={(event) => {
            event.preventDefault();
            apply(query, action, userId);
          }}
        >
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search action, resource, or metadata"
            aria-label="Search activity logs"
            maxLength={100}
          />
          <Button type="submit" variant="outline" disabled={pending}>
            Search
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={action || "all"}
            onValueChange={(value) => {
              const next = value ?? "all";
              setAction(next);
              apply(query, next, userId);
            }}
          >
            <SelectTrigger size="sm" className="w-52" aria-label="Filter by action">
              <SelectValue>
                {(value) => (value && value !== "all" ? value : "All actions")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((value) => (
                <SelectItem key={value} value={value}>
                  {value === "all" ? "All actions" : value}
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
                setAction("all");
                setUserId("");
                apply("", "all", "");
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      <form
        className="flex w-full gap-2 sm:max-w-md"
        onSubmit={(event) => {
          event.preventDefault();
          apply(query, action, userId);
        }}
      >
        <Input
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="Filter by actor or target user id"
          aria-label="Filter activity by user id"
          maxLength={128}
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Filter user
        </Button>
      </form>
    </div>
  );
}
