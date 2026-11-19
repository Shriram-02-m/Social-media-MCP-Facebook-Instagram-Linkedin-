import Link from "next/link";
import { redirect } from "next/navigation";
import { Clock, ShieldX } from "lucide-react";

import { BrandLogo } from "@/components/brand-logo";
import { SignOutButton } from "@/components/sign-out-button";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getSession, readAccountState } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function PendingApprovalPage() {
  const session = await getSession();
  const state = readAccountState(session);
  // Signed-in approved users have no business on the status page.
  if (state && !state.deleted && !state.banActive && state.approvalStatus === "approved") {
    redirect("/");
  }

  // With a session the page reflects that account's real status (pending or
  // rejected). Without one - e.g. right after signup, where the freshly
  // created session was discarded - the generic pending message is shown and
  // reveals nothing about any particular account.
  const rejected = state?.approvalStatus === "rejected";
  const StatusIcon = rejected ? ShieldX : Clock;
  const heading = rejected ? "Registration not approved" : "Awaiting administrator approval";
  const description = rejected
    ? "This account was not approved. Contact the administrator if you believe this is a mistake."
    : "Your registration was received and is waiting for an administrator to approve it. You will be able to sign in once the account is approved.";

  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 bg-background px-4 py-10 [background-image:radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklch,var(--brand)_6%,transparent),transparent)]">
      <BrandLogo priority />
      <Card className="w-full max-w-sm shadow-pop [--card-spacing:--spacing(6)]">
        <CardHeader className="gap-3">
          <span
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-xl border bg-muted/60 text-muted-foreground shadow-card"
          >
            <StatusIcon className="size-5" />
          </span>
          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-lg font-semibold">{heading}</CardTitle>
            <CardDescription>
              {description}
              {rejected || state?.deleted ? null : (
                <span className="mt-2 block text-xs text-muted-foreground">
                  This page appears until approval. All console features stay locked meanwhile.
                </span>
              )}
            </CardDescription>
          </div>
        </CardHeader>
        <CardFooter className="flex flex-col gap-2">
          <Link
            href="/login"
            className={buttonVariants({ variant: "outline", className: "w-full" })}
          >
            Return to sign in
          </Link>
          {session ? <SignOutButton /> : null}
        </CardFooter>
      </Card>
    </main>
  );
}
