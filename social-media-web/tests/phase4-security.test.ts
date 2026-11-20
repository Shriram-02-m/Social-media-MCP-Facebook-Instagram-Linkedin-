import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PASSWORD_MIN_LENGTH,
  passwordRequirements,
  validateDisplayName,
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
  changeAdminPassword: mocks.changeAdminPassword,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "better-auth.session_token=test" }),
}));

import { GET as profileGET, PATCH as profilePATCH } from "@/app/api/admin/profile/route";
import { POST as passwordPOST } from "@/app/api/admin/security/password/route";

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

describe("password reset removal from auth configuration", () => {
  const auth = readFile("src/lib/auth.ts");
  const authClient = readFile("src/lib/auth-client.ts");
  const proxy = readFile("src/proxy.ts");
  const resetSurfaceFiles = [
    "src/lib/auth.ts",
    "src/lib/auth-client.ts",
    "src/proxy.ts",
    "src/app/(auth)/login/login-form.tsx",
  ];

  it("keeps core password auth, signup policy, sessions, and the admin plugin", () => {
    expect(auth).toMatch(/emailAndPassword:\s*\{/);
    expect(auth).toMatch(/enabled:\s*true/);
    expect(auth).toMatch(/disableSignUp:\s*process\.env\.ALLOW_ADMIN_SIGNUP/);
    expect(auth).toMatch(/session:\s*\{/);
    expect(auth).toMatch(/databaseHooks:/);
    expect(auth).toMatch(/approvalStatus:\s*"pending"/);
    expect(auth).toMatch(/admin\(\{/);
  });

  it("removes every OTP, reset hook, and email delivery reference", () => {
    for (const file of resetSurfaceFiles) {
      const source = readFile(file);
      expect(source).not.toMatch(/emailOTP|emailOtp/i);
      expect(source).not.toMatch(/requestPasswordReset|resetPassword/i);
      expect(source).not.toMatch(/forgot-password/i);
      expect(source).not.toMatch(/EMAIL_DELIVERY_UNAVAILABLE/);
      expect(source).not.toMatch(/sendSecurityEmail|otpEmailContent/);
    }
    expect(auth).not.toMatch(/revokeSessionsOnPasswordReset|onPasswordReset/);
    expect(auth).not.toMatch(/afterEmailVerification/);
    expect(auth).not.toMatch(/createAuthMiddleware/);
    expect(authClient).not.toMatch(/emailOTPClient/);
    expect(proxy).not.toMatch(/\/forgot-password/);
  });

  it("leaves no reset-specific route or helper file behind", () => {
    const appFiles = walk("src/app");
    const libFiles = walk("src/lib");
    expect(appFiles.some((file) => /forgot|password-reset|reset-password/i.test(file))).toBe(false);
    expect(libFiles.some((file) => /(^|\/)email\.ts$|otp/i.test(file))).toBe(false);
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

  it("only writes the name during a profile update", () => {
    const profileBlock = security.slice(
      security.indexOf("export async function updateAdminProfile"),
      security.indexOf("async function countOtherSessions"),
    );
    expect(profileBlock).toMatch(/\.set\(\{\s*name:/);
    expect(profileBlock).not.toMatch(/\.set\(\{[^}]*role:/);
    expect(profileBlock).not.toMatch(/\.set\(\{[^}]*email:/);
  });

  it("keeps the countOtherSessions helper for password-change session rotation", () => {
    // The helper is shared by changeAdminPassword (Better Auth performs the
    // actual revocation); only the standalone list/revoke endpoints were
    // removed with the settings Active Sessions UI.
    expect(security).toMatch(/function countOtherSessions/);
    expect(security).toMatch(/countOtherSessions\(/);
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

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

describe("settings and recovery UI", () => {
  const page = readFile("src/app/(dashboard)/admin/settings/page.tsx");
  const client = readFile("src/app/(dashboard)/admin/settings/settings-client.tsx");
  const login = readFile("src/app/(auth)/login/login-form.tsx");
  const signup = readFile("src/app/(auth)/signup/signup-form.tsx");

  it("loads profile data behind the admin page guard", () => {
    expect(page).toMatch(/requireAdminPage/);
    expect(page).toMatch(/getAdminProfile/);
    expect(page).toMatch(/<SettingsClient/);
  });

  it("organizes the settings screen into the required sections", () => {
    expect(client).toMatch(/Profile information/);
    expect(client).toMatch(/Change password/);
    expect(client).not.toMatch(/Account recovery/);
    expect(page).toMatch(/Quick actions/);
  });

  it("no longer renders the Active Sessions management section", () => {
    // The settings page must not list sessions, show device/IP metadata, or
    // offer session revocation; Better Auth session handling itself is
    // untouched.
    expect(page).not.toMatch(/Active sessions/i);
    expect(page).not.toMatch(/SessionActions/);
    expect(page).not.toMatch(/listAdminSessions/);
    expect(page).not.toMatch(/Sign out other sessions/);
    expect(page).not.toMatch(/Current session/);
    expect(page).not.toMatch(/Last active/);
    expect(page).not.toMatch(/ipAddress/);
    expect(page).not.toMatch(/other device/);
  });

  it("uses toasts, dialogs, and loading/error states", () => {
    expect(client).toMatch(/toast\.success/);
    expect(client).toMatch(/toast\.error|setProfileError|setPasswordError/);
    expect(client).toMatch(/Loader2/);
  });

  it("does not allow role or email editing through the profile form", () => {
    expect(client).not.toMatch(/name="role"/);
    expect(client).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*\brole\b/);
    expect(client).not.toMatch(/\brole:\s*["']admin["']/);
    expect(client).toMatch(/readOnly/);
  });

  it("never prefills a development email into the production login form", () => {
    expect(login).not.toMatch(/@social-media\.local/);
    expect(login).not.toMatch(/defaultValue/);
    expect(login).not.toMatch(/process\.env/);
    expect(login).toMatch(/useState\(""\)/);
    expect(login).toMatch(/autoComplete="off"/);
  });

  it("keeps password visibility controls and has no recovery link", () => {
    expect(login).not.toMatch(/forgot-password/i);
    expect(login).not.toMatch(/Forgot password/i);
    // The password field starts hidden and toggles through an accessible,
    // keyboard-operable button without losing the entered value.
    expect(login).toMatch(/type=\{showPassword \? "text" : "password"\}/);
    expect(login).toMatch(/aria-label=\{showPassword \? "Hide password" : "Show password"\}/);
    expect(login).toMatch(/EyeOff/);
    expect(login).toMatch(/Eye/);
    expect(login).toMatch(/autoComplete="current-password"/);
    expect(signup).toMatch(/type=\{showPassword \? "text" : "password"\}/);
    expect(signup).toMatch(/aria-label=\{showPassword \? "Hide password" : "Show password"\}/);
  });

  it("keeps profile and password APIs for the settings sections that remain", () => {
    expect(page).toMatch(/getAdminProfile/);
    expect(client).toMatch(/Change password/);
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
