import { relations, sql } from "drizzle-orm";
import {
  bigint,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { collectionAreas, collectionRoutes, collectors } from "./directory.js";
import { serviceAccounts } from "./services.js";
import { batchAccountStatusEnum, batchStatusEnum, remittanceStatusEnum } from "./enums.js";

/**
 * Which collector is responsible for which service account, over which period.
 * Assignment is temporal so a route or collector change never rewrites history.
 */
export const collectorAssignments = pgTable(
  "collector_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    collectorId: uuid("collector_id")
      .notNull()
      .references(() => collectors.id, { onDelete: "restrict" }),
    areaId: uuid("area_id")
      .notNull()
      .references(() => collectionAreas.id, { onDelete: "restrict" }),
    routeId: uuid("route_id").references(() => collectionRoutes.id, { onDelete: "set null" }),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    assignedBy: uuid("assigned_by"),
    assignedByName: text("assigned_by_name"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("collector_assignments_account_idx").on(table.serviceAccountId, table.effectiveFrom),
    index("collector_assignments_collector_idx").on(table.collectorId),
    index("collector_assignments_area_idx").on(table.areaId),
    index("collector_assignments_route_idx").on(table.routeId)
  ]
);

/**
 * A collection batch is the accountability envelope for one collector on one
 * day. `status` enforces the lifecycle
 * OPEN -> IN_PROGRESS -> SUBMITTED -> REMITTED -> RECONCILED -> CLOSED.
 */
export const collectionBatches = pgTable(
  "collection_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchNumber: text("batch_number").notNull(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => collectionAreas.id, { onDelete: "restrict" }),
    routeId: uuid("route_id").references(() => collectionRoutes.id, { onDelete: "set null" }),
    collectorId: uuid("collector_id")
      .notNull()
      .references(() => collectors.id, { onDelete: "restrict" }),
    batchDate: date("batch_date").notNull(),
    dueDayCutoff: integer("due_day_cutoff").notNull().default(31),
    status: batchStatusEnum("status").notNull().default("OPEN"),
    accountCount: integer("account_count").notNull().default(0),
    expectedReceivableCentavos: bigint("expected_receivable_centavos", { mode: "number" }).notNull().default(0),
    cashCollectedCentavos: bigint("cash_collected_centavos", { mode: "number" }).notNull().default(0),
    nonCashCollectedCentavos: bigint("non_cash_collected_centavos", { mode: "number" }).notNull().default(0),
    totalCollectedCentavos: bigint("total_collected_centavos", { mode: "number" }).notNull().default(0),
    uncollectedCentavos: bigint("uncollected_centavos", { mode: "number" }).notNull().default(0),
    openedBy: uuid("opened_by"),
    openedByName: text("opened_by_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    remittedAt: timestamp("remitted_at", { withTimezone: true }),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledBy: uuid("reconciled_by"),
    reconciledByName: text("reconciled_by_name"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("collection_batches_number_unique").on(sql`upper(${table.batchNumber})`),
    index("collection_batches_collector_date_idx").on(table.collectorId, table.batchDate),
    index("collection_batches_status_idx").on(table.status),
    index("collection_batches_area_idx").on(table.areaId)
  ]
);

export const batchAccounts = pgTable(
  "batch_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => collectionBatches.id, { onDelete: "cascade" }),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    currentBillCentavos: bigint("current_bill_centavos", { mode: "number" }).notNull().default(0),
    arrearsCentavos: bigint("arrears_centavos", { mode: "number" }).notNull().default(0),
    totalDueCentavos: bigint("total_due_centavos", { mode: "number" }).notNull().default(0),
    collectedCentavos: bigint("collected_centavos", { mode: "number" }).notNull().default(0),
    status: batchAccountStatusEnum("status").notNull().default("PENDING"),
    collectionNotes: text("collection_notes"),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("batch_accounts_batch_account_unique").on(table.batchId, table.serviceAccountId),
    index("batch_accounts_batch_status_idx").on(table.batchId, table.status),
    index("batch_accounts_account_idx").on(table.serviceAccountId)
  ]
);

/**
 * Collector remittance.
 *
 * `shortage_centavos` and `overage_centavos` are always derived, never typed in
 * by the collector, and a batch may only reach RECONCILED/CLOSED through a
 * confirmed remittance.
 */
export const collectorRemittances = pgTable(
  "collector_remittances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    remittanceNumber: text("remittance_number").notNull(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => collectionBatches.id, { onDelete: "restrict" }),
    collectorId: uuid("collector_id")
      .notNull()
      .references(() => collectors.id, { onDelete: "restrict" }),
    remittanceDate: date("remittance_date").notNull(),
    cashCollectedCentavos: bigint("cash_collected_centavos", { mode: "number" }).notNull().default(0),
    cashRemittedCentavos: bigint("cash_remitted_centavos", { mode: "number" }).notNull().default(0),
    nonCashCollectedCentavos: bigint("non_cash_collected_centavos", { mode: "number" }).notNull().default(0),
    differenceCentavos: bigint("difference_centavos", { mode: "number" }).notNull().default(0),
    shortageCentavos: bigint("shortage_centavos", { mode: "number" }).notNull().default(0),
    overageCentavos: bigint("overage_centavos", { mode: "number" }).notNull().default(0),
    status: remittanceStatusEnum("status").notNull().default("DRAFT"),
    submittedBy: uuid("submitted_by"),
    submittedByName: text("submitted_by_name"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    confirmedBy: uuid("confirmed_by"),
    confirmedByName: text("confirmed_by_name"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    remarks: text("remarks"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("collector_remittances_number_unique").on(sql`upper(${table.remittanceNumber})`),
    index("collector_remittances_batch_idx").on(table.batchId),
    index("collector_remittances_collector_idx").on(table.collectorId, table.remittanceDate),
    index("collector_remittances_status_idx").on(table.status)
  ]
);

export const collectorAssignmentsRelations = relations(collectorAssignments, ({ one }) => ({
  collector: one(collectors, { fields: [collectorAssignments.collectorId], references: [collectors.id] }),
  area: one(collectionAreas, { fields: [collectorAssignments.areaId], references: [collectionAreas.id] }),
  route: one(collectionRoutes, { fields: [collectorAssignments.routeId], references: [collectionRoutes.id] }),
  serviceAccount: one(serviceAccounts, {
    fields: [collectorAssignments.serviceAccountId],
    references: [serviceAccounts.id]
  })
}));

export const collectionBatchesRelations = relations(collectionBatches, ({ one, many }) => ({
  area: one(collectionAreas, { fields: [collectionBatches.areaId], references: [collectionAreas.id] }),
  route: one(collectionRoutes, { fields: [collectionBatches.routeId], references: [collectionRoutes.id] }),
  collector: one(collectors, { fields: [collectionBatches.collectorId], references: [collectors.id] }),
  accounts: many(batchAccounts),
  remittances: many(collectorRemittances)
}));

export const batchAccountsRelations = relations(batchAccounts, ({ one }) => ({
  batch: one(collectionBatches, { fields: [batchAccounts.batchId], references: [collectionBatches.id] }),
  serviceAccount: one(serviceAccounts, {
    fields: [batchAccounts.serviceAccountId],
    references: [serviceAccounts.id]
  })
}));

export const collectorRemittancesRelations = relations(collectorRemittances, ({ one }) => ({
  batch: one(collectionBatches, {
    fields: [collectorRemittances.batchId],
    references: [collectionBatches.id]
  }),
  collector: one(collectors, {
    fields: [collectorRemittances.collectorId],
    references: [collectors.id]
  })
}));
