import type { FastifyInstance } from "fastify";
import { isoDateSchema, ledgerQuerySchema } from "@bcis/shared";

import { getDatabase } from "../db/client.js";
import { validationFailed } from "../services/errors.js";
import {
  accountBalance,
  listLedger,
  recentLedgerActivity,
  statementOfAccount
} from "../services/ledger.js";
import { getServiceAccount } from "../services/directory.js";
import { authorize } from "../http/guards.js";

/**
 * Subscriber ledger and Statement of Account (§3.5).
 *
 * The running balance is computed inside PostgreSQL by a window function rather
 * than accumulated in JavaScript, so it cannot drift from the postings, and the
 * statement always reconciles to the account's true balance.
 */

export async function registerLedgerRoutes(app: FastifyInstance): Promise<void> {
  const { db } = getDatabase();

  app.get("/ledger/:serviceAccountId", { preHandler: authorize("billing.view") }, async (request) => {
    const { serviceAccountId } = request.params as { serviceAccountId: string };
    const parsed = ledgerQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      throw validationFailed("The ledger query is not valid.", {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    return listLedger(db, serviceAccountId, parsed.data);
  });

  // A negative balance is an advance on account, so the label matters to the
  // cashier: it is not an error state.
  app.get("/ledger/:serviceAccountId/balance", { preHandler: authorize("billing.view") }, async (request) => {
    const { serviceAccountId } = request.params as { serviceAccountId: string };
    const { balanceCentavos } = await accountBalance(db, serviceAccountId);
    return {
      serviceAccountId,
      balanceCentavos,
      isAdvance: balanceCentavos < 0
    };
  });

  // The full statement, including the subscriber and address labels a printed
  // copy needs.
  app.get(
    "/ledger/:serviceAccountId/statement",
    { preHandler: authorize("billing.view") },
    async (request) => {
      const { serviceAccountId } = request.params as { serviceAccountId: string };
      const query = request.query as { from?: string; to?: string };
      if (!isoDateSchema.safeParse(query.from).success || !isoDateSchema.safeParse(query.to).success) {
        throw validationFailed("The statement range must use YYYY-MM-DD for both from and to.");
      }
      if (query.from! > query.to!) {
        throw validationFailed("The start of the range must not be after its end.");
      }

      const account = await getServiceAccount(db, serviceAccountId);
      return statementOfAccount(db, serviceAccountId, {
        from: query.from!,
        to: query.to!,
        accountLabel: account.serviceAccountNumber,
        subscriberName: account.subscriberName,
        accountNumber: account.accountNumber,
        installationAddress: account.installationAddress
      });
    }
  );

  app.get("/ledger", { preHandler: authorize("dashboard.view") }, async (request) => {
    const limit = Number((request.query as { limit?: string }).limit ?? 20);
    return {
      items: await recentLedgerActivity(db, Number.isFinite(limit) ? Math.min(limit, 100) : 20)
    };
  });
}
