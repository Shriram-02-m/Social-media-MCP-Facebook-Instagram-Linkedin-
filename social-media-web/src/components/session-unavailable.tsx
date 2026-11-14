"use client";

import { CircleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Shown when the dashboard layout cannot verify the session because the
// database/authentication service is unreachable. This is deliberately not a
// redirect to /login: an outage must never look like a signed-out user.
export function SessionUnavailable() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      {/* w-full keeps the card a consistent, comfortable width: as a flex
          item it would otherwise shrink-wrap to its (narrow) content. */}
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CircleAlert className="text-destructive size-5" aria-hidden />
            Can&apos;t verify your session
          </CardTitle>
          <CardDescription>
            We couldn&apos;t reach the authentication service to confirm your
            sign-in. This is usually a temporary database problem, so your session
            has not been signed out. Try again in a moment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            onClick={() => startTransition(() => router.refresh())}
            disabled={pending}
          >
            {pending ? "Retrying..." : "Try again"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
