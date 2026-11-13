#!/usr/bin/env node
// Generates public/Social-Console-Security-Guide.pdf with zero dependencies.
//
// The PDF is hand-rolled from primitives: base-14 Helvetica fonts, uncompressed
// content streams (so the document is greppable in tests), A4 media box, a
// cover page, a table of contents, seven sections that each start on a fresh
// page, running headers/footers with "Page N of M", document metadata, and
// outline bookmarks. Every security statement in the copy is reviewed against
// the implemented application behavior; see tests/security-guide.test.ts.
//
// Layout engine rules (fixed after the v1 overlap/overflow bugs):
//   * Every text operation states its full text state explicitly (Tc is always
//     emitted, even when 0). PDF text state persists across BT/ET, so an op
//     that omits Tc would inherit letter spacing from an earlier op and render
//     wider than measured — the original right-margin overflow bug.
//   * Every block (paragraph, bullet, heading, callout) is measured before it
//     is drawn. `ensure(height)` starts a new page when the block does not fit,
//     so nothing can overlap the header, footer, or page bottom.
//   * Subheadings keep at least two lines of the following block on the same
//     page (keep-with-next); bullets are never split; paragraphs flow across
//     pages but never leave a single orphan line behind.
//   * Wrapping uses real font metrics with a small safety factor so viewers
//     that substitute Helvetica with slightly wider fonts (e.g. Arial) cannot
//     push a line past the right margin.
//
// Usage: node scripts/generate-security-guide.mjs
// Output: ../public/Social-Console-Security-Guide.pdf (relative to scripts/).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, "../public/Social-Console-Security-Guide.pdf");

// ---------------------------------------------------------------------------
// Geometry and palette
// ---------------------------------------------------------------------------

export const GEOM = {
  PAGE_W: 595.28, // A4 width in points
  PAGE_H: 841.89, // A4 height in points
  MARGIN: 64,
  TOP: 776, // first content baseline on a page
  BOTTOM: 76, // lowest allowed content baseline
  HEADER_BASELINE: 813,
  HEADER_RULE: 806,
  FOOTER_RULE: 54,
  FOOTER_BASELINE: 42,
};
const { PAGE_W, PAGE_H, MARGIN, TOP, BOTTOM } = GEOM;
const CONTENT_W = PAGE_W - 2 * MARGIN;
// Extra headroom on every wrapped line: PDF viewers frequently substitute
// Helvetica with Arial, whose glyphs run slightly wider. 1.04 keeps such lines
// inside the margin; it only makes wraps marginally earlier.
const WRAP_SAFETY = 1.04;

const COLOR = {
  text: "0.067 0.094 0.153 rg", // near-black slate
  muted: "0.420 0.447 0.502 rg", // gray
  brand: "0.145 0.388 0.922 rg", // blue
  brandStroke: "0.145 0.388 0.922 RG",
  rule: "0.898 0.906 0.922 RG", // light gray line
  ruleFill: "0.898 0.906 0.922 rg",
  white: "1 1 1 rg",
  calloutEnforced: "0.937 0.965 1 rg", // light blue
  calloutAdvice: "0.965 0.973 0.980 rg", // light gray
  slate: "0.200 0.251 0.325 RG",
};

// Vertical rhythm (points). One place defines the document's spacing system.
const SPACING = {
  paragraphLeading: 15,
  paragraphGap: 9, // extra space below a paragraph
  bulletLeading: 14.5,
  bulletGap: 4, // between bullets in a list
  bulletListGap: 10, // after the last bullet of a list
  h2Above: 13,
  h2Below: 6,
  calloutLeading: 13.5,
  calloutPadTop: 9, // box top above the label baseline
  calloutLabelGap: 13, // label baseline to first body baseline
  calloutPadBottom: 9, // box bottom below the last body baseline
  calloutGap: 13, // after the box
  noteLeading: 13,
};

// ---------------------------------------------------------------------------
// Font metrics (AFM widths, /1000, ASCII 32..126)
// ---------------------------------------------------------------------------

const W_HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];
const FONT_WIDTHS = { F1: W_HELV, F2: W_BOLD, F3: W_HELV }; // Oblique == regular metrics

export function measureText(str, font, size, letterSpacing = 0) {
  const table = FONT_WIDTHS[font] ?? W_HELV;
  let total = 0;
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    total += code >= 32 && code <= 126 ? table[code - 32] : 500;
  }
  return (total / 1000) * size + Math.max(0, str.length - 1) * letterSpacing;
}

/** Greedy word wrap with real metrics. Never splits words; never exceeds maxWidth. */
export function wrapText(text, font, size, maxWidth, letterSpacing = 0) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    const measured = measureText(candidate, font, size, letterSpacing) * WRAP_SAFETY;
    if (measured <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function esc(str) {
  return str.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function unescapePdfString(str) {
  return str.replace(/\\([()\\])/g, "$1");
}

// ---------------------------------------------------------------------------
// Content-stream op builders. Tc is ALWAYS emitted: text state persists across
// BT/ET, and an omitted Tc would inherit letter spacing from an earlier op.
// ---------------------------------------------------------------------------

function txt(x, y, str, font, size, fill, letterSpacing = 0) {
  return `BT /${font} ${size} Tf ${fill} ${letterSpacing} Tc ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(str)}) Tj ET\n`;
}

function rect(x, y, w, h, fill) {
  return `${fill} ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`;
}

function hline(x1, x2, y, widthPt) {
  return `${COLOR.rule} ${widthPt} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S\n`;
}

function rightX(str, font, size, right, letterSpacing = 0) {
  return right - measureText(str, font, size, letterSpacing);
}

// ---------------------------------------------------------------------------
// Page flow: block-based placement with pre-computed heights
// ---------------------------------------------------------------------------

const pages = []; // { ops, header } — header text shown top-right
let ops = "";
let y = TOP;
let header = "";
const sectionStartPage = [];

function beginPage() {
  pages.push({ ops, header });
  ops = "";
  y = TOP;
}

/** Starts a new page unless the block (plus its trailing space) fits. */
function ensure(height) {
  if (y - height < BOTTOM) beginPage();
}

/**
 * Places wrapped lines top-down, flowing across pages. Orphan control: a
 * paragraph never starts with a single line at the bottom of a page.
 */
function placeLines(lines, x, font, size, fill, leading) {
  let i = 0;
  for (;;) {
    const remaining = lines.length - i;
    const available = Math.max(0, Math.floor((y - BOTTOM + 0.01) / leading));
    if (available === 0) {
      beginPage();
      continue;
    }
    const take = Math.min(remaining, available);
    if (take === 1 && remaining >= 2 && i === 0) {
      beginPage(); // orphan line: move the whole start to the next page
      continue;
    }
    let baseline = y;
    for (let k = 0; k < take; k++) {
      ops += txt(x, baseline, lines[i + k], font, size, fill);
      baseline -= leading;
    }
    y = baseline;
    i += take;
    if (i < lines.length) {
      beginPage();
      continue;
    }
    return;
  }
}

function paragraph(text, opts = {}) {
  const {
    font = "F1",
    size = 10,
    leading = SPACING.paragraphLeading,
    fill = COLOR.text,
    indent = 0,
    gapAfter = SPACING.paragraphGap,
    maxWidth = CONTENT_W - indent,
  } = opts;
  const lines = wrapText(text, font, size, maxWidth);
  placeLines(lines, MARGIN + indent, font, size, fill, leading);
  y -= gapAfter;
}

/** Subheading: keep-with-next — needs room for itself plus 2 lines below. */
function heading(text, followMinHeight) {
  const selfHeight = SPACING.h2Above + SPACING.paragraphLeading + SPACING.h2Below;
  ensure(selfHeight + (followMinHeight ?? 0));
  y -= SPACING.h2Above;
  ops += txt(MARGIN, y, text, "F2", 13, COLOR.text);
  y -= SPACING.paragraphLeading + SPACING.h2Below;
}

function bullet(item, isLast) {
  const lines = wrapText(item, "F1", 10, CONTENT_W - 16);
  const leading = SPACING.bulletLeading;
  const gap = isLast ? SPACING.bulletListGap : SPACING.bulletGap;
  ensure(lines.length * leading + gap); // a bullet is never split across pages
  const markerY = y + 2.2;
  ops += rect(MARGIN + 1.5, markerY, 3, 3, COLOR.brand);
  let baseline = y;
  for (const line of lines) {
    ops += txt(MARGIN + 16, baseline, line, "F1", 10, COLOR.text);
    baseline -= leading;
  }
  y = baseline - gap;
}

function bullets(items) {
  items.forEach((item, index) => bullet(item, index === items.length - 1));
}

/** Callout box with a height computed from its wrapped content. */
function callout(label, text, tone) {
  const size = 9.5;
  const leading = SPACING.calloutLeading;
  const lines = wrapText(text, "F1", size, CONTENT_W - 30);
  const boxHeight =
    SPACING.calloutPadTop +
    SPACING.calloutLabelGap +
    (lines.length - 1) * leading +
    SPACING.calloutPadBottom;
  ensure(boxHeight + SPACING.calloutGap);
  const boxBottom = y - SPACING.calloutLabelGap - (lines.length - 1) * leading - SPACING.calloutPadBottom;
  const bg = tone === "enforced" ? COLOR.calloutEnforced : COLOR.calloutAdvice;
  const barFill = tone === "enforced" ? COLOR.brand : COLOR.slate.replace(" RG", " rg");
  ops += rect(MARGIN, boxBottom, CONTENT_W, boxHeight, bg);
  ops += rect(MARGIN, boxBottom, 3, boxHeight, barFill);
  ops += txt(MARGIN + 14, y, label, "F2", 9, COLOR.text);
  let baseline = y - SPACING.calloutLabelGap;
  for (const line of lines) {
    ops += txt(MARGIN + 14, baseline, line, "F1", size, COLOR.text);
    baseline -= leading;
  }
  y = boxBottom - SPACING.calloutGap;
}

function note(text) {
  paragraph(text, {
    font: "F3",
    size: 9,
    leading: SPACING.noteLeading,
    fill: COLOR.muted,
    gapAfter: SPACING.paragraphGap,
  });
}

// ---------------------------------------------------------------------------
// The document copy (kept truthful to the implemented behavior)
// ---------------------------------------------------------------------------

const sections = [
  {
    title: "Account Security",
    blocks: [
      { t: "p", x: "Social Console is administered by a single administrator account: the Super Admin. The protections in this section are built into the application and its database schema, so they hold without any optional configuration." },
      { t: "h2", x: "What is enforced" },
      { t: "bullets", items: [
        "Only one Super Admin account can exist. A database-level unique index on the administrator role prevents a second admin account from ever being created.",
        "New registrations do not receive access automatically. Every new account starts in a pending state and must be approved by the Super Admin before it can sign in.",
        "Suspended and deleted accounts cannot use the application. When an account is suspended or soft-deleted, its sessions are revoked and its scheduled posts are held so nothing is published on its behalf.",
        "The Super Admin account cannot be suspended, deleted, or downgraded. Safeguards protect the only account able to administer the console.",
        "Admin privileges are verified server-side on every request. The role is never trusted from the browser: admin pages and admin APIs re-check the live session and the account state before doing any work.",
      ] },
      { t: "callout", tone: "enforced", label: "Enforced by the application", x: "Everything in this section is enforced by the server and the database. No administrator action is required to keep these protections active." },
      { t: "note", x: "Administrative changes to individual user accounts are made from the Users pages, not from Settings." },
    ],
  },
  {
    title: "Authentication & Password Protection",
    blocks: [
      { t: "p", x: "Authentication is provided by Better Auth. Passwords are stored only in hashed form and are verified by the authentication library at sign-in. Plain-text passwords are never persisted, displayed, or returned by an API." },
      { t: "h2", x: "Password requirements" },
      { t: "bullets", items: [
        "A password must be at least 12 characters long (up to 128).",
        "It must contain characters from at least three of these four classes: lowercase letters, uppercase letters, numbers, and symbols.",
        "The rules are checked instantly in the settings form and are validated again on the server before any password change is accepted.",
      ] },
      { t: "h2", x: "Changing your password" },
      { t: "bullets", items: [
        "Changing the password requires your current password, so a stolen unlocked browser alone is not enough.",
        "Better Auth performs the update and revokes every other signed-in session in the same operation, so a password change immediately signs out unknown devices.",
        "The change is recorded in the activity infrastructure as an administrative security event.",
      ] },
      { t: "h2", x: "Email one-time codes" },
      { t: "bullets", items: [
        "Where email verification is configured, the console uses 6-digit one-time codes that expire after 5 minutes, allow at most 3 attempts, and enforce a 60-second cooldown between resend requests.",
        "One-time codes are stored in hashed form and are never written to logs or audit metadata.",
        "Codes are delivered by email through the configured transport (Resend or a generic HTTPS delivery webhook). Delivery failures are deliberately indistinguishable from an unknown email address, so responses do not reveal whether an account exists.",
        "Completing a password reset through a one-time code revokes every existing session once the new password is set.",
      ] },
      { t: "callout", tone: "enforced", label: "Enforced by the application", x: "Password rules, hashed credential storage, one-time-code limits, and session revocation on password changes and resets are all enforced server-side." },
    ],
  },
  {
    title: "Session Management",
    blocks: [
      { t: "p", x: "Every sign-in creates an independent server-side session. The browser only holds a signed session cookie; the session record itself lives in the database and can be inspected and revoked from Settings." },
      { t: "bullets", items: [
        "Sessions expire after 7 days, and end earlier when you sign out, change your password, or complete a password reset.",
        "The Active sessions list in Settings shows every browser currently signed in, with the device and browser, the last active time, and the expiration time.",
        "Your current device is marked as the current session so you can tell it apart from other devices at a glance.",
        "The Sign out other sessions action revokes every session except the one you are using, after a confirmation step.",
        "Every request re-validates the session server-side. A revoked or expired session is rejected immediately, even if the browser still holds the cookie.",
      ] },
      { t: "callout", tone: "enforced", label: "Enforced by the application", x: "Session creation, expiration, server-side validation, and revocation are handled by the authentication library and verified on every admin request. Session tokens are never displayed in the dashboard." },
    ],
  },
  {
    title: "Social Account & OAuth Security",
    blocks: [
      { t: "p", x: "Publishing works through social accounts that you connect from Facebook, Instagram, and LinkedIn. Connections are authorized with OAuth: you approve access on the provider's site, and the console never sees your social network password." },
      { t: "bullets", items: [
        "OAuth access tokens and refresh tokens are encrypted with AES-256-GCM before they are stored. The encryption key is held in server-side environment configuration and is never written to the database.",
        "Tokens and app credentials are never displayed in the dashboard and are never returned by an API response.",
        "Only non-secret connection metadata, such as the account or page name, the platform, and the connection status, is shown in the console.",
        "Expired or invalid connections fail safely. A publish attempt against a bad connection fails and is recorded instead of silently continuing; the account can then be reconnected.",
      ] },
      { t: "callout", tone: "enforced", label: "Enforced by the application", x: "Encryption of social tokens at rest and the omission of secrets from every dashboard and API response are implemented in the publishing worker and its credential store." },
    ],
  },
  {
    title: "Publishing Safety",
    blocks: [
      { t: "p", x: "Scheduling is backed by PostgreSQL. The publishing worker claims due posts with row-level locks so that a post is processed by exactly one worker, exactly once." },
      { t: "bullets", items: [
        "Due posts are claimed with SELECT ... FOR UPDATE SKIP LOCKED. The row lock makes duplicate publishing impossible, even if several workers run at the same time.",
        "The claim query refuses posts that belong to suspended or deleted accounts. This hold is enforced at the database level, so a suspension and a worker claim cannot race each other.",
        "Held posts stay held until an administrator resumes them. Resuming an overdue held post is blocked; the post must be rescheduled instead of being published immediately, which prevents surprise duplicate or late publishing.",
        "Every create, hold, resume, retry, publish, and failure is recorded in the activity infrastructure with a scheduled_post action.",
      ] },
      { t: "callout", tone: "enforced", label: "Enforced by the application", x: "Row-level claim locking, account-state enforcement, hold behavior, and audit logging of publishing actions are part of the scheduler's core transaction logic." },
      { t: "note", x: "Administrators can review every scheduled post, including held and failed ones, from the Scheduler page." },
    ],
  },
  {
    title: "Data Protection & Privacy",
    blocks: [
      { t: "bullets", items: [
        "Sensitive values such as social tokens, OAuth secrets, and passwords are never displayed in the dashboard and are never returned by an admin API.",
        "Social account tokens remain encrypted at rest with AES-256-GCM.",
        "Activity metadata is sanitized before it is stored. Passwords, tokens, secrets, and encryption keys never enter activity records.",
        "Every admin API request verifies the Super Admin session server-side before it processes data.",
        "Database access runs server-side through an authorized service connection. An optional hardening migration additionally enables row-level security on the scheduling and authentication tables and revokes direct browser-facing access to them.",
        "Deleting a user is a soft delete that preserves audit history, and account relationships are protected by database foreign keys.",
      ] },
      { t: "callout", tone: "enforced", label: "Enforced by the application", x: "Sanitization, encryption, server-side authorization, and audit-preserving deletion are implemented in the application code and reviewed by the automated test suite." },
    ],
  },
  {
    title: "Administrative Responsibilities",
    blocks: [
      { t: "p", x: "Most protections described in this guide run automatically. A smaller set of good practices depends on you as the administrator. These are recommendations, not enforced features." },
      { t: "h2", x: "Recommended practices" },
      { t: "bullets", items: [
        "Use a strong, unique administrator password that meets the console minimum of 12 characters with three of four character types, and do not reuse it on other services.",
        "Never share administrator credentials or one-time codes with anyone. No legitimate support process will ask for them.",
        "Sign out other sessions from Settings when a device is lost, replaced, or no longer used.",
        "Review social account connection statuses periodically and reconnect any expired or invalid connection before its next scheduled post.",
        "Review scheduled posts before their publish window and hold anything that is not ready to go out.",
        "Keep the authentication and email delivery configuration valid and up to date so one-time codes and security messages actually arrive.",
      ] },
      { t: "callout", tone: "advice", label: "Recommended practice - not enforced", x: "The items in this section are operational advice for administrators. They complement, but are not enforced by, the application." },
    ],
  },
];

// ---------------------------------------------------------------------------
// Cover page (fixed canvas, all text states explicit)
// ---------------------------------------------------------------------------

function coverOps() {
  let s = "";
  s += rect(0, PAGE_H - 7, PAGE_W, 7, COLOR.brand);
  // Brand mark
  s += rect(MARGIN, 692, 52, 52, COLOR.brand);
  const scWidth = measureText("SC", "F2", 20, 0.5);
  s += txt(MARGIN + (52 - scWidth) / 2, 711, "SC", "F2", 20, COLOR.white, 0.5);
  s += txt(MARGIN, 662, "SOCIAL CONSOLE", "F2", 10, COLOR.brand, 2.2);
  // Title
  s += txt(MARGIN, 604, "Security & Account", "F2", 34, COLOR.text);
  s += txt(MARGIN, 560, "Protection Guide", "F2", 34, COLOR.text);
  s += rect(MARGIN, 534, 40, 3, COLOR.brand);
  // Subtitle
  let sy = 506;
  for (const line of wrapText(
    "Understanding how your account, data, authentication, and publishing activities are protected.",
    "F1", 11.5, CONTENT_W - 40,
  )) {
    s += txt(MARGIN, sy, line, "F1", 11.5, COLOR.muted);
    sy -= 17;
  }
  // Scope paragraph
  sy -= 10;
  for (const line of wrapText(
    "This guide describes the protections implemented in the Social Console admin application and its publishing worker. Sections marked 'Enforced by the application' describe server-side behavior. Section 7 lists recommended administrator practices, which are marked separately.",
    "F1", 9.5, CONTENT_W - 40,
  )) {
    s += txt(MARGIN, sy, line, "F1", 9.5, COLOR.muted);
    sy -= 14;
  }
  // Bottom band
  s += hline(MARGIN, PAGE_W - MARGIN, 92, 0.8);
  s += txt(MARGIN, 78, "Document version 1.0", "F1", 8, COLOR.muted);
  s += txt(rightX("Social-Console-Security-Guide.pdf", "F1", 8, PAGE_W - MARGIN), 78,
    "Social-Console-Security-Guide.pdf", "F1", 8, COLOR.muted);
  return s;
}

// ---------------------------------------------------------------------------
// Table of contents (built after the layout pass knows section pages)
// ---------------------------------------------------------------------------

function tocOps(entries) {
  let s = "";
  s += txt(MARGIN, TOP, "Contents", "F2", 20, COLOR.text);
  s += rect(MARGIN, TOP - 14, 40, 3, COLOR.brand);
  let ty = TOP - 52;
  for (const entry of entries) {
    const label = `${entry.num}.  ${entry.title}`;
    const numStr = String(entry.page);
    s += txt(MARGIN, ty, label, "F1", 11, COLOR.text);
    const numX = rightX(numStr, "F1", 11, PAGE_W - MARGIN);
    s += txt(numX, ty, numStr, "F1", 11, COLOR.muted);
    // thin leader between title and page number
    const titleW = measureText(label, "F1", 11);
    const lineStart = MARGIN + titleW + 10;
    const lineEnd = numX - 10;
    if (lineEnd > lineStart + 8) {
      s += `${COLOR.rule} 0.6 w ${lineStart.toFixed(2)} ${(ty + 3.2).toFixed(2)} m ${lineEnd.toFixed(2)} ${(ty + 3.2).toFixed(2)} l S\n`;
    }
    ty -= 27;
  }
  s += txt(MARGIN, ty - 20, "About this guide", "F2", 12, COLOR.text);
  ty -= 20 + 16 + 8;
  for (const line of wrapText(
    "This document is generated from the Social Console project and describes behavior that is implemented and enforced in the admin web application and its publishing worker. It contains no credentials, tokens, or private account data.",
    "F1", 9.5, CONTENT_W,
  )) {
    s += txt(MARGIN, ty, line, "F1", 9.5, COLOR.muted);
    ty -= 14;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Layout pass — sections each start on a fresh page
// ---------------------------------------------------------------------------

function layout() {
  beginPage(); // page 1: cover placeholder
  beginPage(); // page 2: TOC placeholder

  sections.forEach((section, index) => {
    if (ops !== "" || y !== TOP) beginPage();
    header = section.title;
    sectionStartPage[index] = pages.length; // page index where this section starts

    // Section heading block (always at the top of a fresh page)
    ops += txt(MARGIN, y, `SECTION ${index + 1}`, "F2", 8, COLOR.brand, 1.8);
    y -= 30;
    ops += txt(MARGIN, y, section.title, "F2", 21, COLOR.text);
    y -= 16;
    ops += rect(MARGIN, y, 34, 2.5, COLOR.brand);
    y -= 24;

    section.blocks.forEach((block, blockIndex) => {
      const next = section.blocks[blockIndex + 1];
      if (block.t === "p") paragraph(block.x);
      else if (block.t === "h2") heading(block.x, next ? 2 * SPACING.paragraphLeading : 0);
      else if (block.t === "note") note(block.x);
      else if (block.t === "bullets") bullets(block.items);
      else if (block.t === "callout") callout(block.label, block.x, block.tone);
    });
  });
  if (ops !== "" || y !== TOP) beginPage();
}

// ---------------------------------------------------------------------------
// Render headers/footers (fixed height, so layout is unaffected)
// ---------------------------------------------------------------------------

const DOC_LABEL = "Social Console - Security & Account Protection Guide";
const FILE_LABEL = "Social-Console-Security-Guide.pdf";

function frameOps(page, pageNumber, total) {
  let frame = "";
  // Running header
  frame += txt(MARGIN, GEOM.HEADER_BASELINE, "SOCIAL CONSOLE", "F2", 7, COLOR.brand, 1.4);
  const rightLabel = page.header || DOC_LABEL;
  const headerTc = 0.3;
  let label = rightLabel;
  while (measureText(label, "F1", 7, headerTc) > 200 && label.length > 4) label = label.slice(0, -2);
  if (label !== rightLabel) label = `${label}...`;
  frame += txt(rightX(label, "F1", 7, PAGE_W - MARGIN, headerTc), GEOM.HEADER_BASELINE, label, "F1", 7, COLOR.muted, headerTc);
  frame += hline(MARGIN, PAGE_W - MARGIN, GEOM.HEADER_RULE, 0.6);
  // Running footer
  frame += hline(MARGIN, PAGE_W - MARGIN, GEOM.FOOTER_RULE, 0.6);
  frame += txt(MARGIN, GEOM.FOOTER_BASELINE, FILE_LABEL, "F1", 7, COLOR.muted);
  const pageLabel = `Page ${pageNumber} of ${total}`;
  frame += txt(rightX(pageLabel, "F1", 7, PAGE_W - MARGIN), GEOM.FOOTER_BASELINE, pageLabel, "F1", 7, COLOR.muted);
  return frame;
}

// ---------------------------------------------------------------------------
// PDF serialization
// ---------------------------------------------------------------------------

const objects = []; // { body } — index + 1 = object number
function addObject(body) {
  objects.push(body);
  return objects.length; // 1-based object number
}

function serialize(finalPages) {
  // Reserve: 1 Catalog (filled last), 2 Pages, 3-5 Fonts, 6 Info. Pages follow,
  // then outlines. Filling the reserved bodies in place keeps every reference.
  addObject("CATALOG_PLACEHOLDER"); // 1
  const pagesObjNum = addObject("PAGES_PLACEHOLDER"); // 2
  const fontDefs = [
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
  ];
  for (const def of fontDefs) addObject(def); // 3, 4, 5
  const infoObjNum = addObject(
    "<< /Title (Social Console - Security & Account Protection Guide) " +
    "/Author (Social Console) " +
    "/Subject (How the Social Console protects accounts, authentication, sessions, social connections, publishing, and data) " +
    "/Creator (Social Console) /Producer (Social Console security guide generator) >>",
  ); // 6

  const kids = [];
  const pageObjNums = [];
  for (const content of finalPages) {
    const stream = Buffer.from(content, "utf8");
    const contentNum = addObject(
      `<< /Length ${stream.byteLength} >>\nstream\n${content}endstream`,
    );
    const pageNum = addObject(
      `<< /Type /Page /Parent ${pagesObjNum} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Contents ${contentNum} 0 R >>`,
    );
    kids.push(`${pageNum} 0 R`);
    pageObjNums.push(pageNum);
  }

  objects[pagesObjNum - 1] =
    `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} ` +
    `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> >>`;

  // Outline bookmarks (one per section, linking to the section's first page).
  const outlineItems = sections.map((section, i) => ({
    title: `${i + 1}. ${section.title}`,
    pageObj: pageObjNums[sectionStartPage[i]],
  }));
  const itemNums = outlineItems.map(() => addObject("OUTLINE_PLACEHOLDER"));
  const outlineRootNum = addObject(
    `<< /Type /Outlines /First ${itemNums[0]} 0 R /Last ${itemNums[itemNums.length - 1]} 0 R /Count ${itemNums.length} >>`,
  );
  outlineItems.forEach((item, i) => {
    const parts = [
      `<< /Title (${esc(item.title)}) /Parent ${outlineRootNum} 0 R`,
      `/Dest [${item.pageObj} 0 R /XYZ null ${PAGE_H - 24} null]`,
    ];
    if (i > 0) parts.push(`/Prev ${itemNums[i - 1]} 0 R`);
    if (i < itemNums.length - 1) parts.push(`/Next ${itemNums[i + 1]} 0 R`);
    parts.push(">>");
    objects[itemNums[i] - 1] = parts.join(" ");
  });

  objects[0] =
    `<< /Type /Catalog /Pages ${pagesObjNum} 0 R /Outlines ${outlineRootNum} 0 R /PageMode /UseOutlines >>`;

  // Write the file with a correct xref table.
  const chunks = [];
  let offset = 0;
  const offsets = [0]; // object 0 is free
  function write(str) {
    const buf = Buffer.from(str, "utf8");
    chunks.push(buf);
    offset += buf.byteLength;
  }

  write("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  objects.forEach((body, i) => {
    offsets.push(offset);
    write(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xrefPos = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  write(xref);
  write(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoObjNum} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Structured parsing of the generated PDF (shared with tests and the preview
// renderer so validation always matches the generator's op formats).
// ---------------------------------------------------------------------------

const TEXT_OP = /BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) ([\d.]+) rg (-?[\d.]+) Tc (-?[\d.-]+) (-?[\d.-]+) Td \(((?:[^()\\]|\\.)*)\) Tj ET/g;
const RECT_OP = /([\d.]+) ([\d.]+) ([\d.]+) rg ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re f/g;
const LINE_OP = /([\d.]+) ([\d.]+) ([\d.]+) RG ([\d.]+) w (-?[\d.-]+) (-?[\d.-]+) m (-?[\d.-]+) (-?[\d.-]+) l S/g;

export function parseGuidePdf(pdfLatin1) {
  const streams = [...pdfLatin1.matchAll(/stream\n([\s\S]*?)endstream/g)].map((m) => m[1]);
  const pdfPages = streams.map((stream) => {
    const runs = [];
    for (const m of stream.matchAll(TEXT_OP)) {
      runs.push({
        x: Number(m[7]),
        y: Number(m[8]),
        size: Number(m[2]),
        font: m[1],
        tc: Number(m[6]),
        fill: [Number(m[3]), Number(m[4]), Number(m[5])],
        text: unescapePdfString(m[9]),
      });
    }
    const rects = [];
    for (const m of stream.matchAll(RECT_OP)) {
      rects.push({
        x: Number(m[4]),
        y: Number(m[5]),
        w: Number(m[6]),
        h: Number(m[7]),
        fill: [Number(m[1]), Number(m[2]), Number(m[3])],
      });
    }
    const lines = [];
    for (const m of stream.matchAll(LINE_OP)) {
      lines.push({
        x1: Number(m[5]),
        y1: Number(m[6]),
        x2: Number(m[7]),
        y2: Number(m[8]),
        widthPt: Number(m[4]),
        stroke: [Number(m[1]), Number(m[2]), Number(m[3])],
      });
    }
    return { runs, rects, lines, raw: stream };
  });
  return { pages: pdfPages, streams };
}

// ---------------------------------------------------------------------------

function main() {
  layout();

  const total = pages.length;
  const finalPages = pages.map((page, index) => {
    const pageNumber = index + 1;
    if (index === 0) return coverOps(); // the cover carries no header/footer
    return page.ops + frameOps(page, pageNumber, total);
  });

  // Insert the TOC content now that section start pages are known. The frame
  // ops of the placeholder page are kept so the TOC carries the running
  // header and footer like every other content page.
  finalPages[1] = tocOps(
    sections.map((section, i) => ({
      num: i + 1,
      title: section.title,
      // Displayed page numbers count from 1 including the cover.
      page: sectionStartPage[i] + 1,
    })),
  ) + finalPages[1];

  const pdf = serialize(finalPages);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, pdf);
  console.log(`Wrote ${OUT}`);
  console.log(`Pages: ${total} (${sections.length} sections, cover + contents)`);
  console.log(`Size: ${pdf.byteLength} bytes`);
}

// Only run when invoked directly (tests import this module for its helpers).
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main();
}
