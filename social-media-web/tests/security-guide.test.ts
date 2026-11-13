import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { GEOM, measureText, parseGuidePdf } from "../scripts/generate-security-guide.mjs";

// The security guide is a version-controlled, pre-generated static PDF asset
// (produced by scripts/generate-security-guide.mjs) linked from the Admin
// Settings reference section. These tests pin both halves of the feature: the
// document itself, the settings-page integration, and the layout quality of
// every generated page (bounds, wrapping, overlaps, callouts, references).

const readFile = (relativePath: string): string =>
  readFileSync(path.resolve(__dirname, "..", relativePath), "utf8");

const PDF_PATH = "public/Social-Console-Security-Guide.pdf";

// Shared parsed artifact for the layout tests below.
const pdfBuffer = readFileSync(path.resolve(__dirname, "..", PDF_PATH));
const pdfText = pdfBuffer.toString("latin1");
const parsed = parseGuidePdf(pdfText);
const runsWithWidth = parsed.pages.map((page) =>
  page.runs.map((run) => ({
    ...run,
    width: measureText(run.text, run.font, run.size, run.tc),
  })),
);

const SECTION_TITLES = [
  "Account Security",
  "Authentication & Password Protection",
  "Session Management",
  "Social Account & OAuth Security",
  "Publishing Safety",
  "Data Protection & Privacy",
  "Administrative Responsibilities",
];

describe("security guide PDF asset", () => {
  it("exists as a real, version-controlled PDF document", () => {
    expect(pdfBuffer.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfText.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(pdfBuffer.byteLength).toBeGreaterThan(10_000);
  });

  it("is a well-formed PDF with a catalog, pages, and A4 media box", () => {
    expect(pdfText).toContain("/Type /Catalog");
    expect(pdfText).toContain("/Type /Pages");
    expect(pdfText).toContain("/MediaBox [0 0 595.28 841.89]");
    // Cover + contents + 7 section pages, at minimum.
    const pageCount = (pdfText.match(/\/Type \/Page[^s]/g) ?? []).length;
    expect(pageCount).toBeGreaterThanOrEqual(9);
  });

  it("has a valid xref table pointing at every object", () => {
    const start = Number(/startxref\s+(\d+)/.exec(pdfText)?.[1]);
    expect(pdfText.slice(start, start + 4)).toBe("xref");
    const rows = pdfText.slice(start).split("\n");
    const count = Number(rows[1].split(" ")[1]);
    let bad = 0;
    for (let i = 1; i < count; i++) {
      const offset = Number(rows[2 + i].slice(0, 10));
      const want = `${i} 0 obj`;
      if (pdfText.slice(offset, offset + want.length) !== want) bad++;
    }
    expect(bad).toBe(0);
  });

  it("contains the full title, subtitle, and a table of contents", () => {
    expect(pdfText).toContain("Security & Account");
    expect(pdfText).toContain("Protection Guide");
    expect(pdfText).toContain("Understanding how your account, data, authentication");
    expect(pdfText).toContain("Contents");
  });

  it("contains all seven required sections, each starting on a fresh page", () => {
    SECTION_TITLES.forEach((title, index) => {
      expect(pdfText).toContain(`SECTION ${index + 1}`);
      expect(pdfText).toContain(`(${title})`);
      // Every section begins at the very top of its own page.
      const sectionPage = parsed.pages.findIndex(
        (page) =>
          page.runs.some((run) => run.text === `SECTION ${index + 1}`) &&
          page.runs.some((run) => run.text === title),
      );
      expect(sectionPage).toBeGreaterThan(1);
      const contentRuns = parsed.pages[sectionPage].runs.filter(
        (run) => run.y < GEOM.HEADER_BASELINE - 2,
      );
      const topBaseline = Math.max(...contentRuns.map((run) => run.y));
      expect(topBaseline).toBeCloseTo(GEOM.TOP, 1);
    });
  });

  it("labels enforced behavior separately from recommended practices", () => {
    expect(pdfText).toContain("Enforced by the application");
    expect(pdfText).toContain("Recommended practice - not enforced");
  });

  it("carries page numbering and running header/footer", () => {
    expect(pdfText).toMatch(/Page \d+ of \d+/);
    expect(pdfText).toContain("SOCIAL CONSOLE");
    expect(pdfText).toContain("Social-Console-Security-Guide.pdf");
  });

  it("carries document metadata and outline bookmarks", () => {
    expect(pdfText).toContain("/Title (Social Console - Security & Account Protection Guide)");
    expect(pdfText).toContain("/Type /Outlines");
    expect((pdfText.match(/\/Dest /g) ?? []).length).toBe(7);
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
      expect(pdfText).not.toContain(needle);
    }
  });

  it("is the only PDF served from public/", () => {
    const files = readdirSync(path.resolve(__dirname, "..", "public"));
    expect(files.filter((file) => file.endsWith(".pdf"))).toEqual([
      "Social-Console-Security-Guide.pdf",
    ]);
  });
});

describe("pdf layout validation", () => {
  const { PAGE_W, MARGIN, TOP, BOTTOM, HEADER_BASELINE, FOOTER_BASELINE } = GEOM;
  const RIGHT = PAGE_W - MARGIN;

  it("keeps every text run inside the horizontal content margins", () => {
    const offenders: string[] = [];
    runsWithWidth.forEach((runs, pageIndex) => {
      for (const run of runs) {
        if (run.x < MARGIN - 0.75) {
          offenders.push(`page ${pageIndex + 1}: "${run.text}" starts left of the margin at x=${run.x}`);
        }
        if (run.x + run.width > RIGHT + 0.75) {
          offenders.push(
            `page ${pageIndex + 1}: "${run.text}" ends at x=${(run.x + run.width).toFixed(2)}, past the right margin ${RIGHT.toFixed(2)}`,
          );
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("keeps content text between the header rule and the footer rule", () => {
    const offenders: string[] = [];
    runsWithWidth.forEach((runs, pageIndex) => {
      for (const run of runs) {
        const isFrameRun = run.y >= HEADER_BASELINE - 2 || run.y <= FOOTER_BASELINE + 2;
        if (isFrameRun) continue;
        if (run.y > TOP + 2 || run.y < BOTTOM - 1) {
          offenders.push(
            `page ${pageIndex + 1}: "${run.text}" baseline y=${run.y} outside content band [${BOTTOM}, ${TOP}]`,
          );
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("never overlaps text runs on the same page", () => {
    const offenders: string[] = [];
    runsWithWidth.forEach((runs, pageIndex) => {
      const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          if (Math.abs(a.y - b.y) >= 0.75 * Math.min(a.size, b.size)) break; // sorted by y desc
          const overlapX = a.x < b.x + b.width && b.x < a.x + a.width;
          if (overlapX) {
            offenders.push(
              `page ${pageIndex + 1}: "${a.text}" and "${b.text}" overlap near y=${a.y}`,
            );
          }
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("flows wrapped paragraphs without vertical collisions between lines", () => {
    // Line spacing must be at least ~1.15x the font size everywhere.
    const offenders: string[] = [];
    runsWithWidth.forEach((runs, pageIndex) => {
      const content = runs
        .filter((run) => run.y < HEADER_BASELINE - 2 && run.y > FOOTER_BASELINE + 2)
        .sort((a, b) => b.y - a.y);
      for (let i = 1; i < content.length; i++) {
        const gap = content[i - 1].y - content[i].y;
        // gap === 0 means a side-by-side run (e.g. a right-aligned page
        // number); horizontal collisions are covered by the overlap test.
        if (gap <= 0.5) continue;
        const minGap = 0.9 * Math.max(content[i - 1].size, content[i].size);
        if (gap < minGap) {
          offenders.push(
            `page ${pageIndex + 1}: lines "${content[i - 1].text}" and "${content[i].text}" are ${gap.toFixed(1)}pt apart`,
          );
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("keeps subheadings with at least one following content line", () => {
    const offenders: string[] = [];
    runsWithWidth.forEach((runs, pageIndex) => {
      for (const run of runs) {
        if (run.font !== "F2" || run.size !== 13) continue; // h2 subheadings only
        const follower = runs.find(
          // h2 leaves a (15 + 6)pt step before the following baseline
          (other) =>
            other !== run && Math.abs(run.y - 21 - other.y) < 1.5 && other.x >= run.x,
        );
        if (!follower) {
          offenders.push(`page ${pageIndex + 1}: subheading "${run.text}" has no content line below it on the same page`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("contains every callout's text inside its box", () => {
    const offenders: string[] = [];
    let boxCount = 0;
    runsWithWidth.forEach((runs, pageIndex) => {
      const boxes = parsed.pages[pageIndex].rects.filter(
        (rect) => rect.w > GEOM.PAGE_W - 2 * GEOM.MARGIN - 1 && rect.h > 20,
      );
      boxCount += boxes.length;
      for (const box of boxes) {
        const inside = runs.filter(
          (run) =>
            run.x >= box.x - 1 &&
            run.x < box.x + box.w &&
            run.y >= box.y - 1 &&
            run.y <= box.y + box.h + 1,
        );
        expect(inside.length, `page ${pageIndex + 1}: callout box has text`).toBeGreaterThanOrEqual(2);
        for (const run of inside) {
          if (run.x + run.width > box.x + box.w - 6) {
            offenders.push(
              `page ${pageIndex + 1}: "${run.text}" pokes out of its callout box on the right`,
            );
          }
          if (run.y - run.size * 0.212 < box.y - 0.5) {
            offenders.push(`page ${pageIndex + 1}: "${run.text}" pokes out of its callout box at the bottom`);
          }
          if (run.y + run.size * 0.75 > box.y + box.h + 0.5) {
            offenders.push(`page ${pageIndex + 1}: "${run.text}" pokes out of its callout box at the top`);
          }
        }
      }
    });
    expect(offenders).toEqual([]);
    expect(boxCount).toBe(7); // one callout per section
  });

  it("numbers pages sequentially and consistently", () => {
    const total = parsed.pages.length;
    parsed.pages.forEach((page, pageIndex) => {
      const match = /Page (\d+) of (\d+)/.exec(page.raw);
      if (pageIndex === 0) {
        expect(match).toBeNull(); // cover carries no footer
        return;
      }
      expect(match, `page ${pageIndex + 1} has a footer`).not.toBeNull();
      expect(Number(match?.[1])).toBe(pageIndex + 1);
      expect(Number(match?.[2])).toBe(total);
    });
  });

  it("matches the table of contents page numbers to actual section pages", () => {
    const toc = parsed.pages[1];
    const entries: Array<{ num: number; title: string; page: number }> = [];
    const titleRuns = toc.runs.filter((run) => run.size === 11 && run.font === "F1" && /^\d\. {2}/.test(run.text));
    const numberRuns = toc.runs.filter((run) => run.size === 11 && run.font === "F1" && /^\d+$/.test(run.text) && run.x > GEOM.PAGE_W / 2);
    expect(titleRuns.length).toBe(7);
    expect(numberRuns.length).toBe(7);
    titleRuns.forEach((run, index) => {
      const num = Number(/^(\d)\./.exec(run.text)?.[1]);
      entries.push({
        num,
        title: run.text.replace(/^\d\.\s+/, ""),
        page: Number(numberRuns[index].text),
      });
    });

    entries.forEach((entry) => {
      const actualPage = parsed.pages.findIndex(
        (page, index) =>
          index >= 2 &&
          page.runs.some((run) => run.text === `SECTION ${entry.num}`) &&
          page.runs.some((run) => run.text === entry.title),
      );
      expect(actualPage, `section ${entry.num} (${entry.title})`).toBeGreaterThan(1);
      expect(entry.page).toBe(actualPage + 1);
    });
  });

  it("points every outline bookmark at its section's first page", () => {
    const dests = [...pdfText.matchAll(/\/Dest \[(\d+) 0 R \/XYZ/g)].map((m) => Number(m[1]));
    expect(dests.length).toBe(7);
    // Page objects are serialized in page order.
    const pageObjNums = [...pdfText.matchAll(/(\d+) 0 obj\n<< \/Type \/Page \/Parent/g)].map((m) => Number(m[1]));
    dests.forEach((destObj, index) => {
      const pageIndex = pageObjNums.indexOf(destObj);
      expect(pageIndex, `bookmark ${index + 1}`).toBeGreaterThan(1);
      const page = parsed.pages[pageIndex];
      expect(page.runs.some((run) => run.text === `SECTION ${index + 1}`)).toBe(true);
      expect(page.runs.some((run) => run.text === SECTION_TITLES[index])).toBe(true);
    });
  });

  it("keeps bullet markers aligned with their first text line", () => {
    const offenders: string[] = [];
    parsed.pages.forEach((page, pageIndex) => {
      const markers = page.rects.filter(
        (rect) => Math.abs(rect.x - (GEOM.MARGIN + 1.5)) < 0.5 && Math.abs(rect.w - 3) < 0.5,
      );
      const bulletTexts = page.runs.filter((run) => Math.abs(run.x - (GEOM.MARGIN + 16)) < 0.5);
      for (const marker of markers) {
        // The marker square sits on the cap band of the bullet's first line:
        // text baseline = marker.y - 2.2 (see bullet() in the generator).
        const aligned = bulletTexts.some(
          (run) => Math.abs(run.y - marker.y + 2.2) < 1.2,
        );
        if (!aligned) {
          offenders.push(`page ${pageIndex + 1}: bullet marker at y=${marker.y} has no aligned text line`);
        }
      }
    });
    expect(offenders).toEqual([]);
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
