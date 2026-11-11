"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import {
  OTP_LENGTH,
  OTP_RESEND_COOLDOWN_SECONDS,
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  passwordRequirements,
  validateOtp,
  validatePasswordStrength,
} from "@/lib/security-policy";

type Step = "request" | "verify" | "done";

interface AuthErrorShape {
  code?: string;
  message?: string;
}

function messageFor(error: AuthErrorShape | null, fallback: string): string {
  if (!error) return fallback;
  switch (error.code) {
    case "OTP_EXPIRED":
      return "That code has expired. Request a new one.";
    case "INVALID_OTP":
      return "That code is not valid. Check the email and try again.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Request a new code.";
    case "TOO_MANY_REQUESTS":
      return "Too many requests. Wait a minute and try again.";
    default:
      return error.message || fallback;
  }
}

function Requirement({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <li className={`text-xs ${met ? "text-foreground" : "text-muted-foreground"}`}>
      {met ? "✓" : "•"} {children}
    </li>
  );
}

export function ForgotPasswordForm() {
  const [step, setStep] = useState<Step>("request");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const requirements = passwordRequirements(newPassword);
  const secondsUntilResend = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    if (resendAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  async function requestCode(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setError(null);

    const normalized = normalizeEmail(email);
    if (!normalized) {
      setError("Enter a valid email address.");
      return;
    }

    setPending(true);
    try {
      // Better Auth answers with the same success response whether or not the
      // address exists, so this screen never reveals which emails are known.
      const { error: requestError } = await authClient.emailOtp.requestPasswordReset({
        email: normalized,
      });
      if (requestError) {
        setError(messageFor(requestError, "Could not send a reset code. Try again."));
        return;
      }
      setEmail(normalized);
      setOtp("");
      setStep("verify");
      setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      setNow(Date.now());
    } catch {
      setError("Could not send a reset code. Try again.");
    } finally {
      setPending(false);
    }
  }

  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsedOtp = validateOtp(otp);
    if (!parsedOtp.ok) {
      setError(parsedOtp.message);
      return;
    }
    const strength = validatePasswordStrength(newPassword);
    if (!strength.ok) {
      setError(strength.message);
      return;
    }
    if (strength.value !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }

    setPending(true);
    try {
      const { error: resetError } = await authClient.emailOtp.resetPassword({
        email,
        otp: parsedOtp.value,
        password: strength.value,
      });
      if (resetError) {
        setError(messageFor(resetError, "Could not reset your password. Try again."));
        return;
      }
      setNewPassword("");
      setConfirmPassword("");
      setOtp("");
      setStep("done");
    } catch {
      setError("Could not reset your password. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          {step === "done"
            ? "Your password has been changed."
            : "We will email a one-time 6-digit code to your account address."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {step === "request" ? (
          <form className="flex flex-col gap-4" onSubmit={requestCode}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Sending..." : "Send reset code"}
            </Button>
          </form>
        ) : null}

        {step === "verify" ? (
          <form className="flex flex-col gap-4" onSubmit={resetPassword}>
            <p className="text-sm text-muted-foreground">
              If an account exists for <span className="font-medium text-foreground">{email}</span>,
              a {OTP_LENGTH}-digit code is on its way. It expires in 5 minutes.
            </p>
            <div className="flex flex-col gap-2">
              <Label htmlFor="reset-otp">Verification code</Label>
              <Input
                id="reset-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={OTP_LENGTH}
                required
                value={otp}
                onChange={(event) => setOtp(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                type="password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="reset-confirm">Confirm new password</Label>
              <Input
                id="reset-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
            <ul className="grid gap-1" aria-label="Password requirements">
              <Requirement met={requirements.length}>
                At least {PASSWORD_MIN_LENGTH} characters
              </Requirement>
              <Requirement met={requirements.lowercase}>Lowercase letter</Requirement>
              <Requirement met={requirements.uppercase}>Uppercase letter</Requirement>
              <Requirement met={requirements.digit}>Number</Requirement>
              <Requirement met={requirements.symbol}>Symbol</Requirement>
            </ul>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? "Resetting..." : "Reset password"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending || secondsUntilResend > 0}
              onClick={() => void requestCode()}
            >
              {secondsUntilResend > 0
                ? `Resend code in ${secondsUntilResend}s`
                : "Resend code"}
            </Button>
          </form>
        ) : null}

        {step === "done" ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Every signed-in session was signed out. Use your new password to
              sign in again.
            </p>
            <Link href="/login">
              <Button className="w-full">Back to sign in</Button>
            </Link>
          </div>
        ) : null}

        {step !== "done" ? (
          <p className="text-center text-sm text-muted-foreground">
            Remembered it?{" "}
            <Link className="underline underline-offset-4 hover:text-foreground" href="/login">
              Sign in
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
