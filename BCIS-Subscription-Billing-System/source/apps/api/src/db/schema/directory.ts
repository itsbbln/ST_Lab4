import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { serviceTypeEnum, subscriberStatusEnum } from "./enums.js";

/**
 * Directory data: service catalogue plus the collection topology
 * (areas, routes, collectors, technicians) and the subscriber master file.
 *
 * All monetary columns are `bigint` centavos. JavaScript never performs
 * floating-point arithmetic on money anywhere in this codebase.
 */

export const serviceTypes = pgTable(
  "service_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default("")
  },
  (table) => [uniqueIndex("service_types_code_unique").on(table.code)]
);

export const collectionAreas = pgTable(
  "collection_areas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("collection_areas_code_unique").on(sql`lower(${table.code})`)]
);

export const collectionRoutes = pgTable(
  "collection_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    areaId: uuid("area_id")
      .notNull()
      .references(() => collectionAreas.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("collection_routes_code_unique").on(sql`lower(${table.code})`),
    index("collection_routes_area_idx").on(table.areaId)
  ]
);

export const collectors = pgTable(
  "collectors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    fullName: text("full_name").notNull(),
    contactNumber: text("contact_number").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("collectors_code_unique").on(sql`lower(${table.code})`)]
);

export const technicians = pgTable(
  "technicians",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    fullName: text("full_name").notNull(),
    contactNumber: text("contact_number").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("technicians_code_unique").on(sql`lower(${table.code})`)]
);

export const servicePlans = pgTable(
  "service_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    serviceTypeId: uuid("service_type_id")
      .notNull()
      .references(() => serviceTypes.id, { onDelete: "restrict" }),
    monthlyPriceCentavos: bigint("monthly_price_centavos", { mode: "number" }).notNull(),
    installationFeeCentavos: bigint("installation_fee_centavos", { mode: "number" }).notNull().default(0),
    reconnectionFeeCentavos: bigint("reconnection_fee_centavos", { mode: "number" }).notNull().default(0),
    speedMbps: integer("speed_mbps"),
    channelCount: integer("channel_count"),
    description: text("description").notNull().default(""),
    isActive: boolean("is_active").notNull().default(true),
    effectiveFrom: date("effective_from"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by")
  },
  (table) => [
    uniqueIndex("service_plans_code_unique").on(sql`lower(${table.code})`),
    index("service_plans_service_type_idx").on(table.serviceTypeId),
    index("service_plans_active_idx").on(table.isActive)
  ]
);

export const subscribers = pgTable(
  "subscribers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountNumber: text("account_number").notNull(),
    fullName: text("full_name").notNull(),
    contactNumber: text("contact_number").notNull(),
    email: text("email"),
    addressLine: text("address_line").notNull(),
    city: text("city").notNull(),
    collectionAreaId: uuid("collection_area_id")
      .notNull()
      .references(() => collectionAreas.id, { onDelete: "restrict" }),
    billingDueDay: integer("billing_due_day").notNull().default(5),
    status: subscriberStatusEnum("status").notNull().default("ACTIVE"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by"),
    updatedBy: uuid("updated_by")
  },
  (table) => [
    uniqueIndex("subscribers_account_number_unique").on(sql`upper(${table.accountNumber})`),
    index("subscribers_full_name_idx").on(sql`lower(${table.fullName})`),
    index("subscribers_contact_number_idx").on(sql`right(${table.contactNumber}, 10)`),
    index("subscribers_area_idx").on(table.collectionAreaId),
    index("subscribers_status_idx").on(table.status)
  ]
);

export const subscriberAddresses = pgTable(
  "subscriber_addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subscriberId: uuid("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "restrict" }),
    label: text("label").notNull(),
    addressLine: text("address_line").notNull(),
    city: text("city").notNull(),
    isPrincipal: boolean("is_principal").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("subscriber_addresses_subscriber_idx").on(table.subscriberId),
    index("subscriber_addresses_text_idx").on(sql`lower(${table.addressLine})`)
  ]
);

export const serviceTypesRelations = relations(serviceTypes, ({ many }) => ({
  plans: many(servicePlans)
}));

export const collectionAreasRelations = relations(collectionAreas, ({ many }) => ({
  routes: many(collectionRoutes),
  subscribers: many(subscribers)
}));

export const collectionRoutesRelations = relations(collectionRoutes, ({ one, many }) => ({
  area: one(collectionAreas, { fields: [collectionRoutes.areaId], references: [collectionAreas.id] })
}));

export const collectorsRelations = relations(collectors, () => ({}));

export const servicePlansRelations = relations(servicePlans, ({ one }) => ({
  serviceType: one(serviceTypes, { fields: [servicePlans.serviceTypeId], references: [serviceTypes.id] })
}));

export const subscribersRelations = relations(subscribers, ({ one, many }) => ({
  collectionArea: one(collectionAreas, {
    fields: [subscribers.collectionAreaId],
    references: [collectionAreas.id]
  }),
  addresses: many(subscriberAddresses)
}));

export const subscriberAddressesRelations = relations(subscriberAddresses, ({ one }) => ({
  subscriber: one(subscribers, {
    fields: [subscriberAddresses.subscriberId],
    references: [subscribers.id]
  })
}));

export const techniciansRelations = relations(technicians, () => ({}));
