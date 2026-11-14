// Official platform brand logo tiles for the Overview "Connected accounts"
// rows. Glyph paths are the exact official marks from Font Awesome Free 6.7.2
// brands (https://fontawesome.com, CC BY 4.0), fetched from the upstream
// Font Awesome repository — inlined here so no runtime dependency is needed.
// Each tile keeps its recognizable brand color in both light and dark mode.

import type { ReactNode } from "react";

import { cn } from "cn";

import type { AdminPlatform } from "@/lib/admin-policy";

const PLATFORM_LOGO_META: Record<
  AdminPlatform,
  { tileClass: string; viewBox: string; glyph: ReactNode }
> = {
  facebook: {
    tileClass: "bg-[#0866FF]",
    viewBox: "0 0 320 512",
    glyph: (
      <path d="M80 299.3V512H196V299.3h86.5l18-97.8H196V166.9c0-51.7 20.3-71.5 72.7-71.5c16.3 0 29.4 .4 37 1.2V7.9C291.4 4 256.4 0 236.2 0C129.3 0 80 50.5 80 159.4v42.1H14v97.8H80z" />
    ),
  },
  instagram: {
    // Approximation of the official Instagram app-icon gradient.
    tileClass:
      "bg-[radial-gradient(circle_at_30%_110%,#fdf497_0%,#fd5949_45%,#d6249f_60%,#285AEB_90%)]",
    viewBox: "0 0 448 512",
    glyph: (
      <path d="M224.1 141c-63.6 0-114.9 51.3-114.9 114.9s51.3 114.9 114.9 114.9S339 319.5 339 255.9 287.7 141 224.1 141zm0 189.6c-41.1 0-74.7-33.5-74.7-74.7s33.5-74.7 74.7-74.7 74.7 33.5 74.7 74.7-33.6 74.7-74.7 74.7zm146.4-194.3c0 14.9-12 26.8-26.8 26.8-14.9 0-26.8-12-26.8-26.8s12-26.8 26.8-26.8 26.8 12 26.8 26.8zm76.1 27.2c-1.7-35.9-9.9-67.7-36.2-93.9-26.2-26.2-58-34.4-93.9-36.2-37-2.1-147.9-2.1-184.9 0-35.8 1.7-67.6 9.9-93.9 36.1s-34.4 58-36.2 93.9c-2.1 37-2.1 147.9 0 184.9 1.7 35.9 9.9 67.7 36.2 93.9s58 34.4 93.9 36.2c37 2.1 147.9 2.1 184.9 0 35.9-1.7 67.7-9.9 93.9-36.2 26.2-26.2 34.4-58 36.2-93.9 2.1-37 2.1-147.8 0-184.8zM398.8 388c-7.8 19.6-22.9 34.7-42.6 42.6-29.5 11.7-99.5 9-132.1 9s-102.7 2.6-132.1-9c-19.6-7.8-34.7-22.9-42.6-42.6-11.7-29.5-9-99.5-9-132.1s-2.6-102.7 9-132.1c7.8-19.6 22.9-34.7 42.6-42.6 29.5-11.7 99.5-9 132.1-9s102.7-2.6 132.1 9c19.6 7.8 34.7 22.9 42.6 42.6 11.7 29.5 9 99.5 9 132.1s2.7 102.7-9 132.1z" />
    ),
  },
  linkedin: {
    tileClass: "bg-[#0A66C2]",
    viewBox: "0 0 448 512",
    glyph: (
      <path d="M100.28 448H7.4V148.9h92.88zM53.79 108.1C24.09 108.1 0 83.5 0 53.8a53.79 53.79 0 0 1 107.58 0c0 29.7-24.1 54.3-53.79 54.3zM447.9 448h-92.68V302.4c0-34.7-.7-79.2-48.29-79.2-48.29 0-55.69 37.7-55.69 76.7V448h-92.78V148.9h89.08v40.8h1.3c12.4-23.5 42.69-48.3 87.88-48.3 94 0 111.28 61.9 111.28 142.3V448z" />
    ),
  },
};

export function PlatformLogo({
  platform,
  className,
}: {
  platform: AdminPlatform;
  className?: string;
}) {
  const meta = PLATFORM_LOGO_META[platform];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg",
        meta.tileClass,
        className,
      )}
    >
      {/* Height-driven sizing: every glyph's viewBox is 512 tall, so a fixed
          height with auto width preserves each mark's true aspect ratio
          (equivalent to object-fit: contain) and keeps the three logos at a
          consistent cap height, centered by the flex tile. */}
      <svg
        viewBox={meta.viewBox}
        fill="currentColor"
        className="h-5 w-auto text-white"
      >
        {meta.glyph}
      </svg>
    </span>
  );
}
