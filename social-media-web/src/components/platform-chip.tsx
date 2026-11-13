// Shared platform identity chip. One visual for Facebook / Instagram /
// LinkedIn everywhere (admin tables, workspace lists, calendar, overview).

import { cn } from "cn";

import { PLATFORM_META } from "@/lib/platform-meta";
import type { AdminPlatform } from "@/lib/admin-policy";

export function PlatformChip({
  platform,
  showLabel = false,
  size = "sm",
  className,
}: {
  platform: AdminPlatform;
  showLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = PLATFORM_META[platform];
  const chip = (
    <span
      aria-hidden={showLabel ? undefined : "true"}
      title={showLabel ? undefined : meta.label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full font-semibold lowercase ring-1",
        size === "sm" ? "size-[18px] text-[8px]" : "size-6 text-[9px]",
        meta.className,
        className,
      )}
    >
      {meta.short}
    </span>
  );

  if (!showLabel) return chip;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {chip}
      <span className="truncate">{meta.label}</span>
    </span>
  );
}
