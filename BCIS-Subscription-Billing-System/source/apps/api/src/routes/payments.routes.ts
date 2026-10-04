import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  allocationPreviewSchema,
  createPaymentSchema,
  formatCentavos,
  paginationSchema,
  proofStatusFilterSchema,
  reversePaymentSchema,
  submitGcashProofSchema,
  verifyGcashProofSchema
} from "@bcis/shared";
import { z } from "zod";

import { getDatabase, inTransaction } from "../db/client.js";
import { actorOf, authorize } from "../http/guards.js";
import { validationFailed } from "../services/errors.js";
import {
  getPayment,
  listPaymentProofs,
  listPayments,
  postPayment,
  previewAllocation,
  reversePayment,
  submitGcashProof,
  verifyGcashProof
} from "../services/payments.js";

/**
 * Cashier, reversal and GCash endpoints (§3.4–§3.7).
 *
 * Reading the payment register needs `payments.post` because the register is a
 * collections tool, not a general directory. Each route that *moves* money names
 * its own permission, so a collector who can post a receipt still cannot reverse
 * one — the segregation of duties the lab's audit test looks for.
 *
 * Every money-moving route opens the transaction and hands it to the service.
 * The services deliberately do not start their own, because `inTransaction`
 * always takes a fresh pooled connection: a service opening its own would commit
 * independently of the work around it.
 */

/**
 * The shared `reversePaymentSchema` carries `paymentId` in the body, but the
 * route already has it in the path. Reusing the shared `reason` field keeps one
 * source of truth for the "at least 5 characters" rule.
 */
const reversalBodySchema = reversePaymentSchema.pick({ reason: true });

function badRequest(message: string, issues: Array<{ path: string; message: string }>) {
  return validationFailed(message, { issues });
}

/** Runs a Zod parse, or throws the app's own 400 envelope instead of a raw Zod error. */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, message: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(
      message,
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    );
  }
  return parsed.data;
}

/** Query strings arrive as strings; the service wants the parsed numbers. */
function listFilters(request: FastifyRequest): Record<string, string> {
  const { page: _page, pageSize: _pageSize, ...rest } = (request.query ?? {}) as Record<string, string>;
  return rest;
}

export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  // ---- Register -----------------------------------------------------------

  app.get("/payments", { preHandler: authorize("payment.view") }, async (request) => {
    const page = parseOrThrow(paginationSchema, request.query, "The page request is not valid.");
    return listPayments(db, { ...listFilters(request), ...page });
  });

  app.get("/payments/:id", { preHandler: authorize("payment.view") }, async (request) => {
    const { id } = request.params as { id: string };
    return getPayment(db, id);
  });

  /**
   * Dry run for the cashier screen. It only reports how a payment *would* be
   * applied, so nothing is written and the operator is entitled to the answer
   * before they type the money in.
   */
  app.get("/payments/allocation-preview", { preHandler: authorize("payment.view") }, async (request) => {
    const query = parseOrThrow(
      allocationPreviewSchema,
      request.query,
      "A service account and an amount are required to preview an allocation."
    );
    return previewAllocation(db, query.serviceAccountId, query.amount);
  });

  app.post("/payments", { preHandler: authorize("payment.create") }, async (request, reply) => {
    const body = parseOrThrow(createPaymentSchema, request.body, "The payment could not be recorded.");

    // A payment tagged to a collection batch has to move the batch with it:
    // the batch account's collected total and the batch's cash total both come
    // from this row. Doing that here would need the collection permission, and
    // would let a cashier's receipt and a collector's batch disagree. Batch
    // money therefore has exactly one door, /collection/batches/:id/collect.
    if (body.batchAccountId) {
      throw validationFailed(
        "A payment cannot be posted against a collection batch from this screen. " +
          "Record it with the batch collection endpoint so the collector's totals stay correct."
      );
    }

    const result = await inTransaction((tx) =>
      postPayment(
        tx,
        {
          serviceAccountId: body.serviceAccountId,
          amountCentavos: body.amount,
          method: body.method,
          referenceNumber: body.referenceNumber ?? null,
          notes: body.notes ?? null,
          collectorId: body.collectorId ?? null,
          allocations: body.manualAllocations?.map((line) => ({
            invoiceId: line.invoiceId,
            amountCentavos: line.amount
          }))
        },
        actorOf(request)
      )
    );
    return reply.status(201).send(result);
  });

  app.post("/payments/:id/reverse", { preHandler: authorize("payment.reverse") }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      reversalBodySchema,
      request.body,
      "A reversal reason of at least 5 characters is required."
    );
    return inTransaction((tx) => reversePayment(tx, id, body.reason, actorOf(request)));
  });

  // ---- GCash ---------------------------------------------------------------

  app.get("/gcash/proofs", { preHandler: authorize("payment.view") }, async (request) => {
    const page = parseOrThrow(paginationSchema, request.query, "The page request is not valid.");
    const filter = parseOrThrow(proofStatusFilterSchema, request.query, "The proof filter is not valid.");
    return listPaymentProofs(db, { ...listFilters(request), ...page, status: filter.status });
  });

  /**
   * Proof submission. Any signed-in user may submit a screenshot: the person
   * holding the phone at the door may genuinely be the one uploading it. Nothing
   * is posted and nothing enters the ledger here — only a claim is recorded.
   */
  app.post("/gcash/proofs", { preHandler: authorize("gcash.submit") }, async (request, reply) => {
    const body = parseOrThrow(submitGcashProofSchema, request.body, "The GCash proof could not be submitted.");
    const proof = await inTransaction((tx) =>
      submitGcashProof(
        tx,
        {
          serviceAccountId: body.serviceAccountId,
          referenceNumber: body.referenceNumber,
          senderName: body.senderName,
          amountCentavos: body.amount,
          proofNote: body.proofNote ?? null,
          attachmentId: body.attachmentId ?? null
        },
        actorOf(request)
      )
    );
    return reply.status(201).send({
      ...proof,
      total: { amount: formatCentavos(proof.amountCentavos) }
    });
  });

  /**
   * Approve or reject. Approval is the only path by which a screenshot becomes
   * cash, and it commits the proof status and the payment together, so a
   * duplicate reference cannot leave a proof marked verified with no payment.
   */
  app.post("/gcash/proofs/:id/review", { preHandler: authorize("gcash.verify") }, async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(verifyGcashProofSchema, request.body, "The review decision is not valid.");
    return inTransaction((tx) =>
      verifyGcashProof(
        tx,
        id,
        { approved: body.approved, rejectionReason: body.reason ?? null, note: body.reason ?? null },
        actorOf(request)
      )
    );
  });
}
