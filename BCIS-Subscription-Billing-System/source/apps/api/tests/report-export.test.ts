import { describe, expect, it } from "vitest";

import { renderCsv, renderPdf, renderXlsx } from "../src/services/report-export.js";

const columns = [
  { header: "period", key: "period" },
  { header: "collected", key: "collectedCentavos" }
];

const rows = [{ period: "2026-09", collectedCentavos: 123456 }];

describe("report export renderers", () => {
  it("renders CSV with a BOM and a two-decimal peso figure", () => {
    const csv = renderCsv(columns, rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain("period,collected");
    expect(csv).toContain('2026-09,"PHP 1,234.56"');
  });

  it("quotes CSV cells that contain a comma, quote or newline", () => {
    const messy = renderCsv(
      [{ header: "note", key: "note" }],
      [{ note: 'he said "hi", then\nleft' }]
    );
    expect(messy).toContain('"he said ""hi"", then\nleft"');
  });

  it("renders a real XLSX workbook", async () => {
    const buffer = await renderXlsx(columns, rows);
    expect(buffer.length).toBeGreaterThan(500);
    // An .xlsx file is a zip container and always starts with PK.
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("renders a syntactically complete PDF document", () => {
    const pdf = renderPdf({ title: "Collection report", subtitle: "from 2026-09-01 to 2026-09-30", columns, rows });
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/Type /Catalog");
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text).toContain("PHP 1,234.56");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});