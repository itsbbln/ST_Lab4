import { relations } from "drizzle-orm";
import { bigint, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { serviceAccounts } from "./services.js";
import { reconnectionStatusEnum, suspensionStatusEnum } from "./enums.js";

/**
 * Service control. Suspension and reconnection are append-only operational
 * records: every state change on a service account also lands in
 * `service_events`, so the full history is preserved.
 */
export const suspensionRecords = pgTable(
  "suspension_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    effectiveDate: date("effective_date").notNull(),
    arrearsAtSuspensionCentavos: bigint("arrears_at_suspension_centavos", { mode: "number" }).notNull().default(0),
    status: suspensionStatusEnum("status").notNull().default("PENDING"),
    approvedBy: uuid("approved_by"),
    approvedByName: text("approved_by_name"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("suspension_records_account_idx").on(table.serviceAccountId, table.effectiveDate),
    index("suspension_records_status_idx").on(table.status)
  ]
);

export const reconnectionRecords = pgTable(
  "reconnection_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    suspensionId: uuid("suspension_id").references(() => suspensionRecords.id, { onDelete: "set null" }),
    feeCentavos: bigint("fee_centavos", { mode: "number" }).notNull().default(0),
    invoiceId: uuid("invoice_id"),
    technicianId: uuid("technician_id"),
    requestDate: date("request_date").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    status: reconnectionStatusEnum("status").notNull().default("PENDING_PAYMENT"),
    approvedBy: uuid("approved_by"),
    approvedByName: text("approved_by_name"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: uuid("created_by"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("reconnection_records_account_idx").on(table.serviceAccountId, table.requestDate),
    index("reconnection_records_status_idx").on(table.status),
    index("reconnection_records_technician_idx").on(table.technicianId)
  ]
);

export const suspensionRecordsRelations = relations(suspensionRecords, ({ one, many }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [suspensionRecords.serviceAccountId],
    references: [serviceAccounts.id]
  }),
  reconnections: many(reconnectionRecords)
}));

export const reconnectionRecordsRelations = relations(reconnectionRecords, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [reconnectionRecords.serviceAccountId],
    references: [serviceAccounts.id]
  }),
  suspension: one(suspensionRecords, {
    fields: [reconnectionRecords.suspensionId],
    references: [suspensionRecords.id]
  })
}));