import { BrandLogo } from "@/components/brand-logo";

import { ForgotPasswordForm } from "./forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <main className="auth-shell flex min-h-svh flex-1 flex-col items-center justify-center gap-6 px-4 py-10">
      <BrandLogo priority />
      <ForgotPasswordForm />
    </main>
  );
}
