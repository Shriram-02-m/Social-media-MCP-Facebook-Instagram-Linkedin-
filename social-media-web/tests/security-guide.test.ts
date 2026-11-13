import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The security guide is a version-controlled, pre-generated static PDF asset
// (produced by scripts/generate-security-guide.mjs) linked from the Admin
// Settings reference section. These tests pin both halves of the feature: the
// document itself and the settings-page integration.

const readFile = (relativePath: string): string =>
  readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");

const PDF_PATH = "public/Social-Console-Security-Guide.pdf";

describe("security guide PDF asset", () => {
  const pdf = readFileSync(path.resolve(__dirname, "..", PDF_PATH));
  const text = pdf.toString("latin1");

  it("exists as a real, version-controlled PDF document", () => {
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdf.byteLength).toBeGreaterThan(10_000);
  });

  it("is a well-formed PDF with a catalog, pages, and A4 media box", () => {
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/Type /Pages");
    expect(text).toContain("/MediaBox [0 0 595.28 841.89]");
    // Cover + contents + 7 section pages, at minimum.
    const pageCount = (text.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(9);
  });

  it("contains the full title, subtitle, and a table of contents", () => {
    expect(text).toContain("Security & Account");
    expect(text).toContain("Protection Guide");
    expect(text).toContain("Understanding how your account, data, authentication");
    expect(text).toContain("Contents");
  });

  it("contains all seven required sections, each starting on a fresh page", () => {
    const titles = [
      "Account Security",
      "Authentication & Password Protection",
      "Session Management",
      "Social Account & OAuth Security",
      "Publishing Safety",
      "Data Protection & Privacy",
      "Administrative Responsibilities",
    ];
    for (const [index, title] of titles.entries()) {
      expect(text).toContain(`SECTION ${index + 1}`);
      expect(text).toContain(`(${title})`);
    }
  });

  it("labels enforced behavior separately from recommended practices", () => {
    expect(text).toContain("Enforced by the application");
    expect(text).toContain("Recommended practice - not enforced");
  });

  it("carries page numbering and running header/footer", () => {
    expect(text).toMatch(/Page \d+ of \d+/);
    expect(text).toContain("SOCIAL CONSOLE");
    expect(text).toContain("Social-Console-Security-Guide.pdf");
  });

  it("carries document metadata and outline bookmarks", () => {
    expect(text).toContain("/Title (Social Console - Security & Account Protection Guide)");
    expect(text).toContain("/Type /Outlines");
    expect((text.match(/\/Dest /g) ?? []).length).toBe(7);
  });

  it("contains no secrets, credentials, or private account data", () => {
    const forbidden = [
      "RESEND_API_KEY",
      "EMAIL_DELIVERY_TOKEN",
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "TOKEN_ENCRYPTION_KEY",
      "CLOUD_TOKEN_ENCRYPTION_KEY",
      "APP_CREDENTIAL_ENCRYPTION_KEY",
      "sk-",
      "sbp_",
      "@gmail.com",
      "@social-media.local",
      "session_token",
      "PASSWORD_MIN_LENGTH =",
    ];
    for (const needle of forbidden) {
      expect(text).not.toContain(needle);
    }
  });

  it("is the only PDF served from public/", () => {
    const files = readdirSync(path.resolve(__dirname, "..", "public"));
    expect(files.filter((file) => file.endsWith(".pdf"))).toEqual([
      "Social-Console-Security-Guide.pdf",
    ]);
  });
});

describe("security guide link integration", () => {
  const page = readFile("src/app/(dashboard)/admin/settings/page.tsx");

  it("renders the reference heading as a download link to the guide", () => {
    expect(page).toContain('href="/Social-Console-Security-Guide.pdf"');
    expect(page).toContain('download="Social-Console-Security-Guide.pdf"');
    expect(page).toContain("How this console protects your account");
  });

  it("shows a PDF/download icon and the documented description", () => {
    expect(page).toContain("FileDown");
    expect(page).toContain("Read our security and account protection guide (PDF)");
  });

  it("keeps hover and focus-visible interactive styling", () => {
    expect(page).toContain("hover:bg-muted/50");
    expect(page).toContain("focus-visible:ring-[3px]");
    expect(page).toContain("focus-visible:ring-ring/50");
  });

  it("keeps the four informational reference cards", () => {
    for (const card of [
      "Signed-in administrator",
      "Account model",
      "Publishing safety",
      "Data handling",
    ]) {
      expect(page).toContain(card);
    }
  });

  it("does not reintroduce removed modules", () => {
    expect(page).not.toContain("Account recovery");
    expect(page).not.toContain("Activity log");
  });

  it("serves the guide with the correct content type and attachment disposition", () => {
    const config = readFile("next.config.ts");
    expect(config).toContain('"/Social-Console-Security-Guide.pdf"');
    expect(config).toContain('"Content-Type"');
    expect(config).toContain("application/pdf");
    expect(config).toContain('"Content-Disposition"');
    expect(config).toContain('attachment; filename="Social-Console-Security-Guide.pdf"');
  });
});
