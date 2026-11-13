// Shared platform identity metadata. One definition keeps every table, chip,
// and label consistent across the admin panel and the user workspace; the
// tinted-chip classes follow the app's dark-mode-safe status color system.

import type { AdminPlatform } from "@/lib/admin-policy";

export const PLATFORM_META: Record<
  AdminPlatform,
  { label: string; short: string; className: string }
> = {
  facebook: {
    label: "Facebook",
    short: "f",
    className:
      "bg-blue-50 text-blue-700 ring-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:ring-blue-900",
  },
  instagram: {
    label: "Instagram",
    short: "ig",
    className:
      "bg-pink-50 text-pink-700 ring-pink-200 dark:bg-pink-950/50 dark:text-pink-300 dark:ring-pink-900",
  },
  linkedin: {
    label: "LinkedIn",
    short: "in",
    className:
      "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900",
  },
};

export const PLATFORM_LABELS: Record<AdminPlatform, string> = Object.fromEntries(
  Object.entries(PLATFORM_META).map(([id, meta]) => [id, meta.label]),
) as Record<AdminPlatform, string>;
