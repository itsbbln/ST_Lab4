import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderPdf, type ReportColumn, type ReportRow } from "../apps/api/src/services/report-export.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");
const markdownPath = path.join(projectRoot, "tests", "acceptance-test-report.md");
const pdfPath = path.join(projectRoot, "tests", "acceptance-test-report.pdf");

const columns: ReportColumn[] = [
  { header: "Section", key: "section" },
  { header: "Evidence", key: "detail" }
];

/**
 * Converts the human-edited Markdown report into a simple PDF table so the
 * submission folder contains the exact `tests/acceptance-test-report.pdf`
 * deliverable required by the laboratory guide.
 */
async function main(): Promise<void> {
  const markdown = await fs.readFile(markdownPath, "utf8");
  const rows = markdownToRows(markdown);
  const pdf = renderPdf({
    title: "BCIS Acceptance Test Report",
    subtitle: "Generated from tests/acceptance-test-report.md",
    columns,
    rows
  });
  await fs.writeFile(pdfPath, pdf);
  console.log(`Wrote ${path.relative(projectRoot, pdfPath)} (${pdf.length} bytes)`);
}

function markdownToRows(markdown: string): ReportRow[] {
  const rows: ReportRow[] = [];
  let section = "Overview";

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("# ")) {
      continue;
    }
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (
        cells.length === 0 ||
        cells.every((cell) => /^:?-{3,}:?$/.test(cell))
      ) {
        continue;
      }
      rows.push({
        section,
        detail: cells.join(" | ")
      });
      continue;
    }
    const bullet = line.match(/^(-|\d+\.)\s+(.*)$/);
    rows.push({
      section,
      detail: bullet ? bullet[2].trim() : line
    });
  }

  return rows;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
