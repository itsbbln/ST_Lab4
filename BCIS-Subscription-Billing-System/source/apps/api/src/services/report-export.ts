import type { FastifyReply } from "fastify";
import ExcelJS from "exceljs";

/**
 * Report export (§3.11): CSV, XLSX and PDF.
 *
 * A report is described as a list of columns (header + key) and an array of
 * objects. The same description feeds all three formats so the CSV, the
 * spreadsheet and the printed sheet cannot disagree.
 *
 * Money is stored as integer centavos everywhere; in exported files it renders
 * as a two-decimal peso figure ("PHP 1,234.56") because these files are
 * consumed by people, not by the database.
 *
 * The PDF writer below is self-contained: it uses the built-in Helvetica core
 * fonts and draws each line with simple text operators, so no font files or
 * system tools are needed to print a report.
 */

export interface ReportColumn {
  header: string;
  key: string;
}

export type ReportRow = Record<string, unknown>;

const REPORT_TYPES: Record<string, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf"
};

function formatPeso(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(Math.round(value));
  const pesos = Math.floor(abs / 100);
  const centavos = abs % 100;
  return `${sign}PHP ${pesos.toLocaleString("en-US")}.${String(centavos).padStart(2, "0")}`;
}

function cellValue(row: ReportRow, key: string): unknown {
  const value = row[key];
  if (typeof value === "number" && key.toLowerCase().endsWith("centavos")) {
    return formatPeso(value);
  }
  return value;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value);
}

/** Renders a row's columns in definition order. */
export function projectRow(columns: ReportColumn[], row: ReportRow): string[] {
  return columns.map((column) => cellText(cellValue(row, column.key)));
}

// ---- CSV ------------------------------------------------------------------

function escapeCsv(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function renderCsv(columns: ReportColumn[], rows: ReportRow[]): string {
  const lines = [columns.map((column) => escapeCsv(column.header)).join(",")];
  for (const row of rows) {
    lines.push(projectRow(columns, row).map(escapeCsv).join(","));
  }
  // A UTF-8 BOM makes Excel open the file with the right encoding.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// ---- XLSX -----------------------------------------------------------------

export async function renderXlsx(columns: ReportColumn[], rows: ReportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Report");
  sheet.columns = columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: Math.max(14, column.header.length + 4)
  }));
  for (const row of rows) {
    sheet.addRow(Object.fromEntries(columns.map((column) => [column.key, cellValue(row, column.key)])));
  }
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ---- PDF ------------------------------------------------------------------

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const PDF_MARGIN = 36;
const PDF_BODY_TOP = PAGE_HEIGHT - PDF_MARGIN;

function pdfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function pdfDraw(textLines: Array<{ text: string; x: number; y: number; font: number; size: number }>): string {
  return (
    "BT\n" +
    textLines
      .map((line) => `/${line.font} ${line.size} Tf\n${line.x.toFixed(1)} ${line.y.toFixed(1)} Td\n(${pdfEscape(line.text)}) Tj`)
      .join("\n") +
    "\nET"
  );
}

export function renderPdf(options: {
  title: string;
  subtitle?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
}): Buffer {
  const { title, subtitle, columns, rows } = options;
  const columnWidths = columns.map((column) => Math.min(140, Math.max(48, column.header.length * 5.2 + 10)));
  const rowHeight = 13;
  const headerTop = PDF_BODY_TOP - 46;

  const dataRows = rows.map((row) => projectRow(columns, row));
  const linesPerPage = Math.floor((headerTop - 30) / rowHeight);

  const pages: Array<ReturnType<typeof pdfDraw>> = [];
  let current: Array<{ text: string; x: number; y: number; font: number; size: number }> = [];
  let y = headerTop - rowHeight;
  let pageIndex = 0;

  const headerLines: Array<{ text: string; x: number; y: number; font: number; size: number }> = [];
  let x = PDF_MARGIN;

  headerLines.push({ text: title, x: PDF_MARGIN, y: PDF_BODY_TOP - 4, font: 2, size: 12 });
  if (subtitle) {
    headerLines.push({ text: subtitle, x: PDF_MARGIN + 240, y: PDF_BODY_TOP - 4, font: 1, size: 8 });
  }
  x = PDF_MARGIN;
  for (let i = 0; i < columns.length; i++) {
    headerLines.push({ text: columns[i].header, x, y: headerTop, font: 2, size: 8 });
    x += columnWidths[i];
  }
  pages.push(pdfDraw(headerLines));

  function flushPage(): void {
    pages.push(pdfDraw(current));
    current = [];
    y = headerTop - rowHeight;
    pageIndex += 1;
    const pageHeader: Array<{ text: string; x: number; y: number; font: number; size: number }> = [];
    let hx = PDF_MARGIN;
    for (let i = 0; i < columns.length; i++) {
      pageHeader.push({ text: columns[i].header, x: hx, y: headerTop, font: 2, size: 8 });
      hx += columnWidths[i];
    }
    // The continued page carries its own header so a long report stays legible.
    pages.push(pdfDraw(pageHeader));
  }

  for (const row of dataRows) {
    if (y < PDF_MARGIN + 20) {
      flushPage();
    }
    let rx = PDF_MARGIN;
    for (let i = 0; i < columns.length; i++) {
      const maxChars = Math.max(1, Math.floor(columnWidths[i] / 4.4));
      const text = row[i].length > maxChars ? `${row[i].slice(0, maxChars - 1)}\u2026` : row[i];
      current.push({ text, x: rx, y, font: 1, size: 8 });
      rx += columnWidths[i];
    }
    y -= rowHeight;
  }
  flushPage();

  // ---- Assemble the PDF objects and cross-reference table. ----------------
  const objects = new Map<number, string>();
  let nextObj = 1;

  function addObject(value: string): number {
    const num = nextObj;
    nextObj += 1;
    objects.set(num, value);
    return num;
  }

  const pageObjNums: number[] = [];
  const fontRegular = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const contentObjNums = pages.map((stream) => {
    const num = addObject(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return num;
  });
  const kids: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    const contentRef = contentObjNums[i];
    const page = addObject(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentRef} 0 R >>`
    );
    pageObjNums.push(page);
    kids.push(page);
  }
  const pagesObj = addObject(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`);
  addObject(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`);

  let output = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const [num, body] of objects) {
    offsets.set(num, output.length);
    output += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefOffset = output.length;
  output += `xref\n0 ${nextObj}\n`;
  output += "0000000000 65535 f \n";
  for (let num = 1; num < nextObj; num++) {
    output += `${String(offsets.get(num) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${nextObj} /Root ${nextObj - 1} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

// ---- Route helper ---------------------------------------------------------

export async function sendReportExport(
  reply: FastifyReply,
  options: { format: "csv" | "xlsx" | "pdf"; filename: string; title?: string; subtitle?: string; columns: ReportColumn[]; rows: ReportRow[] }
): Promise<FastifyReply> {
  const { format, filename, columns, rows } = options;
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  reply.header("Content-Disposition", `attachment; filename="${safeName}"`);

  if (format === "csv") {
    reply.type(REPORT_TYPES.csv);
    return reply.send(renderCsv(columns, rows));
  }
  if (format === "xlsx") {
    reply.type(REPORT_TYPES.xlsx);
    return reply.send(await renderXlsx(columns, rows));
  }
  reply.type(REPORT_TYPES.pdf);
  return reply.send(renderPdf({ title: options.title ?? filename, subtitle: options.subtitle, columns, rows }));
}

/** True when the caller asked for a file export rather than JSON. */
export function isExportFormat(value: unknown): value is "csv" | "xlsx" | "pdf" {
  return value === "csv" || value === "xlsx" || value === "pdf";
}