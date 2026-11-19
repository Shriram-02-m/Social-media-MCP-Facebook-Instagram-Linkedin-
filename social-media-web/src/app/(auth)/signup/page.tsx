import { BrandLogo } from "@/components/brand-logo";
import { safeRedirectPath } from "@/lib/redirects";

import { SignupForm } from "./signup-form";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);

  return (
    <main className="flex min-h-svh flex-1 flex-col items-center justify-center gap-6 bg-background px-4 py-10 [background-image:radial-gradient(60rem_40rem_at_50%_-10%,color-mix(in_oklch,var(--brand)_6%,transparent),transparent)]">
      <BrandLogo priority />
      <SignupForm next={next} />
    </main>
  );
}
