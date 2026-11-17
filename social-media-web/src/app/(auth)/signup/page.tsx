import { UserPlus } from "lucide-react";

import { safeRedirectPath } from "@/lib/redirects";

import { SignupForm } from "./signup-form";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);

  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 bg-background px-4 py-10 [background-image:radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklch,var(--brand)_6%,transparent),transparent)]">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-b from-brand to-brand/85 text-brand-foreground shadow-card ring-1 ring-foreground/10"
        >
          <UserPlus className="size-5" />
        </span>
        <span className="text-sm font-semibold">Social Console</span>
      </div>
      <SignupForm next={next} />
    </main>
  );
}
