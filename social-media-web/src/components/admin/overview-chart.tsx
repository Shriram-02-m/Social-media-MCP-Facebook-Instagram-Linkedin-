import type { OverviewSeriesPoint } from "@/lib/admin-overview";

function Bars({
  points,
  value,
  className,
  label,
}: {
  points: OverviewSeriesPoint[];
  value: keyof Pick<OverviewSeriesPoint, "users" | "scheduled" | "published" | "failed">;
  className: string;
  label: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex h-24 items-end gap-px" role="img" aria-label={label}>
        {points.map((point) => {
          const max = Math.max(1, ...points.map((item) => item[value]));
          const height = Math.round((point[value] / max) * 100);
          return (
            <div
              key={point.date}
              className={`min-w-0 flex-1 rounded-t-sm ${className}`}
              style={{ height: `${Math.max(point[value] > 0 ? 6 : 1, height)}%` }}
              title={`${point.date}: ${point[value]}`}
            />
          );
        })}
      </div>
    </div>
  );
}

export function OverviewChart({ series }: { series: OverviewSeriesPoint[] }) {
  // Keep the chart readable even when the admin selects a long range.
  const points = series.slice(-30);
  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Bars points={points} value="users" className="bg-sky-500/70" label="New users" />
      <Bars
        points={points}
        value="scheduled"
        className="bg-amber-500/70"
        label="Scheduled posts"
      />
      <Bars
        points={points}
        value="published"
        className="bg-emerald-500/70"
        label="Published posts"
      />
      <Bars points={points} value="failed" className="bg-destructive/70" label="Failed posts" />
    </div>
  );
}
