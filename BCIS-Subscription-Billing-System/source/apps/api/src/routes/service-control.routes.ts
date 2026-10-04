import type { FastifyInstance } from "fastify";
import { reconnectionStatuses, suspensionStatuses } from "@bcis/shared";
import { z } from "zod";

import { getDatabase, inTransaction } from "../db/client.js";
import { authorize, actorOf } from "../http/guards.js";
import { parseOrThrow } from "../http/validate.js";
import { withMoney, withMoneyItems } from "../http/present.js";
import {
  approveSuspension,
  assignReconnectionTechnician,
  cancelReconnection,
  cancelSuspension,
  completeReconnection,
  confirmReconnectionFee,
  createSuspensionRequest,
  executeSuspension,
  listReconnections,
  listSuspensions,
  requestReconnection
} from "../services/service-control.js";

/**
 * Service control endpoints: suspension and reconnection workflows (A3.10).
 *
 * Every mutation here requires `suspension.manage` - "who may cut off service"
 * is deliberately a different permission from "who may see that somebody owes
 * money" (`receivables.view`). Lists are readable with `service.view` so
 * technicians and office staff see the operational picture without power over
 * it. All state changes land in `service_events`, so `/service-accounts/:id/events`
 * tells the full story after the fact.
 */

const suspensionParamsSchema = z.object({
  id: z.string().uuid()
});

const createSuspensionSchema = z.object({
  serviceAccountId: z.string().uuid(),
  reason: z.string().trim().min(3, "A suspension reason is required.").max(400),
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The effective date must use YYYY-MM-DD format."),
  notes: z.string().trim().max(1000).optional().nullable().default(null)
});

const listSuspensionsSchema = z.object({
  serviceAccountId: z.string().uuid().optional(),
  status: z.enum(suspensionStatuses).optional()
});

const createReconnectionSchema = z.object({
  serviceAccountId: z.string().uuid(),
  suspensionId: z.string().uuid().optional().nullable().default(null),
  feeCentavos: z.number().int().min(0).optional().nullable(),
  technicianId: z.string().uuid().optional().nullable().default(null),
  requestDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The request date must use YYYY-MM-DD format.")
    .optional(),
  notes: z.string().trim().max(1000).optional().nullable().default(null)
});

const listReconnectionsSchema = z.object({
  serviceAccountId: z.string().uuid().optional(),
  status: z.enum(reconnectionStatuses).optional()
});

const completeSchema = z.object({
  completedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The completion date must use YYYY-MM-DD format.")
    .optional(),
  technicianId: z.string().uuid().optional()
});

const technicianSchema = z.object({
  technicianId: z.string().uuid("A technician id is required.")
});

export async function registerServiceControlRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  /** The suspension request, before anything has happened to the service. */
  app.post(
    "/service-control/suspensions",
    { preHandler: authorize("suspension.manage") },
    async (request, reply) => {
      const body = parseOrThrow(createSuspensionSchema, request.body, "The suspension is not valid.");
      const record = await inTransaction((tx) => createSuspensionRequest(tx, body, actorOf(request)));
      return reply.status(201).send({ id: record.id, status: record.status });
    }
  );

  app.post(
    "/service-control/suspensions/:id/approve",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The suspension id is not valid.");
      const record = await inTransaction((tx) => approveSuspension(tx, id, actorOf(request)));
      return { id: record.id, status: record.status, approvedBy: record.approvedByName };
    }
  );

  app.post(
    "/service-control/suspensions/:id/execute",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The suspension id is not valid.");
      const record = await inTransaction((tx) => executeSuspension(tx, id, actorOf(request)));
      return { id: record.id, status: record.status, executedAt: record.executedAt };
    }
  );

  app.post(
    "/service-control/suspensions/:id/cancel",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The suspension id is not valid.");
      const record = await inTransaction((tx) => cancelSuspension(tx, id, actorOf(request)));
      return { id: record.id, status: record.status };
    }
  );

  app.get("/service-control/suspensions", { preHandler: authorize("service.view") }, async (request, reply) => {
    const query = parseOrThrow(
      listSuspensionsSchema.extend({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(200).default(25) }),
      request.query,
      "The suspension list filter is not valid."
    );
    const page = await listSuspensions(db, query);
    const items = page.items.map((row) =>
      withMoney({
        id: row.id,
        reason: row.reason,
        effectiveDate: row.effective_date,
        arrearsAtSuspensionCentavos: row.arrears_at_suspension_centavos,
        status: row.status,
        approvedByName: row.approved_by_name ?? null,
        approvedAt: row.approved_at ?? null,
        executedAt: row.executed_at ?? null,
        cancelledAt: row.cancelled_at ?? null,
        notes: row.notes ?? null,
        createdByName: row.created_by_name ?? null,
        createdAt: row.created_at,
        serviceAccountId: row.service_account_id,
        serviceAccountNumber: row.service_account_number,
        accountStatus: row.account_status,
        subscriberId: row.subscriber_id,
        subscriberName: row.subscriber_name,
        subscriberAccountNumber: row.subscriber_account_number,
        planCode: row.plan_code,
        planName: row.plan_name
      })
    );
    return { page: page.page, pageSize: page.pageSize, total: page.total, items };
  });

  /** The reconnection workflow, including the optional fee invoice. */
  app.post(
    "/service-control/reconnections",
    { preHandler: authorize("suspension.manage") },
    async (request, reply) => {
      const body = parseOrThrow(createReconnectionSchema, request.body, "The reconnection is not valid.");
      const record = await inTransaction((tx) => requestReconnection(tx, body, actorOf(request)));
      const payload = withMoney({
        ...record,
        invoiceId: record.invoiceId ?? null,
        feeInvoiceNumber: record.feeInvoiceNumber ?? null
      });
      return reply.status(201).send(payload);
    }
  );

  app.post(
    "/service-control/reconnections/:id/confirm-fee",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The reconnection id is not valid.");
      const record = await inTransaction((tx) => confirmReconnectionFee(tx, id, actorOf(request)));
      return { id: record.id, status: record.status, requestedAt: record.requestedAt };
    }
  );

  app.post(
    "/service-control/reconnections/:id/assign-technician",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The reconnection id is not valid.");
      const body = parseOrThrow(technicianSchema, request.body, "The technician assignment is not valid.");
      const record = await inTransaction((tx) =>
        assignReconnectionTechnician(tx, id, body.technicianId, actorOf(request))
      );
      return { id: record.id, status: record.status, technicianId: record.technicianId };
    }
  );

  app.post(
    "/service-control/reconnections/:id/complete",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The reconnection id is not valid.");
      const body = parseOrThrow(completeSchema, request.body, "The completion is not valid.");
      const record = await inTransaction((tx) =>
        completeReconnection(tx, id, { completedDate: body.completedDate, technicianId: body.technicianId }, actorOf(request))
      );
      return { id: record.id, status: record.status, completedAt: record.completedAt };
    }
  );

  app.post(
    "/service-control/reconnections/:id/cancel",
    { preHandler: authorize("suspension.manage") },
    async (request) => {
      const { id } = parseOrThrow(suspensionParamsSchema, request.params, "The reconnection id is not valid.");
      const record = await inTransaction((tx) => cancelReconnection(tx, id, actorOf(request)));
      return { id: record.id, status: record.status };
    }
  );

  app.get(
    "/service-control/reconnections",
    { preHandler: authorize("service.view") },
    async (request) => {
      const query = parseOrThrow(
        listReconnectionsSchema.extend({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(200).default(25) }),
        request.query,
        "The reconnection list filter is not valid."
      );
      const page = await listReconnections(db, query);
      const items = withMoneyItems(
        {
          ...page,
          items: page.items.map((row) => ({
            id: row.id,
            feeCentavos: row.fee_centavos,
            requestDate: row.request_date,
            requestedAt: row.requested_at ?? null,
            completedAt: row.completed_at ?? null,
            cancelledAt: row.cancelled_at ?? null,
            status: row.status,
            technicianId: row.technician_id ?? null,
            notes: row.notes ?? null,
            createdByName: row.created_by_name ?? null,
            createdAt: row.created_at,
            suspensionEffectiveDate: row.suspension_effective_date ?? null,
            suspensionReason: row.suspension_reason ?? null,
            feeInvoiceNumber: row.fee_invoice_number ?? null,
            feeStatus: row.fee_status ?? null,
            feeBalanceCentavos: row.fee_balance_centavos ?? null,
            serviceAccountId: row.service_account_id,
            serviceAccountNumber: row.service_account_number,
            accountStatus: row.account_status,
            subscriberId: row.subscriber_id,
            subscriberName: row.subscriber_name,
            subscriberAccountNumber: row.subscriber_account_number,
            planCode: row.plan_code,
            planName: row.plan_name
          }))
        }
      );
      return { page: items.page, pageSize: items.pageSize, total: items.total, items: items.items };
    }
  );
}