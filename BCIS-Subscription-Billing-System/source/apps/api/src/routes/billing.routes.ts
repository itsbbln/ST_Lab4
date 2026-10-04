import type { FastifyInstance } from "fastify";
import {
  generateBillingSchema,
  isoDateSchema,
  paginationSchema,
  periodSchema,
  voidInvoiceSchema
} from "@bcis/shared";
import { z } from "zod";

import { getDatabase, inTransaction } from "../db/client.js";
import { validationFailed } from "../services/errors.js";
import {
  adjustInvoice,
  generateMonthlyBilling,
  getBillingCycleSummary,
  getInvoice,
  invoiceExistsForPeriod,
  listBillingCycles,
  listInvoices,
  refreshOverdueStatuses,
  voidInvoice
} from "../services/billing.js";
import { actorOf, authorize } from "../http/guards.js";

/**
 * Billing endpoints (§3.4, §3.5).
 *
 * `POST /billing/generate` is the only route that creates financial records, and
 * it is deliberately idempotent per period: running it twice for the same month
 * reports the first run's invoice numbers and creates nothing new, which is what
 * AT-11 checks. A dedicated `force` flag is deliberately *not* offered — if a
 * month needs rebuilding, the invoices are voided one by one through
 * `POST /invoices/:id/void`, which leaves an audit trail.
 */

const adjustInvoiceSchema = z.object({
  adjustmentType: z.enum(["ADJUSTMENT_DEBIT", "ADJUSTMENT_CREDIT", "DISCOUNT", "PENALTY"]),
  reason: z.string().trim().min(3, "A reason is required for every adjustment.").max(500),
  amount: z.union([z.string(), z.number()]).transform((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error("The adjustment amount must be greater than zero.");
    }
    // Amounts arrive from the form as pesos; the service works in centavos.
    return Math.round(parsed * 100);
  })
});

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  app.get("/billing/cycles", { preHandler: authorize("billing.view") }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 24);
    return { items: await listBillingCycles(db, Number.isFinite(limit) ? limit : 24) };
  });

  app.get("/billing/cycles/:period/summary", { preHandler: authorize("billing.view") }, async (request) => {
    const { period } = request.params as { period: string };
    if (!periodSchema.safeParse(period).success) {
      throw validationFailed("The billing period must use the YYYY-MM format.");
    }
    return { period, rows: await getBillingCycleSummary(db, period) };
  });

  // The financial run. Wrapped in its own transaction by the service, so a
  // failure on the last account leaves no partial cycle behind.
  app.post("/billing/generate", { preHandler: authorize("billing.generate") }, async (request, reply) => {
    const parsed = generateBillingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("The billing period could not be generated.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await generateMonthlyBilling(parsed.data, actorOf(request));
    return reply.status(result.created > 0 ? 201 : 200).send(result);
  });

  // Recomputes OVERDUE from the due dates. The status is derived rather than
  // dependent on a nightly job, so this only exists so an operator can refresh
  // the stored values after a bulk edit.
  app.post("/billing/refresh-overdue", { preHandler: authorize("billing.generate") }, async () => ({
    updated: await refreshOverdueStatuses(db)
  }));

  // ---- Invoices ------------------------------------------------------------

  app.get("/invoices", { preHandler: authorize("billing.view") }, async (request) => {
    const base = paginationSchema.safeParse(request.query ?? {});
    if (!base.success) {
      throw validationFailed("The page request is not valid.");
    }
    return listInvoices(db, { ...(request.query as Record<string, string>), ...base.data });
  });

  app.get("/invoices/:id", { preHandler: authorize("billing.view") }, async (request) => {
    const { id } = request.params as { id: string };
    return getInvoice(db, id);
  });

  // Prevents the UI from offering a period that is already fully billed, so the
  // user gets an explanation before pressing Generate.
  app.get("/invoices/check-period", { preHandler: authorize("billing.view") }, async (request) => {
    const { serviceAccountId, period } = request.query as { serviceAccountId?: string; period?: string };
    if (!serviceAccountId || !periodSchema.safeParse(period).success) {
      throw validationFailed("A service account and a YYYY-MM period are required.");
    }
    return { serviceAccountId, period, exists: await invoiceExistsForPeriod(db, serviceAccountId, period!) };
  });

  app.post("/invoices/:id/void", { preHandler: authorize("billing.generate") }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = voidInvoiceSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("A reason is required to void an invoice.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const result = await inTransaction((tx) => voidInvoice(tx, id, parsed.data.reason, actorOf(request)));
    return result;
  });

  app.post("/invoices/:id/adjust", { preHandler: authorize("billing.generate") }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = adjustInvoiceSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("The adjustment could not be applied.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const { adjustmentType, reason, amount } = parsed.data;
    return inTransaction((tx) =>
      adjustInvoice(tx, id, { adjustmentType, reason, amountCentavos: amount }, actorOf(request))
    );
  });

  // Used by the receivables screen to show an "as of today" stamp that matches
  // the rows above it.
  app.get("/invoices/as-of/:date", { preHandler: authorize("billing.view") }, async (request) => {
    const { date } = request.params as { date: string };
    if (!isoDateSchema.safeParse(date).success) {
      throw validationFailed("The date must use the YYYY-MM-DD format.");
    }
    return { asOf: date, overdueUpdated: await refreshOverdueStatuses(db, new Date(`${date}T00:00:00Z`)) };
  });
}
