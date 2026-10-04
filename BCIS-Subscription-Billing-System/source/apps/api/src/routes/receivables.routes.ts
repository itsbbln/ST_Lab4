import type { FastifyInstance } from "fastify";
import { paginationSchema, serviceAccountStatuses } from "@bcis/shared";
import { z } from "zod";

import { getDatabase } from "../db/client.js";
import { authorize } from "../http/guards.js";
import { withMoney, withMoneyItems } from "../http/present.js";
import { parseOrThrow } from "../http/validate.js";
import {
  agingProfile,
  listOverdueAccounts,
  listSuspensionCandidates,
  receivablesSummary
} from "../services/receivables.js";

/**
 * Receivables and overdue monitoring endpoints (§3.9).
 *
 * All four routes require only `receivables.view`. This module reports; it never
 * changes anything. Turning a receivable into a suspension happens in the
 * service-control module, behind `suspension.manage`, so "who can see that
 * somebody owes money" and "who can cut off their service" stay separate
 * permissions.
 */

const asOfQuerySchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The as-of date must be in YYYY-MM-DD format.")
    .optional()
});

const overdueQuerySchema = paginationSchema.extend({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The as-of date must be in YYYY-MM-DD format.")
    .optional(),
  collectorId: z.string().uuid().optional(),
  areaId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  serviceTypeId: z.string().uuid().optional(),
  accountStatus: z.enum(serviceAccountStatuses).optional(),
  minDaysPastDue: z.coerce.number().int().min(0).max(3650).optional(),
  maxDaysPastDue: z.coerce.number().int().min(0).max(3650).optional(),
  suspensionCandidatesOnly: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  search: z.string().trim().min(1).max(120).optional()
});

const candidateQuerySchema = z.object({
  asOf: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The as-of date must be in YYYY-MM-DD format.")
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional()
});

export async function registerReceivablesRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  /**
   * Dashboard totals. `current + overdue` is guaranteed to equal the total, and
   * the aging buckets are included in the same response so the dashboard never
   * renders a headline number next to a chart that was fetched a moment later.
   */
  app.get("/receivables/summary", { preHandler: authorize("receivables.view") }, async (request) => {
    const { asOf } = parseOrThrow(asOfQuerySchema, request.query, "The as-of filter is not valid.");
    return withMoney(await receivablesSummary(db, { asOf }));
  });

  app.get("/receivables/aging", { preHandler: authorize("receivables.view") }, async (request) => {
    const { asOf } = parseOrThrow(asOfQuerySchema, request.query, "The as-of filter is not valid.");
    return { items: await agingProfile(db, { asOf }) };
  });

  /**
   * The overdue list. Returns one row per account, already ordered by severity,
   * with the subscriber, service, area, collector, months unpaid, oldest unpaid
   * invoice, last payment and total arrears the spec asks for.
   */
  app.get("/receivables/overdue", { preHandler: authorize("receivables.view") }, async (request) => {
    const query = parseOrThrow(overdueQuerySchema, request.query, "The overdue filter is not valid.");
    const result = await listOverdueAccounts(db, query);
    return {
      ...withMoneyItems(result),
      items: result.items.map((item) =>
        withMoney({
          ...item,
          oldestUnpaidInvoice: item.oldestUnpaidInvoice
            ? withMoney(item.oldestUnpaidInvoice)
            : null
        })
      )
    };
  });

  /**
   * Accounts that meet the configured suspension rule. Restricted to ACTIVE
   * accounts, because an account that is already suspended is not a candidate
   * for suspension - it is a candidate for reconnection.
   */
  app.get(
    "/receivables/suspension-candidates",
    { preHandler: authorize("receivables.view") },
    async (request) => {
      const query = parseOrThrow(candidateQuerySchema, request.query, "The candidate filter is not valid.");
      const result = await listSuspensionCandidates(db, query);
      return withMoneyItems(result);
    }
  );
}
