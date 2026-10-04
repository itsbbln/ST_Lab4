import { sql } from "drizzle-orm";

import { documentSequences } from "../db/schema/index.js";
import { queryRow, type Executor } from "../db/client.js";

/**
 * Gap-free, per-year document numbering.
 *
 * Receipt, invoice, reversal, batch and remittance numbers are all drawn from
 * this one allocator. The increment is a single atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`, so three office clients
 * posting at the same moment can never receive the same number, and a
 * transaction that rolls back also rolls back its number.
 *
 * §3.11 additionally requires that a voided receipt number is never reissued.
 * That is guaranteed by a separate unique index over `receipts.receipt_number`,
 * not by this allocator: the number is simply consumed for good.
 */

export const documentTypes = {
  INVOICE: "INV",
  RECEIPT: "RCPT",
  REVERSAL: "REV",
  BATCH: "BATCH",
  REMITTANCE: "REM",
  SERVICE_ACCOUNT: "SA"
} as const;

export type DocumentType = keyof typeof documentTypes;

const padWidth = 6;

/**
 * Reserves the next value for `documentType` in `year` and returns it.
 *
 * Must be called inside the same transaction as the insert that uses the
 * number, so that a rolled-back posting does not burn a number.
 */
export async function nextDocumentNumber(
  executor: Executor,
  documentType: DocumentType,
  year: number
): Promise<number> {
  const prefix = documentTypes[documentType];
  const row = await queryRow<{ next_value: number }>(
    executor,
    sql`
    INSERT INTO ${documentSequences} (document_type, year, next_value)
    VALUES (${prefix}, ${year}, 2)
    ON CONFLICT (document_type, year)
    DO UPDATE SET next_value = ${documentSequences.nextValue} + 1, updated_at = now()
    RETURNING next_value
  `
  );

  const reserved = row?.next_value;
  if (reserved === undefined) {
    throw new Error(`Failed to reserve a number for ${prefix} ${year}.`);
  }
  // The row stores the *next* value to hand out, so the number just consumed is
  // one less than what the row now holds.
  return reserved - 1;
}

/** Formats a reserved value as a document number, e.g. `RCPT-2026-000123`. */
export function formatDocumentNumber(documentType: DocumentType, year: number, value: number): string {
  return `${documentTypes[documentType]}-${year}-${String(value).padStart(padWidth, "0")}`;
}

/** Convenience wrapper: reserve and format in one call. */
export async function nextDocument(
  executor: Executor,
  documentType: DocumentType,
  year: number
): Promise<string> {
  const value = await nextDocumentNumber(executor, documentType, year);
  return formatDocumentNumber(documentType, year, value);
}
