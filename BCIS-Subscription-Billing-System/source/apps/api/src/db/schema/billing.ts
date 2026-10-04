import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { serviceAccounts } from "./services.js";
import { billingCycleStatusEnum, invoiceItemTypeEnum, invoiceStatusEnum } from "./enums.js";

export const billingCycles = pgTable(
  "billing_cycles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    period: text("period").notNull(),
    status: billingCycleStatusEnum("status").notNull().default("OPEN"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    generatedBy: uuid("generated_by"),
    generatedByName: text("generated_by_name"),
    invoiceCount: integer("invoice_count").notNull().default(0),
    totalBilledCentavos: bigint("total_billed_centavos", { mode: "number" }).notNull().default(0),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("billing_cycles_period_unique").on(table.period),
    index("billing_cycles_status_idx").on(table.status)
  ]
);

/**
 * Finalized invoices are immutable. `balance_centavos` is maintained
 * transactionally by the payment service and is always
 * `total_centavos - paid_centavos`.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceNumber: text("invoice_number").notNull(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    billingCycleId: uuid("billing_cycle_id").references(() => billingCycles.id, { onDelete: "set null" }),
    period: text("period").notNull(),
    issueDate: date("issue_date").notNull(),
    dueDate: date("due_date").notNull(),
    subtotalCentavos: bigint("subtotal_centavos", { mode: "number" }).notNull(),
    discountCentavos: bigint("discount_centavos", { mode: "number" }).notNull().default(0),
    penaltyCentavos: bigint("penalty_centavos", { mode: "number" }).notNull().default(0),
    totalCentavos: bigint("total_centavos", { mode: "number" }).notNull(),
    paidCentavos: bigint("paid_centavos", { mode: "number" }).notNull().default(0),
    balanceCentavos: bigint("balance_centavos", { mode: "number" }).notNull(),
    status: invoiceStatusEnum("status").notNull().default("DRAFT"),
    rateSnapshotCentavos: bigint("rate_snapshot_centavos", { mode: "number" }).notNull(),
    isFinalized: boolean("is_finalized").notNull().default(false),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("invoices_number_unique").on(sql`upper(${table.invoiceNumber})`),
    // The database, not application code, is the last line of defence against
    // duplicate billing for the same service account and period (AT-11).
    uniqueIndex("invoices_account_period_unique")
      .on(table.serviceAccountId, table.period)
      .where(sql`${table.status} <> 'VOID'`),
    index("invoices_due_date_status_idx").on(table.dueDate, table.status),
    index("invoices_period_idx").on(table.period),
    index("invoices_status_idx").on(table.status),
    index("invoices_balance_idx").on(table.balanceCentavos)
  ]
);

export const invoiceItems = pgTable(
  "invoice_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    itemType: invoiceItemTypeEnum("item_type").notNull(),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("1"),
    unitPriceCentavos: bigint("unit_price_centavos", { mode: "number" }).notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("invoice_items_invoice_idx").on(table.invoiceId, table.sortOrder),
    index("invoice_items_type_idx").on(table.itemType)
  ]
);

export const invoiceAdjustments = pgTable(
  "invoice_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    adjustmentType: invoiceItemTypeEnum("adjustment_type").notNull(),
    reason: text("reason").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    previousTotalCentavos: bigint("previous_total_centavos", { mode: "number" }).notNull(),
    newTotalCentavos: bigint("new_total_centavos", { mode: "number" }).notNull(),
    requestedBy: uuid("requested_by"),
    requestedByName: text("requested_by_name"),
    approvedBy: uuid("approved_by"),
    approvedByName: text("approved_by_name"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("invoice_adjustments_invoice_idx").on(table.invoiceId, table.createdAt)]
);

export const billingCyclesRelations = relations(billingCycles, ({ many }) => ({
  invoices: many(invoices)
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [invoices.serviceAccountId],
    references: [serviceAccounts.id]
  }),
  billingCycle: one(billingCycles, { fields: [invoices.billingCycleId], references: [billingCycles.id] }),
  items: many(invoiceItems),
  adjustments: many(invoiceAdjustments)
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] })
}));

export const invoiceAdjustmentsRelations = relations(invoiceAdjustments, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceAdjustments.invoiceId], references: [invoices.id] })
}));
