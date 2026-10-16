import { SignupForm } from "./signup-form";

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  const next = typeof params.next === "string" && params.next.startsWith("/") ? params.next : "/";

  return (
    <main className="flex min-h-svh flex-1 items-center justify-center bg-muted/40 p-6">
      <SignupForm next={next} />
    </main>
  );
}
