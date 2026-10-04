import type { FastifyInstance } from "fastify";
import { changePasswordSchema, createUserSchema, loginSchema } from "@bcis/shared";
import type { RoleCode } from "@bcis/shared";

import { getDatabase, inTransaction } from "../db/client.js";
import { LOGIN_RATE_LIMIT, RATE_LIMIT_WINDOW } from "../http/limits.js";
import {
  assignRoles,
  changePassword,
  createUser,
  listRoleMatrix,
  listSessions,
  listUsers,
  login,
  logout,
  pruneExpiredSessions,
  revokeAllSessions
} from "../services/auth.js";
import { validationFailed } from "../services/errors.js";
import { actorOf, authorize, requireAuth } from "../http/guards.js";

/**
 * Authentication, session and user-administration endpoints (§4.2, §3.11).
 *
 * Note which routes are public: `POST /auth/login` only. Everything else, apart
 * from the liveness probe in `app.ts`, requires a bearer token.
 */
export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // Login is intentionally outside `authorize` — it is the one endpoint that
  // establishes the identity. Its route-level rate limit is far tighter than the
  // global budget so that password guessing from one machine is throttled here as
  // well as by the per-account lockout inside the service.
  app.post(
    "/auth/login",
    {
      config: {
        rateLimit: {
          max: LOGIN_RATE_LIMIT,
          timeWindow: RATE_LIMIT_WINDOW,
          errorResponseBuilder: () => ({
            // The plugin throws this object verbatim, so `statusCode` has to be
            // part of it: 429 Too Many Requests, not a server fault.
            statusCode: 429,
            error: {
              code: "TOO_MANY_REQUESTS",
              message: "Too many sign-in attempts from this device. Please wait a minute and try again."
            }
          })
        }
      }
    },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationFailed("Enter a username and a password.", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }

      const result = await login(parsed.data.username, parsed.data.password, {
        ipAddress: request.ip ?? null,
        userAgent: (request.headers["user-agent"] ?? null) as string | null
      });

      return reply.send({
        token: result.token,
        expiresAt: result.expiresAt,
        user: result.user
      });
    }
  );

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    const header = request.headers.authorization ?? "";
    await logout(header.replace(/^Bearer\s+/i, "").trim(), request.actor);
    return reply.send({ ok: true });
  });

  // The renderer calls this on boot to decide whether a stored token is still
  // usable, and to hydrate the signed-in user's permission set.
  app.get("/auth/me", { preHandler: requireAuth }, async (request) => {
    const actor = actorOf(request);
    const { db } = getDatabase();
    const sessions = await listSessions(actor.id);
    return {
      user: {
        id: actor.id,
        username: actor.username,
        displayName: actor.displayName,
        permissions: actor.permissions
      },
      activeSessions: sessions.filter(
        (session) => !session.revokedAt && session.expiresAt > new Date()
      ).length
    };
  });

  app.post(
    "/auth/change-password",
    { preHandler: requireAuth },
    async (request, reply) => {
      const actor = actorOf(request);
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationFailed("The new password does not meet the password policy.");
      }
      await inTransaction((tx) =>
        changePassword(tx, actor.id, parsed.data.currentPassword, parsed.data.newPassword)
      );
      // Every other session is dropped: a password change on a shared office PC
      // must lock out anyone who was signed in with the old credential.
      await revokeAllSessions(getDatabase().db, actor.id);
      return reply.send({ ok: true, message: "Your password has been changed. Please sign in again." });
    }
  );

  // ---- User administration -------------------------------------------------

  app.get(
    "/users",
    { preHandler: authorize("user.manage") },
    async () => {
      const { db } = getDatabase();
      return { items: await listUsers(db) };
    }
  );

  app.get(
    "/users/role-matrix",
    { preHandler: authorize("user.manage") },
    async () => {
      const { db } = getDatabase();
      return { items: await listRoleMatrix(db) };
    }
  );

  app.post(
    "/users",
    { preHandler: authorize("user.manage") },
    async (request, reply) => {
      const actor = actorOf(request);
      const parsed = createUserSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationFailed("The new user could not be created.", {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        });
      }
      const { db } = getDatabase();
      const user = await inTransaction((tx) => createUser(tx, parsed.data, actor));
      return reply.status(201).send({ id: user.id, username: user.username });
    }
  );

  app.put(
    "/users/:id/roles",
    { preHandler: authorize("user.manage") },
    async (request) => {
      const actor = actorOf(request);
      const { id } = request.params as { id: string };
      const body = request.body as { roleCodes?: string[] };
      const requested = body?.roleCodes;
      if (!Array.isArray(requested) || requested.length === 0) {
        throw validationFailed("Select at least one role for the user.");
      }
      const { db } = getDatabase();
      await inTransaction(async (tx) => {
        await assignRoles(
          tx,
          id,
          requested as RoleCode[],
          actor
        );
        // Permissions are derived from roles at login, so a role change only
        // takes effect once live sessions are dropped.
        await revokeAllSessions(tx, id);
      });
      return { ok: true, userId: id };
    }
  );

  app.delete(
    "/users/:id/sessions",
    { preHandler: authorize("user.manage") },
    async (request) => {
      const { id } = request.params as { id: string };
      await revokeAllSessions(getDatabase().db, id);
      return { ok: true, userId: id };
    }
  );

  app.get(
    "/users/:id/sessions",
    { preHandler: authorize("user.manage") },
    async (request) => {
      const { id } = request.params as { id: string };
      return { items: await listSessions(id) };
    }
  );

  app.post(
    "/maintenance/prune-sessions",
    { preHandler: authorize("user.manage") },
    async () => ({ removed: await pruneExpiredSessions() })
  );
}
