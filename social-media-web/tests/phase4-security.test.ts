import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  OTP_ALLOWED_ATTEMPTS,
  OTP_EXPIRES_IN_SECONDS,
  OTP_LENGTH,
  OTP_RESEND_COOLDOWN_SECONDS,
  PASSWORD_MIN_LENGTH,
  normalizeEmail,
  passwordRequirements,
  validateDisplayName,
  validateOtp,
  validatePasswordChange,
  validatePasswordStrength,
} from "@/lib/security-policy";

// ---------------------------------------------------------------------------
// Route harness
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  class ApprovalRequiredError extends Error {
    code = "rejected";
  }
  class ApiError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }
  return {
    requireAdmin: vi.fn(),
    getAdminProfile: vi.fn(),
    updateAdminProfile: vi.fn(),
    listAdminSessions: vi.fn(),
    revokeOtherAdminSessions: vi.fn(),
    changeAdminPassword: vi.fn(),
    UnauthorizedError,
    ApprovalRequiredError,
    ApiError,
  };
});

vi.mock("@/lib/session", () => ({
  requireAdmin: mocks.requireAdmin,
  UnauthorizedError: mocks.UnauthorizedError,
  ApprovalRequiredError: mocks.ApprovalRequiredError,
}));

vi.mock("@/lib/api", () => ({
  ApiError: mocks.ApiError,
  apiErrorResponse: (error: unknown) => {
    if (error instanceof mocks.ApiError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof mocks.UnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof mocks.ApprovalRequiredError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    return Response.json({ error: "Unexpected error." }, { status: 500 });
  },
}));

vi.mock("@/lib/admin-security", () => ({
  getAdminProfile: mocks.getAdminProfile,
  updateAdminProfile: mocks.updateAdminProfile,
  listAdminSessions: mocks.listAdminSessions,
  revokeOtherAdminSessions: mocks.revokeOtherAdminSessions,
  changeAdminPassword: mocks.changeAdminPassword,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=test" }),
}));

import { GET as profileGET, PATCH as profilePATCH } from "@/app/api/admin/profile/route";
import { POST as passwordPOST } from "@/app/api/admin/security/password/route";
import {
  DELETE as sessionsDELETE,
  GET as sessionsGET,
} from "@/app/api/admin/security/sessions/route";

const adminSession = {
  session: { id: "sess-admin", token: "tok" },
  user: { id: "admin-1", name: "Admin", email: "admin@example.com", role: "admin" },
};

function request(pathname: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const STRONG_PASSWORD = "CorrectHorse1!Battery";

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.requireAdmin.mockResolvedValue(adminSession);
});

// ---------------------------------------------------------------------------
// Pure policy
// ---------------------------------------------------------------------------

describe("profile name policy", () => {
  it("trims and collapses whitespace", () => {
    expect(validateDisplayName("  Ada   Lovelace  ")).toEqual({
      ok: true,
      value: "Ada Lovelace",
    });
  });

  it("rejects blank, too-short, and too-long names", () => {
    expect(validateDisplayName(" ").ok).toBe(false);
    expect(validateDisplayName("A").ok).toBe(false);
    expect(validateDisplayName("A".repeat(81)).ok).toBe(false);
  });

  it("rejects markup, control characters, and non-text values", () => {
    expect(validateDisplayName("<script>alert(1)</script>").ok).toBe(false);
    expect(validateDisplayName("Ada\u0000Lovelace").ok).toBe(false);
    expect(validateDisplayName(42).ok).toBe(false);
    expect(validateDisplayName(null).ok).toBe(false);
  });
});

describe("password policy", () => {
  it("requires at least 12 characters and three character classes", () => {
    expect(validatePasswordStrength("short1!A").ok).toBe(false);
    expect(validatePasswordStrength("alllowercase1").ok).toBe(false);
    expect(validatePasswordStrength(STRONG_PASSWORD)).toEqual({
      ok: true,
      value: STRONG_PASSWORD,
    });
  });

  it("reports each requirement for live UI feedback", () => {
    const requirements = passwordRequirements(STRONG_PASSWORD);
    expect(requirements.length).toBe(true);
    expect(requirements.lowercase).toBe(true);
    expect(requirements.uppercase).toBe(true);
    expect(requirements.digit).toBe(true);
    expect(requirements.symbol).toBe(true);
  });

  it("requires the current password and a matching confirmation", () => {
    expect(
      validatePasswordChange({ newPassword: STRONG_PASSWORD, confirmPassword: STRONG_PASSWORD }).ok,
    ).toBe(false);
    expect(
      validatePasswordChange({
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        confirmPassword: "different",
      }).ok,
    ).toBe(false);
    expect(
      validatePasswordChange({
        currentPassword: STRONG_PASSWORD,
        newPassword: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
      }).ok,
    ).toBe(false);
    expect(
      validatePasswordChange({
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
      }),
    ).toEqual({
      ok: true,
      value: { currentPassword: "old-password", newPassword: STRONG_PASSWORD },
    });
  });

  it("pins the advertised minimum length", () => {
    expect(PASSWORD_MIN_LENGTH).toBeGreaterThanOrEqual(12);
  });
});

describe("OTP and email policy", () => {
  it("accepts only six digits", () => {
    expect(validateOtp(" 123456 ")).toEqual({ ok: true, value: "123456" });
    expect(validateOtp("12345").ok).toBe(false);
    expect(validateOtp("1234567").ok).toBe(false);
    expect(validateOtp("12a456").ok).toBe(false);
    expect(validateOtp(123456).ok).toBe(false);
  });

  it("normalizes a valid email and rejects malformed input", () => {
    expect(normalizeEmail(" Admin@Example.COM ")).toBe("admin@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(normalizeEmail(7)).toBeNull();
  });

  it("matches the configured OTP lifecycle", () => {
    expect(OTP_LENGTH).toBe(6);
    expect(OTP_EXPIRES_IN_SECONDS).toBe(300);
    expect(OTP_ALLOWED_ATTEMPTS).toBe(3);
    expect(OTP_RESEND_COOLDOWN_SECONDS).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Auth configuration
// ---------------------------------------------------------------------------

const readFile = (relative: string) =>
  readFileSync(path.resolve(process.cwd(), relative), "utf8");

function walk(relative: string): string[] {
  const root = path.resolve(process.cwd(), relative);
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) out.push(...walk(path.relative(process.cwd(), full)));
    else out.push(path.relative(process.cwd(), full));
  }
  return out;
}

describe("Better Auth recovery configuration", () => {
  const auth = readFile("src/lib/auth.ts");

  it("registers the email OTP plugin with hardened storage and limits", () => {
    expect(auth).toMatch(/emailOTP\(/);
    expect(auth).toMatch(/storeOTP:\s*"hashed"/);
    expect(auth).toMatch(/expiresIn:\s*OTP_EXPIRES_IN_SECONDS/);
    expect(auth).toMatch(/allowedAttempts:\s*OTP_ALLOWED_ATTEMPTS/);
    expect(auth).toMatch(/resendStrategy:\s*"rotate"/);
    expect(auth).toMatch(/rateLimit:\s*\{/);
    expect(auth).toMatch(/disableSignUp:\s*true/);
  });

  it("revokes sessions on reset and audits without sensitive values", () => {
    expect(auth).toMatch(/revokeSessionsOnPasswordReset:\s*true/);
    expect(auth).toMatch(/onPasswordReset/);
    expect(auth).toMatch(/afterEmailVerification/);
    expect(auth).toMatch(/\/email-otp\/request-password-reset/);
    expect(auth).toMatch(/logActivity\(/);
    expect(auth).not.toMatch(/metadata:\s*\{[^}]*\botp\s*:/i);
  });

  it("delegates delivery to the non-throwing email helper", () => {
    expect(auth).toMatch(/sendSecurityEmail/);
    expect(auth).toMatch(/otpEmailContent/);
  });
});

describe("email delivery", () => {
  const email = readFile("src/lib/email.ts");
  const consoleLines = email
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("console."));

  it("never logs OTP values, recipients, or message bodies", () => {
    for (const line of consoleLines) {
      expect(line).not.toMatch(/\botp\b/i);
      expect(line).not.toMatch(/message\.(text|to)/);
      expect(line).not.toMatch(/\.text\b/);
    }
  });

  it("swallows delivery failures so responses cannot enumerate accounts", () => {
    expect(email).toMatch(/try\s*\{/);
    expect(email).toMatch(/catch/);
    expect(email).toMatch(/never throws/i);
  });

  it("supports Resend and a generic webhook without new dependencies", () => {
    expect(email).toMatch(/RESEND_API_KEY/);
    expect(email).toMatch(/EMAIL_DELIVERY_URL/);
    expect(email).toMatch(/api\.resend\.com/);
  });
});

// ---------------------------------------------------------------------------
// Admin security helpers (source invariants)
// ---------------------------------------------------------------------------

describe("admin security helpers", () => {
  const security = readFile("src/lib/admin-security.ts");

  it("changes passwords through Better Auth with session rotation", () => {
    expect(security).toMatch(/auth\.api\.changePassword\(/);
    expect(security).toMatch(/revokeOtherSessions:\s*true/);
    expect(security).toMatch(/asResponse:\s*true/);
    expect(security).toMatch(/getSetCookie\(\)/);
  });

  it("never returns the new raw session token in the response body", () => {
    expect(security).toMatch(/success:\s*true/);
    expect(security).not.toMatch(/JSON\.stringify\(authResponse/);
    expect(security).not.toMatch(/body\.token/);
  });

  it("lists sessions without selecting tokens", () => {
    const sessionsBlock = security.slice(
      security.indexOf("export async function listAdminSessions"),
      security.indexOf("async function countOtherSessions"),
    );
    expect(sessionsBlock).not.toMatch(/\btoken:/);
    expect(sessionsBlock).toMatch(/ipAddress/);
    expect(sessionsBlock).toMatch(/userAgent/);
  });

  it("only writes the name during a profile update", () => {
    const profileBlock = security.slice(
      security.indexOf("export async function updateAdminProfile"),
      security.indexOf("export async function listAdminSessions"),
    );
    expect(profileBlock).toMatch(/\.set\(\{\s*name:/);
    expect(profileBlock).not.toMatch(/\.set\(\{[^}]*role:/);
    expect(profileBlock).not.toMatch(/\.set\(\{[^}]*email:/);
  });

});

// ---------------------------------------------------------------------------
// Route authorization and strict payloads
// ---------------------------------------------------------------------------

describe("profile API", () => {
  it("requires an admin session", async () => {
    mocks.requireAdmin.mockRejectedValue(new mocks.UnauthorizedError("Authentication required."));
    const response = await profileGET();
    expect(response.status).toBe(401);
    expect(mocks.getAdminProfile).not.toHaveBeenCalled();
  });

  it("returns the session administrator's profile", async () => {
    mocks.getAdminProfile.mockResolvedValue({ id: "admin-1", name: "Admin" });
    const response = await profileGET();
    expect(response.status).toBe(200);
    expect(mocks.getAdminProfile).toHaveBeenCalledWith("admin-1");
  });

  it("rejects privilege-escalation fields instead of ignoring them", async () => {
    const response = await profilePATCH(
      request("/api/admin/profile", "PATCH", { name: "New Name", role: "admin" }),
    );
    expect(response.status).toBe(400);
    expect(mocks.updateAdminProfile).not.toHaveBeenCalled();
  });

  it("accepts only a display-name change", async () => {
    mocks.updateAdminProfile.mockResolvedValue({ id: "admin-1", name: "New Name" });
    const response = await profilePATCH(
      request("/api/admin/profile", "PATCH", { name: "New Name" }),
    );
    expect(response.status).toBe(200);
    expect(mocks.updateAdminProfile).toHaveBeenCalledWith("admin-1", "New Name");
  });
});

describe("password API", () => {
  it("requires an admin session", async () => {
    mocks.requireAdmin.mockRejectedValue(new mocks.UnauthorizedError("Authentication required."));
    const response = await passwordPOST(
      request("/api/admin/security/password", "POST", {
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
      }),
    );
    expect(response.status).toBe(401);
    expect(mocks.changeAdminPassword).not.toHaveBeenCalled();
  });

  it("rejects unknown body keys", async () => {
    const response = await passwordPOST(
      request("/api/admin/security/password", "POST", {
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
        revokeOtherSessions: false,
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.changeAdminPassword).not.toHaveBeenCalled();
  });

  it("enforces strength and matching confirmation server-side", async () => {
    for (const body of [
      { currentPassword: "old-password", newPassword: "weak", confirmPassword: "weak" },
      {
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        confirmPassword: "different",
      },
    ]) {
      const response = await passwordPOST(
        request("/api/admin/security/password", "POST", body),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.changeAdminPassword).not.toHaveBeenCalled();
  });

  it("delegates to Better Auth with the verified session and forwards cookies", async () => {
    mocks.changeAdminPassword.mockResolvedValue(
      Response.json({ success: true, otherSessionsRevoked: 1 }),
    );
    const response = await passwordPOST(
      request("/api/admin/security/password", "POST", {
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        confirmPassword: STRONG_PASSWORD,
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.changeAdminPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        currentSessionId: "sess-admin",
        currentPassword: "old-password",
        newPassword: STRONG_PASSWORD,
        headers: expect.any(Headers),
      }),
    );
  });
});

describe("sessions API", () => {
  it("requires an admin session", async () => {
    mocks.requireAdmin.mockRejectedValue(new mocks.UnauthorizedError("Authentication required."));
    const response = await sessionsGET();
    expect(response.status).toBe(401);
    expect(mocks.listAdminSessions).not.toHaveBeenCalled();
  });

  it("lists sessions scoped to the signed-in administrator", async () => {
    mocks.listAdminSessions.mockResolvedValue([]);
    const response = await sessionsGET();
    expect(response.status).toBe(200);
    expect(mocks.listAdminSessions).toHaveBeenCalledWith("admin-1", "sess-admin");
  });

  it("revokes other sessions with the verified session identity", async () => {
    mocks.revokeOtherAdminSessions.mockResolvedValue({ revoked: 2 });
    const response = await sessionsDELETE();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 2 });
    expect(mocks.revokeOtherAdminSessions).toHaveBeenCalledWith(
      expect.any(Headers),
      "admin-1",
      "sess-admin",
    );
  });
});

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

describe("settings and recovery UI", () => {
  const page = readFile("src/app/(dashboard)/admin/settings/page.tsx");
  const client = readFile("src/app/(dashboard)/admin/settings/settings-client.tsx");
  const sessionActions = readFile("src/app/(dashboard)/admin/settings/session-actions.tsx");
  const login = readFile("src/app/(auth)/login/login-form.tsx");
  const forgot = readFile("src/app/(auth)/forgot-password/forgot-password-form.tsx");

  it("loads profile and sessions data behind the admin page guard", () => {
    expect(page).toMatch(/requireAdminPage/);
    expect(page).toMatch(/getAdminProfile/);
    expect(page).toMatch(/listAdminSessions/);
    expect(page).toMatch(/<SettingsClient/);
    expect(page).toMatch(/<SessionActions/);
  });

  it("organizes the settings screen into the required sections", () => {
    expect(client).toMatch(/Profile information/);
    expect(client).toMatch(/Change password/);
    expect(client).not.toMatch(/Account recovery/);
    expect(page).toMatch(/Active sessions/);
  });

  it("uses toasts, dialogs, and loading/error states", () => {
    expect(client).toMatch(/toast\.success/);
    expect(client).toMatch(/toast\.error|setProfileError|setPasswordError/);
    expect(client).toMatch(/Loader2/);
    expect(sessionActions).toMatch(/AlertDialog/);
    expect(sessionActions).toMatch(/toast\.success/);
  });

  it("does not allow role or email editing through the profile form", () => {
    expect(client).not.toMatch(/name="role"/);
    expect(client).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*\brole\b/);
    expect(client).not.toMatch(/\brole:\s*["']admin["']/);
    expect(client).toMatch(/readOnly/);
  });

  it("keeps login free of forgot-password links and adds a password visibility toggle", () => {
    // The forgot-password route itself remains available (self-service reset
    // and the email-OTP endpoint stay wired), but the login page must not
    // surface the link.
    expect(login).not.toMatch(/href="\/forgot-password"/);
    expect(login).not.toMatch(/Forgot password/);
    // The password field starts hidden and toggles through an accessible,
    // keyboard-operable button without losing the entered value.
    expect(login).toMatch(/type=\{showPassword \? "text" : "password"\}/);
    expect(login).toMatch(/aria-label=\{showPassword \? "Hide password" : "Show password"\}/);
    expect(login).toMatch(/EyeOff/);
    expect(login).toMatch(/Eye/);
    expect(login).toMatch(/autoComplete="current-password"/);
  });

  it("requests and consumes recovery OTPs without revealing account existence", () => {
    expect(forgot).toMatch(/requestPasswordReset/);
    expect(forgot).toMatch(/resetPassword/);
    expect(forgot).toMatch(/If an account exists/i);
    expect(forgot).toMatch(/validatePasswordStrength/);
    expect(forgot).toMatch(/validateOtp/);
    expect(forgot).toMatch(/OTP_RESEND_COOLDOWN_SECONDS/);
  });

  it("revokes other sessions through the dedicated API", () => {
    expect(sessionActions).toMatch(/\/api\/admin\/security\/sessions/);
    expect(sessionActions).toMatch(/method:\s*"DELETE"/);
  });
});

// ---------------------------------------------------------------------------
// Emergency recovery + no public recovery endpoint
// ---------------------------------------------------------------------------

describe("emergency recovery", () => {
  const script = readFile("scripts/recover-admin.mts");

  it("requires an explicit acknowledgement phrase", () => {
    expect(script).toMatch(/RECOVER_ADMIN_ACKNOWLEDGE/);
    expect(script).toMatch(/recover-super-admin/);
  });

  it("hashes the new password, revokes sessions, and audits", () => {
    expect(script).toMatch(/hashPassword/);
    expect(script).toMatch(/delete\(session\)/);
    expect(script).toMatch(/admin_emergency_password_recovery/);
    expect(script).toMatch(/db\.transaction/);
  });

  it("refuses to run against multiple administrators", () => {
    expect(script).toMatch(/Multiple Super Admin/);
  });

  it("is not exposed as an HTTP route", () => {
    const apiFiles = walk("src/app/api");
    expect(apiFiles.some((file) => /recover-admin|emergency/i.test(file))).toBe(false);
    expect(script).not.toMatch(/export async function (GET|POST|PATCH|DELETE)/);
    expect(script).not.toMatch(/createAuthEndpoint/);
  });
});
