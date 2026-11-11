"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function day(value: string): string {
  return value.slice(0, 10);
}

export function DateRangeFilter({
  fromIso,
  toIso,
  defaultDays,
}: {
  fromIso: string;
  toIso: string;
  defaultDays: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [from, setFrom] = useState(day(fromIso));
  const [to, setTo] = useState(day(toIso));

  function apply(nextFrom: string, nextTo: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (nextFrom) params.set("from", nextFrom);
    else params.delete("from");
    if (nextTo) params.set("to", nextTo);
    else params.delete("to");
    params.delete("page");
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  }

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (defaultDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const defaultTo = now.toISOString().slice(0, 10);

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        apply(from, to);
      }}
    >
      <div className="flex w-full flex-col gap-1.5 sm:w-40">
        <Label
          htmlFor="admin-range-from"
          className="text-xs font-medium text-muted-foreground"
        >
          From
        </Label>
        <Input
          id="admin-range-from"
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => setFrom(event.target.value)}
          className="w-full"
        />
      </div>
      <div className="flex w-full flex-col gap-1.5 sm:w-40">
        <Label
          htmlFor="admin-range-to"
          className="text-xs font-medium text-muted-foreground"
        >
          To
        </Label>
        <Input
          id="admin-range-to"
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => setTo(event.target.value)}
          className="w-full"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending}>
          Apply
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setFrom(defaultFrom);
            setTo(defaultTo);
            apply(defaultFrom, defaultTo);
          }}
        >
          Last {defaultDays} days
        </Button>
      </div>
    </form>
  );
}
