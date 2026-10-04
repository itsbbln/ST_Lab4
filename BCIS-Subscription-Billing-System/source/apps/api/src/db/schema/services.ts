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

import { collectors, servicePlans, subscribers } from "./directory.js";
import { serviceAccountStatusEnum, serviceEventTypeEnum } from "./enums.js";

/**
 * `current_rate_centavos` is a snapshot of the plan price taken when the
 * service account is activated or the plan changes. Invoices read the snapshot,
 * never the live plan price, so a plan price change only affects future billing
 * and historical invoices keep the rate that was actually billed.
 */
export const serviceAccounts = pgTable(
  "service_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountNumber: text("service_account_number").notNull(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => servicePlans.id, { onDelete: "restrict" }),
    installationAddress: text("installation_address").notNull(),
    activationDate: date("activation_date").notNull(),
    billingStartPeriod: text("billing_start_period").notNull(),
    billingDueDay: integer("billing_due_day").notNull().default(5),
    currentRateCentavos: bigint("current_rate_centavos", { mode: "number" }).notNull(),
    status: serviceAccountStatusEnum("status").notNull().default("PENDING_ACTIVATION"),
    collectorId: uuid("collector_id").references(() => collectors.id, { onDelete: "set null" }),
    creditBalanceCentavos: bigint("credit_balance_centavos", { mode: "number" }).notNull().default(0),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by")
  },
  (table) => [
    uniqueIndex("service_accounts_number_unique").on(sql`upper(${table.serviceAccountNumber})`),
    index("service_accounts_subscriber_idx").on(table.subscriberId),
    index("service_accounts_plan_idx").on(table.planId),
    index("service_accounts_collector_idx").on(table.collectorId),
    index("service_accounts_status_idx").on(table.status),
    index("service_accounts_billing_start_idx").on(table.billingStartPeriod)
  ]
);

export const serviceEvents = pgTable(
  "service_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "cascade" }),
    eventType: serviceEventTypeEnum("event_type").notNull(),
    reason: text("reason"),
    effectiveDate: date("effective_date").notNull(),
    notes: text("notes"),
    actorId: uuid("actor_id"),
    actorName: text("actor_name"),
    metadata: text("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("service_events_account_idx").on(table.serviceAccountId, table.effectiveDate),
    index("service_events_type_idx").on(table.eventType)
  ]
);

export const serviceDevices = pgTable(
  "service_devices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "cascade" }),
    deviceType: text("device_type").notNull(),
    serialNumber: text("serial_number"),
    model: text("model"),
    status: text("status").notNull().default("INSTALLED"),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    notes: text("notes")
  },
  (table) => [
    index("service_devices_account_idx").on(table.serviceAccountId),
    index("service_devices_serial_idx").on(table.serialNumber)
  ]
);

export const serviceAccountsRelations = relations(serviceAccounts, ({ one, many }) => ({
  subscriber: one(subscribers, { fields: [serviceAccounts.subscriberId], references: [subscribers.id] }),
  plan: one(servicePlans, { fields: [serviceAccounts.planId], references: [servicePlans.id] }),
  collector: one(collectors, { fields: [serviceAccounts.collectorId], references: [collectors.id] }),
  events: many(serviceEvents),
  devices: many(serviceDevices)
}));

export const serviceEventsRelations = relations(serviceEvents, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [serviceEvents.serviceAccountId],
    references: [serviceAccounts.id]
  })
}));

export const serviceDevicesRelations = relations(serviceDevices, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [serviceDevices.serviceAccountId],
    references: [serviceAccounts.id]
  })
}));

/** A service account that may still generate monthly invoices. */
export const serviceAccountIsBillable = sql`${serviceAccounts.status} IN ('PENDING_ACTIVATION','ACTIVE')`;
