// Pure profile/password/OTP policy helpers. Kept free of database, auth, and
// Next.js imports so the same rules run in the browser form, the API route,
// the emergency recovery script, and unit tests.

export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 80;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const OTP_LENGTH = 6;
export const OTP_EXPIRES_IN_SECONDS = 300;
export const OTP_ALLOWED_ATTEMPTS = 3;
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N} .,'’\-_()&]+$/u;

/**
 * Normalizes and validates the administrator display name. Names are only
 * presentation data; the role and email are never editable through this path.
 */
export function validateDisplayName(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: "Name must be text." };
  }

  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < DISPLAY_NAME_MIN_LENGTH) {
    return {
      ok: false,
      message: `Name must be at least ${DISPLAY_NAME_MIN_LENGTH} characters.`,
    };
  }
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `Name must be at most ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(name)) {
    return { ok: false, message: "Name contains unsupported characters." };
  }
  if (!DISPLAY_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message:
        "Name may contain letters, numbers, spaces, and common punctuation only.",
    };
  }

  return { ok: true, value: name };
}

export interface PasswordRequirements {
  length: boolean;
  lowercase: boolean;
  uppercase: boolean;
  digit: boolean;
  symbol: boolean;
}

export function passwordRequirements(value: string): PasswordRequirements {
  return {
    length: value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH,
    lowercase: /[a-z]/.test(value),
    uppercase: /[A-Z]/.test(value),
    digit: /\d/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };
}

/**
 * Enforces a 12+ character password with at least three of four character
 * classes. This is intentionally stricter than Better Auth's built-in minimum
 * and is re-checked server-side before the provider is called.
 */
export function validatePasswordStrength(value: unknown): ValidationResult<string> {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, message: "Password is required." };
  }
  if (value.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    };
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    };
  }
  if (CONTROL_CHARACTERS.test(value)) {
    return { ok: false, message: "Password contains unsupported characters." };
  }

  const requirements = passwordRequirements(value);
  const classes = [
    requirements.lowercase,
    requirements.uppercase,
    requirements.digit,
    requirements.symbol,
  ].filter(Boolean).length;

  if (classes < 3) {
    return {
      ok: false,
      message:
        "Password must include at least three of: lowercase, uppercase, numbers, symbols.",
    };
  }

  return { ok: true, value };
}

export interface PasswordChangeInput {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
}

export interface ValidatedPasswordChange {
  currentPassword: string;
  newPassword: string;
}

/**
 * Validates a self-service password change. The current password is only
 * checked for shape here; Better Auth verifies the real hash server-side.
 */
export function validatePasswordChange(
  input: PasswordChangeInput,
): ValidationResult<ValidatedPasswordChange> {
  const currentPassword = input.currentPassword;
  if (typeof currentPassword !== "string" || currentPassword.length === 0) {
    return { ok: false, message: "Current password is required." };
  }
  if (currentPassword.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, message: "Current password is too long." };
  }

  const strength = validatePasswordStrength(input.newPassword);
  if (!strength.ok) return strength;

  if (typeof input.confirmPassword !== "string" || input.confirmPassword.length === 0) {
    return { ok: false, message: "Confirm the new password." };
  }
  if (strength.value !== input.confirmPassword) {
    return { ok: false, message: "The new passwords do not match." };
  }
  if (strength.value === currentPassword) {
    return { ok: false, message: "The new password must differ from the current password." };
  }

  return {
    ok: true,
    value: { currentPassword, newPassword: strength.value },
  };
}

/** Validates the 6-digit numeric OTP accepted by the email-OTP provider. */
export function validateOtp(value: unknown): ValidationResult<string> {
  if (typeof value !== "string") {
    return { ok: false, message: "Enter the 6-digit code from your email." };
  }
  const otp = value.trim();
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(otp)) {
    return { ok: false, message: "Enter the 6-digit code from your email." };
  }
  return { ok: true, value: otp };
}

/** Lowercases and lightly validates an email before an OTP request. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
