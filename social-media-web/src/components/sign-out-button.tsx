"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onSignOut() {
    startTransition(async () => {
      await authClient.signOut();
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <Button variant="outline" size="sm" onClick={onSignOut} disabled={pending}>
      {pending ? "Signing out..." : "Sign out"}
    </Button>
  );
}
