import Link from "next/link";
import { redirect } from "next/navigation";

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
  const heading = rejected ? "Registration not approved" : "Awaiting administrator approval";
  const description = rejected
    ? "This account was not approved. Contact the administrator if you believe this is a mistake."
    : "Your registration was received and is waiting for an administrator to approve it. You will be able to sign in once the account is approved.";

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
        <CardDescription>
          {description}
          {rejected || state?.deleted ? null : (
            <span className="mt-2 block text-xs text-muted-foreground">
              This page appears until approval. All console features stay locked meanwhile.
            </span>
          )}
        </CardDescription>
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
  );
}
