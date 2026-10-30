import { safeRedirectPath } from "@/lib/redirects";

import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = safeRedirectPath(params.next);

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center bg-muted/40 p-6">
      <LoginForm next={next} />
    </main>
  );
}
