import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { actorOf, requireAuth } from "../http/guards.js";
import { getDashboard } from "../services/dashboard.js";
import { validationFailed } from "../services/errors.js";

/**
 * The management dashboard endpoint (AT-07, §4.1).
 *
 * Every authenticated user may open the dashboard - a collector needs to see
 * their own day at a glance just as much as the owner does - but the figure
 * groups are filtered by what the caller is actually permitted to see. The
 * service returns everything for a user holding `receivables.view` and omits the
 * arrears table for everyone else, rather than relying on the renderer to hide
 * rows it should never have received.
 *
 * The window is optional and defaults to today, so the common case is a plain
 * `GET /dashboard` with no query string.
 */

const dashboardQuerySchema = z
  .object({
    from: z.string().trim().min(1).max(10).optional(),
    to: z.string().trim().min(1).max(10).optional()
  })
  .strict();

export async function registerDashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/dashboard",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = dashboardQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) {
        throw validationFailed("The reporting period is not valid.");
      }
      return getDashboard(parsed.data, actorOf(request));
    }
  );
}
