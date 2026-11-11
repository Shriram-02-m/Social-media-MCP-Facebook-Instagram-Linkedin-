"use client";

import { Check, Circle, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
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
import type { AdminProfile, RecoveryStatus } from "@/lib/admin-security";
import {
  DISPLAY_NAME_MAX_LENGTH,
  OTP_RESEND_COOLDOWN_SECONDS,
  PASSWORD_MIN_LENGTH,
  passwordRequirements,
  validateDisplayName,
  validateOtp,
  validatePasswordChange,
} from "@/lib/security-policy";

interface SettingsClientProps {
  profile: AdminProfile;
  recovery: RecoveryStatus;
}

interface ApiBody {
  error?: string;
  name?: string;
  revoked?: number;
}

function Requirement({ met, children }: { met: boolean; children: React.ReactNode }) {
  const Icon = met ? Check : Circle;
  return (
    <li
      className={`flex items-center gap-2 text-xs ${met ? "text-foreground" : "text-muted-foreground"}`}
    >
      <Icon className={`size-3.5 ${met ? "text-emerald-600" : ""}`} aria-hidden />
      {children}
    </li>
  );
}

export function SettingsClient({ profile, recovery }: SettingsClientProps) {
  const router = useRouter();

  const [name, setName] = useState(profile.name);
  const [profilePending, setProfilePending] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [verified, setVerified] = useState(recovery.emailVerified);
  const [otp, setOtp] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [verifyPending, setVerifyPending] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
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

  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileError(null);

    const parsed = validateDisplayName(name);
    if (!parsed.ok) {
      setProfileError(parsed.message);
      return;
    }

    setProfilePending(true);
    try {
      const response = await fetch("/api/admin/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: parsed.value }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiBody;
      if (!response.ok) {
        setProfileError(body.error ?? "Could not save your profile.");
        return;
      }
      setName(body.name ?? parsed.value);
      toast.success("Profile updated.");
      router.refresh();
    } catch {
      setProfileError("Could not save your profile.");
    } finally {
      setProfilePending(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError(null);

    const parsed = validatePasswordChange({
      currentPassword,
      newPassword,
      confirmPassword,
    });
    if (!parsed.ok) {
      setPasswordError(parsed.message);
      return;
    }

    setPasswordPending(true);
    try {
      const response = await fetch("/api/admin/security/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: parsed.value.currentPassword,
          newPassword: parsed.value.newPassword,
          confirmPassword,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiBody;
      if (!response.ok) {
        setPasswordError(body.error ?? "Could not change your password.");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password changed. Every other session was signed out.");
      router.refresh();
    } catch {
      setPasswordError("Could not change your password.");
    } finally {
      setPasswordPending(false);
    }
  }

  async function sendRecoveryCode() {
    setRecoveryError(null);
    setRecoveryPending(true);
    try {
      const response = await fetch("/api/admin/security/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send" }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiBody;
      if (!response.ok) {
        setRecoveryError(body.error ?? "Could not send the verification code.");
        return;
      }
      setCodeSent(true);
      setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      setNow(Date.now());
      toast.success("Verification code sent to your recovery email.");
    } catch {
      setRecoveryError("Could not send the verification code.");
    } finally {
      setRecoveryPending(false);
    }
  }

  async function verifyRecoveryCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoveryError(null);

    const parsed = validateOtp(otp);
    if (!parsed.ok) {
      setRecoveryError(parsed.message);
      return;
    }

    setVerifyPending(true);
    try {
      const response = await fetch("/api/admin/security/recovery", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", otp: parsed.value }),
      });
      const body = (await response.json().catch(() => ({}))) as ApiBody;
      if (!response.ok) {
        setRecoveryError(body.error ?? "Could not verify the code.");
        return;
      }
      setVerified(true);
      setCodeSent(false);
      setOtp("");
      toast.success("Recovery email verified.");
      router.refresh();
    } catch {
      setRecoveryError("Could not verify the code.");
    } finally {
      setVerifyPending(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Profile information</CardTitle>
          <CardDescription>
            Your display name appears across the console. Email and role are
            managed separately and cannot be changed here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={saveProfile}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-name">Display name</Label>
              <Input
                id="profile-name"
                value={name}
                maxLength={DISPLAY_NAME_MAX_LENGTH}
                autoComplete="name"
                aria-invalid={profileError ? true : undefined}
                aria-describedby={profileError ? "profile-error" : undefined}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input id="profile-email" value={profile.email} readOnly disabled />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Role</span>
              <Badge variant="secondary">Super Admin</Badge>
            </div>
            {profileError ? (
              <p id="profile-error" className="text-sm text-destructive" role="alert">
                {profileError}
              </p>
            ) : null}
            <div>
              <Button type="submit" disabled={profilePending}>
                {profilePending ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden /> Saving...
                  </>
                ) : (
                  "Save profile"
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            Use at least {PASSWORD_MIN_LENGTH} characters with three of four
            character types. Every other signed-in device is signed out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={changePassword}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
            <ul className="grid gap-1 sm:grid-cols-2" aria-label="Password requirements">
              <Requirement met={requirements.length}>
                At least {PASSWORD_MIN_LENGTH} characters
              </Requirement>
              <Requirement met={requirements.lowercase}>Lowercase letter</Requirement>
              <Requirement met={requirements.uppercase}>Uppercase letter</Requirement>
              <Requirement met={requirements.digit}>Number</Requirement>
              <Requirement met={requirements.symbol}>Symbol</Requirement>
            </ul>
            {passwordError ? (
              <p className="text-sm text-destructive" role="alert">
                {passwordError}
              </p>
            ) : null}
            <div>
              <Button type="submit" disabled={passwordPending}>
                {passwordPending ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden /> Changing...
                  </>
                ) : (
                  "Change password"
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Account recovery</CardTitle>
          <CardDescription>
            Password recovery sends a 6-digit code to your verified email. Codes
            expire after 5 minutes, allow three attempts, and are rate limited.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Recovery email</span>
            <span className="text-muted-foreground">{recovery.email}</span>
            {verified ? (
              <Badge variant="secondary">Verified</Badge>
            ) : (
              <Badge variant="outline">Not verified</Badge>
            )}
          </div>

          {!recovery.deliveryConfigured ? (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              Email delivery is not configured on this server. Set
              <code className="mx-1">RESEND_API_KEY</code>
              or
              <code className="mx-1">EMAIL_DELIVERY_URL</code>
              before relying on recovery.
            </p>
          ) : null}

          {verified ? (
            <p className="text-sm text-muted-foreground">
              Your recovery address is verified. If you ever lose your password,
              use <span className="font-medium text-foreground">Forgot password</span> on
              the sign-in page to receive a one-time code.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Verify this address so a password-recovery code can reach you.
                The code is sent to the email already on your account; it cannot
                be redirected from this form.
              </p>

              {!codeSent ? (
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={recoveryPending}
                    onClick={() => void sendRecoveryCode()}
                  >
                    {recoveryPending ? (
                      <>
                        <Loader2 className="animate-spin" aria-hidden /> Sending...
                      </>
                    ) : (
                      "Send verification code"
                    )}
                  </Button>
                </div>
              ) : (
                <form className="flex max-w-sm flex-col gap-3" onSubmit={verifyRecoveryCode}>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="recovery-otp">Verification code</Label>
                    <Input
                      id="recovery-otp"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={otp}
                      onChange={(event) => setOtp(event.target.value)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" disabled={verifyPending}>
                      {verifyPending ? (
                        <>
                          <Loader2 className="animate-spin" aria-hidden /> Verifying...
                        </>
                      ) : (
                        "Verify email"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={recoveryPending || secondsUntilResend > 0}
                      onClick={() => void sendRecoveryCode()}
                    >
                      {secondsUntilResend > 0
                        ? `Resend in ${secondsUntilResend}s`
                        : "Resend code"}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          )}

          {recoveryError ? (
            <p className="text-sm text-destructive" role="alert">
              {recoveryError}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
