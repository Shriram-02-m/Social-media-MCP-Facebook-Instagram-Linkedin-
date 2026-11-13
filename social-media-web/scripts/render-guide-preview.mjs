#!/usr/bin/env node
// Renders the generated security guide PDF to HTML canvases for visual
// inspection. Parses the actual content streams (uncompressed) and draws every
// rect, line, and text run at its true coordinates — a faithful rendering that
// reflects what a PDF viewer shows (including Arial substitution for
// Helvetica, which browsers apply).
//
// Usage: node scripts/render-guide-preview.mjs [outDir]
// Writes outDir/guide-preview.html with one canvas per page.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GEOM, parseGuidePdf } from "./generate-security-guide.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", process.argv[2] ?? ".tmp-guide-preview");

const pdfPath = path.resolve(here, "../public/Social-Console-Security-Guide.pdf");
const pdf = readFileSync(pdfPath).toString("latin1");
const { pages } = parseGuidePdf(pdf);

const SCALE = 1.25;
const canvasW = Math.round(GEOM.PAGE_W * SCALE);
const canvasH = Math.round(GEOM.PAGE_H * SCALE);

const rgb = ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

function pageScript(pageIndex) {
  const page = pages[pageIndex];
  const rects = page.rects.map((r) => ({ ...r, css: rgb(r.fill) }));
  const lines = page.lines.map((l) => ({ ...l, css: rgb(l.stroke) }));
  const runs = page.runs.map((t) => ({ ...t, css: rgb(t.fill) }));
  return `
(function () {
  const c = document.getElementById("page-${pageIndex}");
  const ctx = c.getContext("2d");
  const S = ${SCALE}, H = ${GEOM.PAGE_H};
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  for (const r of ${JSON.stringify(rects)}) {
    ctx.fillStyle = r.css;
    ctx.fillRect(r.x * S, (H - r.y - r.h) * S, r.w * S, r.h * S);
  }
  ctx.lineCap = "butt";
  for (const l of ${JSON.stringify(lines)}) {
    ctx.strokeStyle = l.css;
    ctx.lineWidth = Math.max(0.5, l.widthPt * S);
    ctx.beginPath();
    ctx.moveTo(l.x1 * S, (H - l.y1) * S);
    ctx.lineTo(l.x2 * S, (H - l.y2) * S);
    ctx.stroke();
  }
  ctx.textBaseline = "alphabetic";
  for (const t of ${JSON.stringify(runs)}) {
    ctx.fillStyle = t.css;
    const weight = t.font === "F2" ? "bold " : "";
    ctx.font = weight + (t.size * S).toFixed(2) + "px Helvetica, Arial, sans-serif";
    try { ctx.letterSpacing = (t.tc * S).toFixed(2) + "px"; } catch {}
    ctx.fillText(t.text, t.x * S, (H - t.y) * S);
    try { ctx.letterSpacing = "0px"; } catch {}
  }
})();
`;
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 16px; background: #555; font-family: sans-serif; }
  canvas { display: block; margin: 12px auto; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
  p { color: #fff; text-align: center; margin: 6px; }
</style></head><body>
${pages
    .map(
      (_p, i) =>
        `<p>Page ${i + 1} of ${pages.length}</p><canvas id="page-${i}" width="${canvasW}" height="${canvasH}"></canvas>`,
    )
    .join("\n")}
<script>
${pages.map((_, i) => pageScript(i)).join("\n")}
</script>
</body></html>`;

// Also emit each page as its own single-page HTML for close-up screenshots.
pages.forEach((_, i) => {
  const single = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 16px; background: #555; font-family: sans-serif; }
  canvas { display: block; margin: 12px auto; box-shadow: 0 2px 10px rgba(0,0,0,.5); }
  p { color: #fff; text-align: center; margin: 6px; }
</style></head><body>
<p>Page ${i + 1} of ${pages.length}</p>
<canvas id="page-${i}" width="${canvasW}" height="${canvasH}"></canvas>
<script>${pageScript(i)}</script>
</body></html>`;
  writeFileSync(path.join(outDir, `page-${i + 1}.html`), single);
});

mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, "guide-preview.html");
writeFileSync(out, html);
console.log(`Wrote ${out} (${pages.length} pages, ${canvasW}x${canvasH} each)`);
console.log(`Total height at 1x: ${pages.length * (canvasH + 30) + 40}px`);
