import Image from "next/image";

// The supplied S-lettermark is 1536x1024 (3:2) with a black backdrop. Keep the
// intrinsic ratio and use object-contain everywhere so it is never cropped or
// stretched. The WebP is a lossless conversion of the original PNG.
const LOGO_SRC = "/brand/socialsuite-logo.webp";
const LOGO_WIDTH = 1536;
const LOGO_HEIGHT = 1024;

export function BrandLogo({
  compact = false,
  showName = true,
  priority = false,
  className = "",
}: {
  compact?: boolean;
  showName?: boolean;
  priority?: boolean;
  className?: string;
} = {}) {
  return (
    <span className={`flex min-w-0 items-center ${compact ? "gap-2" : "gap-3"} ${className}`}>
      <span
        className={`relative shrink-0 overflow-hidden bg-black shadow-card ring-1 ring-foreground/10 ${
          compact ? "size-8 rounded-lg" : "h-10 w-[60px] rounded-xl"
        }`}
      >
        <Image
          src={LOGO_SRC}
          alt="SocialSuite logo"
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          priority={priority}
          sizes={compact ? "32px" : "60px"}
          className="h-full w-full object-contain"
        />
      </span>
      {showName ? (
        <span className="truncate text-sm font-semibold">Social Console</span>
      ) : null}
    </span>
  );
}
