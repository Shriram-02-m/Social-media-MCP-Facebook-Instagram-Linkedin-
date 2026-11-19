import { BrandLogo } from "@/components/brand-logo";
import { Skeleton } from "@/components/ui/skeleton";

// Shared loading state for every dashboard route that does not define its own
// (the admin section has a more specific skeleton). It mirrors the usual page
// rhythm — header, optional stat row, then content cards — so navigation does
// not flash an empty screen while a server page resolves.
export default function DashboardLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading page">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <BrandLogo compact showName={false} />
          <Skeleton className="h-8 w-56" />
        </div>
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="flex flex-col gap-6">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
