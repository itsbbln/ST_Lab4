import { relations } from "drizzle-orm";
import { bigint, date, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { serviceAccounts } from "./services.js";

/**
 * The subscriber ledger.
 *
 * A row is an immutable financial posting against a service account. The running
 * balance is never stored: it is recomputed deterministically from the ordered
 * debit/credit history so it can be reproduced and audited at any time.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceAccountId: uuid("service_account_id")
      .notNull()
      .references(() => serviceAccounts.id, { onDelete: "restrict" }),
    entryDate: date("entry_date").notNull(),
    postingDate: timestamp("posting_date", { withTimezone: true }).notNull().defaultNow(),
    reference: text("reference").notNull(),
    description: text("description").notNull(),
    entryType: text("entry_type").notNull(),
    debitCentavos: bigint("debit_centavos", { mode: "number" }).notNull().default(0),
    creditCentavos: bigint("credit_centavos", { mode: "number" }).notNull().default(0),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    createdBy: uuid("created_by"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("ledger_entries_account_date_idx").on(table.serviceAccountId, table.entryDate, table.postingDate),
    index("ledger_entries_reference_idx").on(table.reference),
    index("ledger_entries_source_idx").on(table.sourceType, table.sourceId)
  ]
);

export const ledgerEntriesRelations = relations(ledgerEntries, ({ one }) => ({
  serviceAccount: one(serviceAccounts, {
    fields: [ledgerEntries.serviceAccountId],
    references: [serviceAccounts.id]
  })
}));
