// Shared platform identity metadata. One definition keeps every table, chip,
// and label consistent across the admin panel and the user workspace; the
// tinted chips use the central blue/rose semantic tokens so they follow the
// theme in both light and dark mode.

import type { AdminPlatform } from "@/lib/admin-policy";

export const PLATFORM_META: Record<
  AdminPlatform,
  { label: string; short: string; className: string }
> = {
  facebook: {
    label: "Facebook",
    short: "f",
    className:
      "bg-primary/10 text-primary ring-primary/20 dark:bg-primary/15 dark:ring-primary/30",
  },
  instagram: {
    label: "Instagram",
    short: "ig",
    className:
      "bg-rose/10 text-rose ring-rose/20 dark:bg-rose/15 dark:ring-rose/30",
  },
  linkedin: {
    label: "LinkedIn",
    short: "in",
    className:
      "bg-info/10 text-info ring-info/20 dark:bg-info/15 dark:ring-info/30",
  },
};

export const PLATFORM_LABELS: Record<AdminPlatform, string> = Object.fromEntries(
  Object.entries(PLATFORM_META).map(([id, meta]) => [id, meta.label]),
) as Record<AdminPlatform, string>;
