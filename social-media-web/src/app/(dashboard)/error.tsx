"use client";

import { CircleAlert } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Route-level error boundary for the authenticated dashboard. It catches an
// unexpected server-render failure in a page (for example a backend/query
// error) so the user sees a recoverable message instead of Next's built-in 500
// page. The server forwards only a generic message plus `digest` in production;
// the digest matches the corresponding server log entry.
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleAlert className="text-destructive size-5" aria-hidden />
            This page couldn&apos;t load
          </CardTitle>
          <CardDescription>
            A server error interrupted loading this page. Try again; if it keeps
            happening, give the error reference below to an administrator.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error.digest ? (
            <p className="text-muted-foreground text-xs">
              Error reference:{" "}
              <code className="font-mono break-all">{error.digest}</code>
            </p>
          ) : null}
          <Button onClick={() => retry()}>Try again</Button>
        </CardContent>
      </Card>
    </div>
  );
}
