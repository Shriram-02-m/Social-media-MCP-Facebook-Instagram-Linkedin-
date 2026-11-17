// Shared clickable summary card used by the admin overview and the Users
// directory. Keeping one implementation guarantees the same typography,
// spacing, and hover treatment on both screens.

import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export function StatCard({
  label,
  description,
  href,
  indicator,
  value,
  attention,
}: {
  label: string;
  description: string;
  href: string;
  /** Tailwind background class for the small colored dot. */
  indicator: string;
  value: number;
  /** Extra card classes applied only when the value needs attention. */
  attention?: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card
        className={`h-full shadow-card transition-colors group-hover:bg-muted/50 ${attention ?? ""}`}
      >
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <span
              className={`size-2 rounded-full ${indicator}`}
              aria-hidden="true"
            />
            {label}
          </CardDescription>
          <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">{description}</p>
        </CardContent>
      </Card>
    </Link>
  );
}
