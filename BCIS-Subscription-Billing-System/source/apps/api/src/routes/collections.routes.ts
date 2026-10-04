import type { FastifyInstance } from "fastify";
import {
  addBatchAccountsSchema,
  batchStatuses,
  confirmRemittanceSchema,
  createBatchSchema,
  createRemittanceSchema,
  paginationSchema,
  recordCollectionSchema,
  remittanceStatuses,
  transitionBatchSchema
} from "@bcis/shared";
import { z } from "zod";

import { getDatabase, inTransaction } from "../db/client.js";
import { actorOf, authorize } from "../http/guards.js";
import { withMoney, withMoneyItems } from "../http/present.js";
import { parseOrThrow as parseRequest } from "../http/validate.js";
import { validationFailed } from "../services/errors.js";
import {
  addBatchAccounts,
  closeBatch,
  collectorPerformance,
  confirmRemittance,
  getBatch,
  getRouteSheet,
  listBatches,
  listRemittances,
  openBatch,
  recordCollection,
  submitRemittance,
  transitionBatch
} from "../services/collections.js";

/**
 * House-to-house collection endpoints (§3.8).
 *
 * Reading a batch or a route sheet needs only `collection.view`. Recording what a
 * collector collected needs `collection.record`, and remitting, confirming and
 * closing need `collection.reconcile` - the same split the role table gives
 * COLLECTION_SUPERVISOR and ACCOUNTANT_AUDITOR. A supervisor who records a
 * collection is deliberately not the person who signs off the remittance.
 */

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, message: string): z.infer<S> {
  return parseRequest(schema, value, message);
}

/**
 * Closing is not a plain status change: when the confirmed remittance is short or
 * over, the caller has to acknowledge the figure in the same request. That is the
 * control AT-08 looks for, so it is a required field rather than a UI prompt.
 */
const closeBatchSchema = z.object({
  notes: z.string().trim().max(500).optional(),
  acknowledgeDiscrepancy: z.boolean().default(false)
});

const batchListQuerySchema = paginationSchema.extend({
  status: z.enum(batchStatuses).optional(),
  collectorId: z.string().min(1).optional(),
  areaId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional()
});

const performanceQuerySchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  collectorId: z.string().min(1).optional()
});

/** Adds peso-formatted totals so the renderer never re-implements the maths. */

export async function registerCollectionRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  // ---- Batches -------------------------------------------------------------

  app.get("/collection/batches", { preHandler: authorize("collection.view") }, async (request) => {
    const query = parseOrThrow(batchListQuerySchema, request.query, "The batch filter is not valid.");
    const result = await listBatches(db, query);
    return withMoneyItems(result);
  });

  app.get("/collection/batches/:id", { preHandler: authorize("collection.view") }, async (request) => {
    const { id } = request.params as { id: string };
    return withMoney(await getBatch(db, id));
  });

  /**
   * The printable route sheet. The same data feeds the screen and the printer, so
   * the paper a collector carries and the totals the office reconciles against
   * cannot drift apart.
   */
  app.get("/collection/batches/:id/route-sheet", { preHandler: authorize("collection.view") }, async (request) => {
    const { id } = request.params as { id: string };
    const sheet = await getRouteSheet(db, id);
    return withMoney({ ...sheet, rows: sheet.rows.map((row) => withMoney(row)) });
  });

  app.post("/collection/batches", { preHandler: authorize("collection.record") }, async (request, reply) => {
    const body = parseOrThrow(createBatchSchema, request.body, "The batch could not be opened.");
    const batch = await inTransaction((tx) =>
      openBatch(
        tx,
        {
          areaId: body.areaId,
          routeId: body.routeId ?? null,
          collectorId: body.collectorId,
          batchDate: body.batchDate,
          dueDayCutoff: body.dueDayCutoff,
          notes: body.notes ?? null
        },
        actorOf(request)
      )
    );
    return reply.status(201).send(withMoney(batch));
  });

  app.post("/collection/batches/:id/accounts", { preHandler: authorize("collection.record") }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      addBatchAccountsSchema,
      request.body,
      "Select at least one service account."
    );
    const result = await inTransaction((tx) => addBatchAccounts(tx, id, body.serviceAccountIds, actorOf(request)));
    return reply.status(201).send(withMoney(result));
  });

  /**
   * One doorstep collection. This is the only path that records money against a
   * batch, and it posts a real payment - so the receipt, the oldest-first
   * allocation, any advance and the ledger credit all behave exactly as they do
   * at the counter.
   */
  app.post(
    "/collection/batches/accounts/:batchAccountId/collect",
    { preHandler: authorize("collection.record") },
    async (request) => {
      const { batchAccountId } = request.params as { batchAccountId: string };
      const body = parseOrThrow(recordCollectionSchema, request.body, "The collection could not be recorded.");
      const result = await inTransaction((tx) =>
        recordCollection(
          tx,
          {
            batchAccountId,
            amountCentavos: body.amount,
            status: body.status,
            method: body.method,
            notes: body.notes ?? null
          },
          actorOf(request)
        )
      );
      return withMoney(result);
    }
  );

  app.post(
    "/collection/batches/:id/transition",
    { preHandler: authorize("collection.record") },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(transitionBatchSchema, request.body, "That batch transition is not valid.");
      return inTransaction((tx) =>
        transitionBatch(tx, id, body.toStatus, body.notes ?? null, actorOf(request))
      );
    }
  );

  // ---- Remittance ----------------------------------------------------------

  /**
   * What the collector physically handed over. Shortage and overage are derived
   * here from the cash the batch actually recorded, so they cannot be entered to
   * a convenient zero.
   */
  app.post(
    "/collection/remittances",
    { preHandler: authorize("collection.reconcile") },
    async (request, reply) => {
      const body = parseOrThrow(createRemittanceSchema, request.body, "The remittance could not be recorded.");
      const result = await inTransaction((tx) =>
        submitRemittance(
          tx,
          {
            batchId: body.batchId,
            cashRemittedCentavos: body.cashRemitted,
            nonCashCollectedCentavos: body.nonCashCollected,
            remarks: body.remarks ?? null
          },
          actorOf(request)
        )
      );
      return reply.status(201).send(withMoney(result));
    }
  );

  app.get("/collection/remittances", { preHandler: authorize("collection.view") }, async (request) => {
    const page = parseOrThrow(paginationSchema, request.query, "The page request is not valid.");
    const filter = parseOrThrow(
      z.object({ status: z.enum(remittanceStatuses).optional() }),
      request.query,
      "The remittance filter is not valid."
    );
    const result = await listRemittances(db, { ...page, status: filter.status });
    return withMoneyItems(result);
  });

  /**
   * Confirm or reject. Approval is the authorized act that reconciles a batch;
   * a rejection sends it back for correction with the reason recorded.
   */
  app.post(
    "/collection/remittances/:id/review",
    { preHandler: authorize("collection.reconcile") },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = parseOrThrow(
        confirmRemittanceSchema,
        request.body,
        "A review reason of at least 5 characters is required."
      );
      return inTransaction((tx) => confirmRemittance(tx, id, body.approved, body.reason, actorOf(request)));
    }
  );

  app.post("/collection/batches/:id/close", { preHandler: authorize("collection.reconcile") }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(closeBatchSchema, request.body ?? {}, "The batch could not be closed.");
    return inTransaction((tx) =>
      closeBatch(
        tx,
        id,
        { notes: body.notes ?? null, acknowledgeDiscrepancy: body.acknowledgeDiscrepancy },
        actorOf(request)
      )
    );
  });

  // ---- Reporting -----------------------------------------------------------

  app.get("/collection/performance", { preHandler: authorize("collection.view") }, async (request) => {
    const query = parseOrThrow(performanceQuerySchema, request.query, "The report filter is not valid.");
    const rows = await collectorPerformance(db, query);
    return withMoneyItems({ items: rows });
  });
}
