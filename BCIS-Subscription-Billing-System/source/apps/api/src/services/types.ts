import type { Permission } from "@bcis/shared";

/**
 * The authenticated caller, as resolved by the API's auth preHandler and passed
 * down into the service layer. Services never read `request` directly; they take
 * an `Actor` so that the same code path is used by HTTP requests, by the seeder
 * and by the acceptance tests.
 */
export interface Actor {
  id: string;
  username: string;
  displayName: string;
  permissions: readonly Permission[];
  ipAddress?: string | null;
  requestId?: string | null;
}

/** An actor for automated work: migrations, seeds, scheduled jobs. */
export const systemActor: Actor = {
  id: "00000000-0000-0000-0000-000000000000",
  username: "system",
  displayName: "System",
  permissions: []
};

export function actorCan(actor: Actor | undefined, permission: Permission): boolean {
  return actor?.permissions.includes(permission) ?? false;
}

/** Throws unless the actor holds every listed permission. */
export function assertCan(actor: Actor | undefined, ...required: Permission[]): Actor {
  if (!actor) {
    throw new Error("An authenticated actor is required.");
  }
  const missing = required.filter((permission) => !actor.permissions.includes(permission));
  if (missing.length > 0) {
    // Surfaced as a 403 by the error handler; the check lives here so that the
    // services are self-defending even if a route forgets its preHandler.
    const error = new Error(`Missing permission: ${missing.join(", ")}`) as Error & { statusCode: number };
    error.statusCode = 403;
    error.name = "ForbiddenError";
    throw error;
  }
  return actor;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
