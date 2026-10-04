import type { FastifyInstance } from "fastify";
import { upsertSettingSchema } from "@bcis/shared";

import { getDatabase } from "../db/client.js";
import { auditQuerySchema, listAuditActions, listAuditLogs, listEntityAudit } from "../services/audit.js";
import { validationFailed } from "../services/errors.js";
import { getSettings, listSettings, settingRow, updateSetting } from "../services/settings.js";
import { actorOf, authorize } from "../http/guards.js";

/**
 * Settings and the audit trail (§3.11, §4.5).
 *
 * The audit log is read-only over HTTP. There is no route that deletes or edits
 * an audit row, which is deliberate: it is the record the lab's accountability
 * requirements are checked against.
 */
export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  app.get("/settings", { preHandler: authorize("settings.manage") }, async () => ({
    settings: await getSettings(db),
    rows: await listSettings(db)
  }));

  app.put("/settings/:key", { preHandler: authorize("settings.manage") }, async (request) => {
    const { key } = request.params as { key: string };
    const parsed = upsertSettingSchema.safeParse(request.body);
    if (!parsed.success) {
      throw validationFailed("The setting could not be saved.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const row = await updateSetting(db, key, parsed.data.value, {
      description: parsed.data.description,
      actor: actorOf(request)
    });
    return { key: row?.key, value: row?.value };
  });

  app.get("/settings/:key", { preHandler: authorize("settings.manage") }, async (request) => {
    const { key } = request.params as { key: string };
    return { row: await settingRow(db, key) };
  });

  // ---- Audit ---------------------------------------------------------------

  app.get("/audit", { preHandler: authorize("audit.view") }, async (request) => {
    const parsed = auditQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The audit query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    return listAuditLogs(db, parsed.data);
  });

  // The history for one record, e.g. every change made to a single subscriber.
  app.get("/audit/entity/:entityType/:entityId", { preHandler: authorize("audit.view") }, async (request) => {
    const { entityType, entityId } = request.params as { entityType: string; entityId: string };
    return { items: await listEntityAudit(db, entityType, entityId) };
  });

  app.get("/audit/actions", { preHandler: authorize("audit.view") }, async () => ({
    items: await listAuditActions(db)
  }));
}
