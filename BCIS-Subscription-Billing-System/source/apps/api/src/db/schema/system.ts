import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import { users } from "./security.js";
import { backupStatusEnum } from "./enums.js";

/**
 * The audit trail. There is deliberately no update or delete path for this
 * table anywhere in the application; §4.4 requires that audit logs are not
 * editable through normal application screens.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorUsername: text("actor_username").notNull().default("system"),
    actorName: text("actor_name").notNull().default("System"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    reason: text("reason"),
    oldValues: jsonb("old_values"),
    newValues: jsonb("new_values"),
    ipAddress: text("ip_address"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_logs_created_idx").on(table.createdAt),
    index("audit_logs_actor_idx").on(table.actorId, table.createdAt),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId)
  ]
);

export const applicationSettings = pgTable("application_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  valueLabel: text("value_label").notNull(),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("GENERAL"),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedByName: text("updated_by_name"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const backupHistory = pgTable(
  "backup_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    backupId: text("backup_id").notNull(),
    fileName: text("file_name").notNull(),
    filePath: text("file_path").notNull(),
    fileSizeBytes: bigint("file_size_bytes", { mode: "number" }).notNull().default(0),
    checksum: text("checksum"),
    checksumAlgorithm: text("checksum_algorithm").notNull().default("sha256"),
    status: backupStatusEnum("status").notNull().default("CREATED"),
    includesAttachments: boolean("includes_attachments").notNull().default(true),
    tableCounts: jsonb("table_counts"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByName: text("verified_by_name"),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    restoredByName: text("restored_by_name"),
    notes: text("notes")
  },
  (table) => [
    uniqueIndex("backup_history_backup_id_unique").on(table.backupId),
    index("backup_history_status_idx").on(table.status),
    index("backup_history_created_idx").on(table.createdAt)
  ]
);

/** Gap-free per-year document numbering. */
export const documentSequences = pgTable(
  "document_sequences",
  {
    documentType: text("document_type").notNull(),
    year: integer("year").notNull(),
    nextValue: integer("next_value").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.documentType, table.year] })]
);

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    originalName: text("original_name").notNull(),
    storedPath: text("stored_path").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    uploadedByName: text("uploaded_by_name"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("attachments_entity_idx").on(table.entityType, table.entityId),
    index("attachments_checksum_idx").on(table.checksumSha256)
  ]
);

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  actor: one(users, { fields: [auditLogs.actorId], references: [users.id] })
}));

export const backupHistoryRelations = relations(backupHistory, ({ one }) => ({
  creator: one(users, { fields: [backupHistory.createdBy], references: [users.id] })
}));