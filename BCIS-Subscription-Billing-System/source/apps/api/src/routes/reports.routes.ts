import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { getDatabase } from "../db/client.js";
import { actorOf, authorize } from "../http/guards.js";
import { DomainError, validationFailed } from "../services/errors.js";
import { auditQuerySchema, listAuditLogs } from "../services/audit.js";
import { collectorPerformance } from "../services/collections.js";
import { listServiceAccounts } from "../services/directory.js";
import { sendReportExport, isExportFormat, type ReportColumn, type ReportRow } from "../services/report-export.js";
import {
  adjustmentRegister,
  billingVsCollectionReport,
  collectionReport,
  paymentRegister,
  reportGranularities,
  revenueReport
} from "../services/reports.js";

/**
 * Management reports (§3.11).
 *
 * The reports route is read-only: it only aggregates what the operational
 * modules have already committed, so a report can never change a book. Exporting
 * a report is one extra permission on top of viewing it (`report.export`), which
 * is why the format check happens in the handler - the guard that runs first
 * only proves the caller may look at the numbers.
 */

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50)
});

const exportFormatSchema = z.enum(["csv", "xlsx", "pdf"]).optional();

const collectionsQuerySchema = paginationSchema
  .omit({ page: true, pageSize: true })
  .extend({
    granularity: z.enum(reportGranularities).default("monthly"),
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    exportFormat: exportFormatSchema
  });

const rangeQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  exportFormat: exportFormatSchema
});

const revenueQuerySchema = rangeQuerySchema.extend({
  by: z.enum(["plan", "service-type", "area"])
});

const subscriberReportQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
  status: z.string().trim().max(40).optional(),
  planId: z.string().trim().max(80).optional(),
  areaId: z.string().trim().max(80).optional(),
  collectorId: z.string().trim().max(80).optional(),
  serviceType: z.string().trim().max(40).optional(),
  exportFormat: exportFormatSchema
});

const performanceQuerySchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  collectorId: z.string().trim().max(80).optional(),
  exportFormat: exportFormatSchema
});

const paymentRegisterQuerySchema = paginationSchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  method: z.string().trim().max(40).optional(),
  q: z.string().trim().max(120).optional(),
  exportFormat: exportFormatSchema
});

const adjustmentQuerySchema = paginationSchema.extend({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  exportFormat: exportFormatSchema
});

const auditReportQuerySchema = auditQuerySchema.extend({
  exportFormat: exportFormatSchema
});

function columnsFromHeaders(headers: string[]): ReportColumn[] {
  return headers.map((header) => ({ header, key: header }));
}

/** Parses the `exportFormat` query value and rejects anything else. */
function parseExportFormat(value: unknown): { format: "csv" | "xlsx" | "pdf" } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (isExportFormat(value)) {
    return { format: value };
  }
  throw validationFailed("The export format must be one of csv, xlsx or pdf.");
}

/** A report file needs the `report.export` permission even when the data is visible. */
function assertCanExport(request: FastifyRequest): void {
  const actor = actorOf(request);
  if (!actor.permissions.includes("report.export")) {
    throw new DomainError("FORBIDDEN", "Exporting a report requires the report.export permission.", 403);
  }
}

function rowProjects(items: unknown[], headers: string[]): ReportRow[] {
  const keys = headers;
  return items.map((item) => {
    const row: ReportRow = {};
    for (const key of keys) {
      row[key] = (item as Record<string, unknown>)[key];
    }
    return row;
  });
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  app.get("/reports/collections", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = collectionsQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The collections report query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await collectionReport(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      const headers = ["period", "postedCount", "collectedCentavos", "CASH", "GCASH", "BANK_TRANSFER", "CHEQUE", "OTHER"];
      const rows = result.buckets.map((bucket) => ({ ...bucket, ...bucket.methods }));
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: `collections-${parsed.data.granularity}`,
        title: `Collection report (${parsed.data.granularity})`,
        subtitle: `${result.from} to ${result.to}`,
        columns: columnsFromHeaders(headers),
        rows
      });
    }
    return result;
  });

  app.get("/reports/billing-vs-collection", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = rangeQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The billing vs collection query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await billingVsCollectionReport(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: "billing-vs-collection",
        title: "Billing vs collection",
        columns: columnsFromHeaders([
          "period",
          "billedCount",
          "billedCentavos",
          "collectedCount",
          "collectedCentavos",
          "outstandingCentavos",
          "collectionRate"
        ]),
        rows: rowProjects(result.rows, [
          "period",
          "billedCount",
          "billedCentavos",
          "collectedCount",
          "collectedCentavos",
          "outstandingCentavos",
          "collectionRate"
        ])
      });
    }
    return result;
  });

  app.get("/reports/revenue", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = revenueQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The revenue report query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await revenueReport(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: `revenue-by-${parsed.data.by}`,
        title: `Revenue by ${parsed.data.by}`,
        columns: columnsFromHeaders([
          "dimension",
          "billedCount",
          "billedCentavos",
          "collectedCentavos",
          "outstandingCentavos",
          "collectionRate"
        ]),
        rows: rowProjects(result.rows, [
          "dimension",
          "billedCount",
          "billedCentavos",
          "collectedCentavos",
          "outstandingCentavos",
          "collectionRate"
        ])
      });
    }
    return result;
  });

  app.get("/reports/subscribers", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = subscriberReportQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The subscriber master report query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await listServiceAccounts(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      const headers = [
        "subscriberName",
        "accountNumber",
        "serviceAccountNumber",
        "planName",
        "serviceType",
        "areaName",
        "collectorName",
        "installationAddress",
        "activationDate",
        "status",
        "currentRateCentavos",
        "outstandingCentavos"
      ];
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: "subscriber-master-list",
        title: "Subscriber master list",
        columns: columnsFromHeaders(headers),
        rows: rowProjects(result.items, headers)
      });
    }
    return result;
  });

  app.get("/reports/collector-performance", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = performanceQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The collector performance query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await collectorPerformance(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      const headers = [
        "collectorName",
        "batchCount",
        "expectedReceivableCentavos",
        "totalCollectedCentavos",
        "uncollectedCentavos",
        "collectionRate",
        "shortageCentavos",
        "overageCentavos"
      ];
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: "collector-performance",
        title: "Collector performance",
        columns: columnsFromHeaders(headers),
        rows: rowProjects(result, headers)
      });
    }
    return { items: result };
  });

  app.get("/reports/payments", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = paymentRegisterQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The payments register query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await paymentRegister(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      const headers = [
        "receiptNumber",
        "paymentDate",
        "serviceAccountNumber",
        "accountNumber",
        "subscriberName",
        "method",
        "amountCentavos",
        "status",
        "postedByName",
        "reversalReason",
        "voidReason"
      ];
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: "payments-register",
        title: "Payments register",
        columns: columnsFromHeaders(headers),
        rows: rowProjects(result.items, headers)
      });
    }
    return result;
  });

  app.get("/reports/adjustments", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = adjustmentQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The adjustments report query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await adjustmentRegister(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      const headers = [
        "createdAt",
        "invoiceNumber",
        "serviceAccountNumber",
        "subscriberName",
        "period",
        "adjustmentType",
        "reason",
        "amountCentavos",
        "previousTotalCentavos",
        "newTotalCentavos",
        "requestedByName",
        "approvedByName"
      ];
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: "adjustments",
        title: "Payment adjustments",
        columns: columnsFromHeaders(headers),
        rows: rowProjects(result.items, headers)
      });
    }
    return result;
  });

  app.get("/reports/audit", { preHandler: authorize("report.view") }, async (request, reply) => {
    const parsed = auditReportQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The audit report query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await listAuditLogs(db, parsed.data);
    const exportFormat = parseExportFormat(parsed.data.exportFormat);
    if (exportFormat) {
      assertCanExport(request);
      const headers = [
        "createdAt",
        "action",
        "actorName",
        "entityType",
        "entityId",
        "ipAddress",
        "details"
      ];
      return sendReportExport(reply, {
        format: exportFormat.format,
        filename: "audit-trail",
        title: "User activity and audit report",
        columns: columnsFromHeaders(headers),
        rows: rowProjects(result.items, headers)
      });
    }
    return { items: result.items, page: result.page, pageSize: result.pageSize, total: result.total };
  });
}