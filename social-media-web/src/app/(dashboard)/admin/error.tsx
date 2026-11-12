"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Server Component errors are intentionally masked in production (React
  // error #441): `error.message` is a generic React sentence, not the real
  // failure. Show an actionable message there, keep the real message in
  // development, and always surface the digest so server logs can be matched.
  const description =
    process.env.NODE_ENV === "production"
      ? "An unexpected error occurred while loading this administration page. Try again; if it keeps happening, quote the reference below when contacting support."
      : error.message || "An unexpected error occurred while loading this page.";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Administration data could not be loaded</CardTitle>
        <CardDescription>{description}</CardDescription>
        {error.digest ? (
          <CardDescription className="font-mono text-xs">
            Reference: {error.digest}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <Button onClick={reset}>Try again</Button>
      </CardContent>
    </Card>
  );
}
