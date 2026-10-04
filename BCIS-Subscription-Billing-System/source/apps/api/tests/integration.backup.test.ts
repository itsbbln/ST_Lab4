import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { closeDatabase, getDatabase } from "../src/db/client.js";
import { applicationSettings, auditLogs, backupHistory } from "../src/db/schema/index.js";
import {
  backupDirectory,
  createBackup,
  getBackup,
  listBackups,
  restoreBackup,
  verifyBackup
} from "../src/services/backup.js";
import { runIntegrityChecks } from "../src/services/integrity.js";

/**
 * Backup, verification and restore against a real PostgreSQL server (§4.5, AT-12).
 *
 * This suite is the only one that shells out to `pg_dump` and `pg_restore`, and
 * the restore half genuinely replaces the contents of the database it points at.
 * It therefore has a hard two-part guard:
 *
 *  1. The database name must end in `_test`, checked in `beforeAll` before
 *     anything is dumped.
 *  2. `assertTestDatabase()` is called again immediately before the destructive
 *     `pg_restore`, so a mid-run environment change cannot redirect it.
 *
 * `ATTACHMENT_DIR` and `BACKUP_DIR` are redirected into the OS temp directory, so
 * neither a passing nor a failing run leaves archives inside the repository.
 */

function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(
      `Refusing to run backup tests against database "${name}". ` +
        "Set DATABASE_URL to a database whose name ends in _test."
    );
  }
}

const scratchRoot = join(tmpdir(), `bcis-backup-test-${process.pid}`);

/**
 * The database handle is resolved per call rather than cached.
 *
 * `restoreBackup` closes the pool and lets `getDatabase()` build a new one, so a
 * handle captured at module scope points at a dead pool for the rest of the run.
 * Services already do this; the suite has to as well.
 */
function currentDb() {
  return getDatabase().db;
}

/** Marker rows in a table that needs no foreign keys, used to prove rollback. */
const MARKER_KEY = "bcis_backup_restore_probe";

async function markerCount(): Promise<number> {
  // `LIKE`, not `=`: the markers are stored as `<prefix>_<label>`.
  const result = await currentDb().execute(
    sql`select count(*)::int as total from application_settings where key like ${MARKER_KEY + "%"}`
  );
  return Number((result.rows[0] as { total: number }).total);
}

async function addMarker(label: string): Promise<void> {
  await currentDb().insert(applicationSettings).values({
    key: `${MARKER_KEY}_${label}`,
    value: { label },
    valueLabel: `probe ${label}`
  });
}

beforeAll(async () => {
  assertTestDatabase();
  process.env.BACKUP_DIR = join(scratchRoot, "backups");
  process.env.ATTACHMENT_DIR = join(scratchRoot, "attachments");
  rmSync(scratchRoot, { recursive: true, force: true });

  // Truncate like every other integration suite. Without this the suite inherits
  // whatever the previous one left behind, and the "healthy database" integrity
  // assertion would then be reporting on another suite's fixtures.
  await currentDb().execute(`
    truncate table
      audit_logs, receipts, payment_reversals, payment_allocations, payment_proofs,
      ledger_entries, payments, invoice_items, invoice_adjustments, invoices, billing_cycles,
      document_sequences, application_settings,
      service_events, service_devices, service_accounts, subscriber_addresses,
      subscribers, service_plans, service_types, collection_areas,
      collection_routes, collector_assignments, collection_batches, batch_accounts,
      collector_remittances, collectors, technicians, attachments,
      reconnection_records, suspension_records, backup_history,
      sessions, users, user_roles, role_permissions, roles, permissions
    restart identity cascade`);
});

afterAll(async () => {
  rmSync(scratchRoot, { recursive: true, force: true });
  delete process.env.BACKUP_DIR;
  delete process.env.ATTACHMENT_DIR;
  await closeDatabase();
});

beforeEach(async () => {
  await currentDb().delete(backupHistory);
  await currentDb().delete(auditLogs);
  await currentDb().execute(sql`delete from application_settings where key like ${MARKER_KEY + "%"}`);
});

describe("backup creation", () => {
  it("produces an archive, a register row and an audit entry", async () => {
    const result = await createBackup({ includesAttachments: false, notes: "nightly" });

    expect(result.backup.status).toBe("CREATED");
    expect(result.backup.fileSizeBytes).toBeGreaterThan(0);
    expect(result.backup.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(result.backup.filePath)).toBe(true);
    expect(result.backup.filePath.startsWith(backupDirectory())).toBe(true);

    const [logged] = await currentDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "backup.created"));
    expect(logged.entityId).toBe(result.backup.backupId);
  });

  it("records table counts as acceptance evidence", async () => {
    await addMarker("counted");
    const result = await createBackup({ includesAttachments: false });

    expect(result.tableCounts).toBeTypeOf("object");
    // `COUNTED_TABLES` is the business-table list, not every table, so the
    // marker table is not in it. `users` is.
    expect(result.tableCounts.users).toBeTypeOf("number");
    expect(result.backup.tableCounts).toMatchObject(result.tableCounts);
  });
});

describe("backup verification", () => {
  it("moves a good archive to VERIFIED and records the check", async () => {
    const created = await createBackup({ includesAttachments: false });
    const verified = await verifyBackup(created.backup.backupId);

    expect(verified.ok).toBe(true);
    expect(verified.backup.status).toBe("VERIFIED");
    expect(verified.backup.verifiedAt).toBeInstanceOf(Date);
    // The archive is proved to parse and to carry a data section for every
    // business table - the check comes from `pg_restore --list`, not from the
    // recorded counts, so it is a real assertion about the file.
    expect(verified.archiveTables).toContain("users");
    expect(verified.archiveTables).toContain("invoices");
    // The register additionally records the attachment count, so this is a
    // subset match rather than equality.
    expect(verified.recordedTableCounts).toMatchObject(created.tableCounts);
    expect(verified.notes.length).toBeGreaterThan(0);

    const [logged] = await currentDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "backup.verified"));
    expect(logged.entityId).toBe(created.backup.backupId);
  });

  it("marks the backup FAILED when the archive on disk is corrupted", async () => {
    const created = await createBackup({ includesAttachments: false });

    // Corrupt the file after the fact, the way a bad disk or an interrupted copy
    // would. The register still holds the original checksum, so verification is
    // the thing that has to notice.
    const bytes = readFileSync(created.backup.filePath);
    writeFileSync(created.backup.filePath, Buffer.concat([bytes, Buffer.from("CORRUPT")]));

    await expect(verifyBackup(created.backup.backupId)).rejects.toThrow(/checksum/i);

    const after = await getBackup(created.backup.backupId);
    expect(after.status).toBe("FAILED");
  });

  it("reports a missing archive rather than throwing a raw filesystem error", async () => {
    const created = await createBackup({ includesAttachments: false });
    rmSync(created.backup.filePath, { force: true });

    await expect(verifyBackup(created.backup.backupId)).rejects.toThrow(/missing|no longer exists/i);
  });
});

describe("backup restore", () => {
  it("refuses an unverified backup", async () => {
    const created = await createBackup({ includesAttachments: false });

    await expect(restoreBackup(created.backup.backupId, { acknowledge: true })).rejects.toThrow(
      /has not been verified/i
    );
  });

  it("refuses a backup that failed verification", async () => {
    const created = await createBackup({ includesAttachments: false });
    const bytes = readFileSync(created.backup.filePath);
    writeFileSync(created.backup.filePath, Buffer.concat([bytes, Buffer.from("CORRUPT")]));
    await expect(verifyBackup(created.backup.backupId)).rejects.toThrow();

    await expect(restoreBackup(created.backup.backupId, { acknowledge: true })).rejects.toThrow(
      /failed verification/i
    );
  });

  it("refuses without the explicit acknowledgement", async () => {
    const created = await createBackup({ includesAttachments: false });
    await verifyBackup(created.backup.backupId);

    await expect(
      restoreBackup(created.backup.backupId, { acknowledge: false as unknown as true })
    ).rejects.toThrow(/Confirm the restore/i);
  });

  it("refuses a second restore of the same backup", async () => {
    const created = await createBackup({ includesAttachments: false });
    await verifyBackup(created.backup.backupId);
    await restoreBackup(created.backup.backupId, { acknowledge: true });

    await expect(restoreBackup(created.backup.backupId, { acknowledge: true })).rejects.toThrow(
      /already been restored/i
    );
  });

  it("rolls data back to the state captured in the archive", async () => {
    // A known state, then back it up.
    await addMarker("before");
    expect(await markerCount()).toBe(1);

    const created = await createBackup({ includesAttachments: false });
    await verifyBackup(created.backup.backupId);

    // Diverge from the archived state.
    await addMarker("after");
    expect(await markerCount()).toBe(2);

    // Re-check the target immediately before the destructive step.
    assertTestDatabase();

    const result = await restoreBackup(created.backup.backupId, { acknowledge: true });

    expect(result.backup.status).toBe("RESTORED");
    expect(result.backup.restoredAt).toBeInstanceOf(Date);
    // The marker added after the dump is gone: the data really rolled back.
    expect(await markerCount()).toBe(1);
    expect(result.integrity.passed).toBe(true);

    const [logged] = await currentDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "backup.restored"));
    expect(logged.entityId).toBe(created.backup.backupId);
  });
});

describe("backup listing", () => {
  it("lists the register and filters by status", async () => {
    const first = await createBackup({ includesAttachments: false });
    await verifyBackup(first.backup.backupId);
    await createBackup({ includesAttachments: false });

    expect((await listBackups()).length).toBeGreaterThanOrEqual(2);

    const verifiedOnly = await listBackups("VERIFIED");
    expect(verifiedOnly.length).toBe(1);
    expect(verifiedOnly.every((backup) => backup.status === "VERIFIED")).toBe(true);
  });

  it("reports whether the archive is still present on disk", async () => {
    const created = await createBackup({ includesAttachments: false });
    expect((await getBackup(created.backup.backupId)).filePresent).toBe(true);

    rmSync(created.backup.filePath, { force: true });
    expect((await getBackup(created.backup.backupId)).filePresent).toBe(false);
  });
});

describe("database integrity checks", () => {
  it("passes on a healthy database", async () => {
    const report = await runIntegrityChecks(currentDb());
    const failures = report.checks.filter((check) => !check.passed);

    // Named rather than `expect(...).toEqual([])` so a failure output says which
    // invariant broke and how many rows broke it.
    expect(failures.map((check) => `${check.name} (${check.violations} violations)`)).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
