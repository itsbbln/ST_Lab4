import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getDatabase } from "../db/client.js";
import { actorOf, authorize } from "../http/guards.js";
import { createBackup, getBackup, listBackups, restoreBackup, verifyBackup } from "../services/backup.js";
import { runIntegrityChecks } from "../services/integrity.js";
import { validationFailed } from "../services/errors.js";

/**
 * Backup, restore and integrity endpoints (AT-12, §4.5, Phase 9).
 *
 * Every route here is gated on `backup.restore`, which only `OWNER` holds. That
 * is deliberate: a restore replaces the entire financial history, so it is the
 * single most destructive operation in the system and belongs to one role.
 *
 * The register is separate from the file operations so the Administration screen
 * can list backups without spawning `pg_dump` - a dump of the target data volume
 * is measured in minutes, and a list view must never do that implicitly.
 */

const createBackupSchema = z.object({
  /** Defaults to true: an attachment backup that is off by default is never taken. */
  includesAttachments: z.boolean().default(true),
  notes: z.string().trim().max(300).optional()
});

const restoreBackupSchema = z.object({
  /**
   * Mandatory confirmation. Restoring overwrites live financial records, so the
   * caller has to state that they intend it; the service rejects anything else
   * and the acknowledgement is written to the audit trail.
   */
  acknowledge: z.literal(true, {
    error: "Restoring a backup replaces the current database. Confirm the restore to continue."
  }),
  notes: z.string().trim().max(300).optional()
});

const listQuerySchema = z.object({
  status: z.enum(["CREATED", "VERIFIED", "RESTORED", "FAILED"]).optional()
});

export async function registerBackupRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/backups",
    { preHandler: authorize("backup.restore") },
    async (request) => {
      const parsed = listQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw validationFailed("The backup filter is not valid.");
      }
      return { items: await listBackups(parsed.data.status) };
    }
  );

  app.get(
    "/backups/integrity",
    { preHandler: authorize("backup.restore") },
    async () => runIntegrityChecks(getDatabase().db)
  );

  app.get(
    "/backups/:backupId",
    { preHandler: authorize("backup.restore") },
    async (request) => {
      const { backupId } = request.params as { backupId: string };
      return { backup: await getBackup(backupId) };
    }
  );

  app.post(
    "/backups",
    { preHandler: authorize("backup.restore") },
    async (request, reply) => {
      const parsed = createBackupSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw validationFailed("The backup request is not valid.");
      }
      const result = await createBackup(parsed.data, actorOf(request));
      return reply.status(201).send(result);
    }
  );

  app.post(
    "/backups/:backupId/verify",
    { preHandler: authorize("backup.restore") },
    async (request) => {
      const actor = actorOf(request);
      const { backupId } = request.params as { backupId: string };
      return verifyBackup(backupId, actor);
    }
  );

  app.post(
    "/backups/:backupId/restore",
    { preHandler: authorize("backup.restore") },
    async (request) => {
      const actor = actorOf(request);
      const { backupId } = request.params as { backupId: string };
      const parsed = restoreBackupSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw validationFailed(
          "Restoring a backup replaces the current database. Confirm the restore to continue.",
          {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          }
        );
      }
      return restoreBackup(backupId, parsed.data, actor);
    }
  );
}
