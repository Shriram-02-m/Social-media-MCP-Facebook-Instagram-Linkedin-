import { BrandLogo } from "@/components/brand-logo";
import { safeRedirectPath } from "@/lib/redirects";

import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);

  return (
    <main className="auth-shell flex min-h-svh flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
      <BrandLogo priority />
      <LoginForm next={next} />
    </main>
  );
}
