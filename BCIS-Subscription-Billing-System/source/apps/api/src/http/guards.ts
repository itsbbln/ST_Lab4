import type { FastifyReply, FastifyRequest } from "fastify";
import type { Permission } from "@bcis/shared";

import { resolveSession } from "../services/auth.js";
import { DomainError } from "../services/errors.js";
import type { Actor } from "../services/types.js";

/**
 * Server-side authorization for every route.
 *
 * Two layers, and both matter:
 *
 *  1. `requireAuth` resolves the bearer token into an `Actor` and rejects the
 *     request outright when there is none. Nothing else in the app is allowed to
 *     read the token.
 *  2. `requirePermission(...)` names the permissions a route needs. It is
 *     applied as a per-route `preHandler` so that Fastify's own router performs
 *     the check before the handler runs.
 *
 * The renderer also hides buttons a user cannot use, but that is presentation
 * only. If a user hand-crafts a request, the check below is what stops them.
 */

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(" ");
  if (!token || scheme?.toLowerCase() !== "bearer") {
    return undefined;
  }
  return token.trim() || undefined;
}

/** Resolves and attaches the caller. Must run before any permission check. */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = bearerToken(request);
  if (!token) {
    throw new DomainError("UNAUTHENTICATED", "A bearer token is required.", 401);
  }

  const actor = await resolveSession(token);
  if (!actor) {
    throw new DomainError("UNAUTHENTICATED", "Your session has expired. Please sign in again.", 401);
  }

  request.actor = {
    ...actor,
    ipAddress: request.ip ?? null,
    requestId: request.id ?? null
  };
}

/**
 * Rejects the request unless the caller holds *every* listed permission.
 *
 * Used as `preHandler: [requireAuth, requirePermission("billing.generate")]`.
 */
export function requirePermission(...required: Permission[]) {
  return async function permissionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const actor = request.actor;
    if (!actor) {
      // Defensive: requireAuth should already have run, but a route wired with
      // only this guard must still fail closed rather than as an unauthenticated
      // 500.
      throw new DomainError("UNAUTHENTICATED", "A bearer token is required.", 401);
    }
    const missing = required.filter((permission) => !actor.permissions.includes(permission));
    if (missing.length > 0) {
      reply.header("WWW-Authenticate", "Bearer error=\"insufficient_scope\"");
      throw new DomainError(
        "FORBIDDEN",
        `This action requires the following permission(s): ${missing.join(", ")}.`,
        403
      );
    }
  };
}

/** Shorthand for the common case: authenticate and require one permission. */
export function authorize(...required: Permission[]) {
  return [requireAuth, requirePermission(...required)];
}

/**
 * Requires **at least one** of the listed permissions.
 *
 * `requirePermission` is an AND, which is right when a route has one job. Some
 * routes have two genuinely different callers doing the same job - the cashier
 * posting a GCash payment and the office staff member who first records the
 * claim from the Facebook Page both need to attach the proof screenshot, but
 * neither holds the other's permissions. Forcing them into a single synthetic
 * permission, or into an AND, would either widen access or block a legitimate
 * user, so those routes name both and accept either.
 */
export function authorizeAny(...accepted: Permission[]) {
  return [
    requireAuth,
    async function anyPermissionGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const actor = request.actor;
      if (!actor) {
        throw new DomainError("UNAUTHENTICATED", "A bearer token is required.", 401);
      }
      if (accepted.some((permission) => actor.permissions.includes(permission))) {
        return;
      }
      reply.header("WWW-Authenticate", "Bearer error=\"insufficient_scope\"");
      throw new DomainError(
        "FORBIDDEN",
        `This action requires one of the following permission(s): ${accepted.join(", ")}.`,
        403
      );
    }
  ];
}

/**
 * The authenticated actor.
 *
 * Throws rather than returning `undefined` because it is only ever called inside
 * a handler that already ran `requireAuth`; if it is missing there, the route is
 * miswired and failing loudly is better than billing somebody anonymously.
 */
export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) {
    throw new DomainError("UNAUTHENTICATED", "This endpoint requires authentication.", 401);
  }
  return request.actor;
}
