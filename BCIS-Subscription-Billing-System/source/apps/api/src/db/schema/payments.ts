import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { collectors, subscribers } from "./directory.js";
import { serviceAccounts } from "./services.js";
import { collectionBatches } from "./collections.js";
import { invoices } from "./billing.js";
import {
  allocationTypeEnum,
  paymentMethodEnum,
  paymentStatusEnum,
  proofStatusEnum
} from "./enums.js";

/**
 * A posted payment is never edited or deleted. Corrections create a row in
 * `payment_reversals` and flip `payments.status` to REVERSED, so the original
 * record and its ledger effect stay visible forever.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptNumber: text("receipt_number").notNull(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "restrict" }),
    paymentDate: timestamp("payment_date", { withTimezone: true }).notNull().defaultNow(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    method: paymentMethodEnum("method").notNull(),
    referenceNumber: text("reference_number"),
    notes: text("notes"),
    status: paymentStatusEnum("status").notNull().default("POSTED"),
    allocatedCentavos: bigint("allocated_centavos", { mode: "number" }).notNull().default(0),
    advanceCentavos: bigint("advance_centavos", { mode: "number" }).notNull().default(0),
    creditAppliedCentavos: bigint("credit_applied_centavos", { mode: "number" }).notNull().default(0),
    postedBy: uuid("posted_by"),
    postedByName: text("posted_by_name"),
    collectorId: uuid("collector_id").references(() => collectors.id, { onDelete: "set null" }),
    batchId: uuid("batch_id").references(() => collectionBatches.id, { onDelete: "set null" }),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by"),
    reversalReason: text("reversal_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("payments_receipt_number_unique").on(sql`upper(${table.receiptNumber})`),
    index("payments_account_date_idx").on(table.serviceAccountId, table.paymentDate),
    index("payments_date_idx").on(table.paymentDate),
    index("payments_method_date_idx").on(table.method, table.paymentDate),
    index("payments_status_idx").on(table.status),
    // GCash reference uniqueness is enforced for posted GCash payments, which
    // is what makes AT-05 (duplicate GCash reference) a database-level fact.
    uniqueIndex("payments_gcash_reference_unique")
      .on(sql`upper(${table.referenceNumber})`)
      .where(sql`${table.method} = 'GCASH' AND ${table.status} = 'POSTED' AND ${table.referenceNumber} IS NOT NULL`),
    index("payments_collector_idx").on(table.collectorId),
    index("payments_batch_idx").on(table.batchId)
  ]
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    allocationType: allocationTypeEnum("allocation_type").notNull().default("AUTO"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("payment_allocations_payment_invoice_unique").on(table.paymentId, table.invoiceId),
    index("payment_allocations_invoice_idx").on(table.invoiceId),
    index("payment_allocations_payment_idx").on(table.paymentId)
  ]
);

export const paymentReversals = pgTable(
  "payment_reversals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reversalNumber: text("reversal_number").notNull(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    unallocatedCentavos: bigint("unallocated_centavos", { mode: "number" }).notNull(),
    creditRestoredCentavos: bigint("credit_restored_centavos", { mode: "number" }).notNull(),
    reversedBy: uuid("reversed_by"),
    reversedByName: text("reversed_by_name"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("payment_reversals_number_unique").on(sql`upper(${table.reversalNumber})`),
    index("payment_reversals_payment_idx").on(table.paymentId)
  ]
);

/**
 * GCash proof of payment.
 *
 * A screenshot is evidence to review, never automatic proof of payment: rows
 * start as PENDING and only a verified proof creates a `payments` row.
 */
export const paymentProofs = pgTable(
  "payment_proofs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    referenceNumber: text("reference_number").notNull(),
    senderName: text("sender_name").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    proofNote: text("proof_note"),
    attachmentId: uuid("attachment_id"),
    status: proofStatusEnum("status").notNull().default("PENDING"),
    submittedBy: uuid("submitted_by"),
    submittedByName: text("submitted_by_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedBy: uuid("verified_by"),
    verifiedByName: text("verified_by_name"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    isDuplicateSuspect: boolean("is_duplicate_suspect").notNull().default(false)
  },
  (table) => [
    index("payment_proofs_status_idx").on(table.status, table.submittedAt),
    index("payment_proofs_reference_idx").on(sql`upper(${table.referenceNumber})`),
    index("payment_proofs_account_idx").on(table.serviceAccountId)
  ]
);

/**
 * Receipt records. The `receipt_number` is also stored on `payments`; this table
 * is the authoritative register of issued receipt numbers. Voided receipts keep
 * their row so a number is never reissued.
 */
export const receipts = pgTable(
  "receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptNumber: text("receipt_number").notNull(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    issuedBy: uuid("issued_by"),
    issuedByName: text("issued_by_name"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason")
  },
  (table) => [
    uniqueIndex("receipts_number_unique").on(sql`upper(${table.receiptNumber})`),
    uniqueIndex("receipts_payment_unique").on(table.paymentId),
    index("receipts_issued_idx").on(table.issuedAt)
  ]
);

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [payments.serviceAccountId],
    references: [serviceAccounts.id]
  }),
  subscriber: one(subscribers, { fields: [payments.subscriberId], references: [subscribers.id] }),
  allocations: many(paymentAllocations),
  reversals: many(paymentReversals),
  receipt: one(receipts)
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, { fields: [paymentAllocations.paymentId], references: [payments.id] }),
  invoice: one(invoices, { fields: [paymentAllocations.invoiceId], references: [invoices.id] })
}));

export const paymentReversalsRelations = relations(paymentReversals, ({ one }) => ({
  payment: one(payments, { fields: [paymentReversals.paymentId], references: [payments.id] })
}));

export const paymentProofsRelations = relations(paymentProofs, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [paymentProofs.serviceAccountId],
    references: [serviceAccounts.id]
  })
}));

export const receiptsRelations = relations(receipts, ({ one }) => ({
  payment: one(payments, { fields: [receipts.paymentId], references: [payments.id] })
}));
