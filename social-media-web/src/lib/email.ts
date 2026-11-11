// Security email delivery for OTP-based account recovery. Two transports are
// supported without adding a dependency:
//   1. Resend (RESEND_API_KEY + EMAIL_FROM)
//   2. A generic HTTPS webhook (EMAIL_DELIVERY_URL + optional EMAIL_DELIVERY_TOKEN)
// If neither is configured the message is dropped with a warning. Delivery
// failures are swallowed so an attacker cannot distinguish a real account from
// an unknown email by watching for a 5xx response. OTP values are never logged.

import { OTP_EXPIRES_IN_SECONDS } from "@/lib/security-policy";

export type SecurityEmailType =
  | "sign-in"
  | "email-verification"
  | "forget-password"
  | "change-email";

export interface SecurityEmail {
  to: string;
  subject: string;
  text: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function appName(): string {
  return process.env.EMAIL_APP_NAME?.trim() || "Social Console";
}

function expiryMinutes(): number {
  return Math.max(1, Math.round(OTP_EXPIRES_IN_SECONDS / 60));
}

/**
 * Builds the subject and plain-text body for a security OTP. The OTP appears
 * only in the message body; it is never written to logs, audit metadata, or
 * the subject line.
 */
export function otpEmailContent(
  type: SecurityEmailType,
  otp: string,
): { subject: string; text: string } {
  const name = appName();
  const minutes = expiryMinutes();
  const footer = `This code expires in ${minutes} minutes. If you did not request it, you can ignore this email.`;

  switch (type) {
    case "forget-password":
      return {
        subject: `${name} password reset code`,
        text: `Your ${name} password reset code is ${otp}.\n\n${footer}\n\nFor your security, never share this code with anyone.`,
      };
    case "email-verification":
      return {
        subject: `${name} recovery email verification code`,
        text: `Your ${name} recovery email verification code is ${otp}.\n\n${footer}`,
      };
    case "sign-in":
      return {
        subject: `${name} sign-in code`,
        text: `Your ${name} sign-in code is ${otp}.\n\n${footer}`,
      };
    case "change-email":
      return {
        subject: `${name} email change code`,
        text: `Your ${name} email change code is ${otp}.\n\n${footer}`,
      };
  }
}

export function isEmailDeliveryConfigured(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() || process.env.EMAIL_DELIVERY_URL?.trim(),
  );
}

/**
 * Best-effort delivery. This function never throws: the caller is an auth
 * endpoint that must keep its non-enumerating success response even when the
 * mail provider is down or misconfigured.
 */
export async function sendSecurityEmail(message: SecurityEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const webhookUrl = process.env.EMAIL_DELIVERY_URL?.trim();

  try {
    if (apiKey) {
      const from = process.env.EMAIL_FROM?.trim()
        || "Social Console <onboarding@resend.dev>";
      const response = await fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        // Status only: the response body can echo the message content.
        console.error(`[email] Resend delivery failed with status ${response.status}.`);
      }
      return;
    }

    if (webhookUrl) {
      const token = process.env.EMAIL_DELIVERY_TOKEN?.trim();
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          to: message.to,
          subject: message.subject,
          text: message.text,
        }),
      });
      if (!response.ok) {
        console.error(`[email] Webhook delivery failed with status ${response.status}.`);
      }
      return;
    }

    console.warn(
      "[email] Security email delivery is not configured (set RESEND_API_KEY or EMAIL_DELIVERY_URL); message was not sent.",
    );
  } catch (error) {
    // Never log the message body, recipient, or OTP.
    console.error(
      "[email] Security email delivery failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}
