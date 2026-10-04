import { and, eq, inArray, ne, sql } from "drizzle-orm";

import { getDatabase, type Executor } from "../db/client.js";
import { roles, sessions, userRoles, users } from "../db/schema/index.js";
import { roleCodes, type RoleCode } from "@bcis/shared";
import { assignRoles, revokeAllSessions } from "./auth.js";
import { auditActions, writeAudit } from "./audit.js";
import { businessRule, notFound, validationFailed } from "./errors.js";
import type { Actor } from "./types.js";

/**
 * Updating and deactivating users (§3.2, §4.4).
 *
 * The specification requires that user management is audited and that only
 * authorised staff can do it. What it does not spell out is the failure mode that
 * actually bites in a three-office deployment: an administrator deactivates the
 * wrong account, or removes their own last role, and the office has no way back in
 * because the only account with `user.manage` is now locked out. Three rules
 * exist here for that reason, and each is a real query rather than a comment:
 *
 *  1. **The last active OWNER cannot be deactivated or demoted.** If that were
 *     possible the system would have no account that can restore a backup, manage
 *     users, or change settings - a permanent lockout with no recovery short of
 *     direct database surgery.
 *  2. **An administrator cannot deactivate their own account.** Locking yourself
 *     out mid-session is almost always a mistake, and the next owner can do it
 *     deliberately.
 *  3. **Any change to roles or active state revokes that user's sessions
 *     immediately.** Otherwise a demoted cashier keeps working until their token
 *     expires, which defeats the point of demoting them.
 *
 * Roles are replaced rather than merged, so the resulting state is exactly what
 * the request described and there is no way to accumulate roles by omission.
 */

export interface UpdateUserInput {
  displayName?: string;
  email?: string | null;
  isActive?: boolean;
  roleCodes?: string[];
}

export interface UserUpdateResult {
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    isActive: boolean;
    roleCodes: string[];
  };
  /** Sessions killed as a result of this change. */
  sessionsRevoked: number;
  changed: string[];
}

export async function updateUser(
  userId: string,
  input: UpdateUserInput,
  actor?: Actor
): Promise<UserUpdateResult> {
  const { db } = getDatabase();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        isActive: users.isActive,
        roleCodes: sql<string[]>`coalesce(array_agg(${roles.code}) filter (where ${roles.code} is not null), '{}')`
      })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(users.id, userId))
      .groupBy(users.id);

    if (!existing) {
      throw notFound("User", userId);
    }

    const changed: string[] = [];
    const patch: Partial<typeof users.$inferInsert> = {};

    if (input.displayName !== undefined && input.displayName !== existing.displayName) {
      patch.displayName = input.displayName;
      changed.push("displayName");
    }
    if (input.email !== undefined && input.email !== existing.email) {
      patch.email = input.email;
      changed.push("email");
    }
    if (input.isActive !== undefined && input.isActive !== existing.isActive) {
      patch.isActive = input.isActive;
      changed.push("isActive");
    }

    // --- Resolve the role change before writing anything --------------------
    //
    // The lockout guards below have to compare the *resulting* role set against
    // the current OWNER count, so the target roles are validated first and the
    // whole update is refused before any row is touched.
    const nextRoles = input.roleCodes ? normaliseRoleCodes(input.roleCodes) : null;
    const losesOwner = existing.roleCodes.includes("OWNER") && nextRoles !== null && !nextRoles.includes("OWNER");
    const isBeingDeactivated = input.isActive === false && existing.isActive;

    if (isBeingDeactivated && actor?.id === userId) {
      throw businessRule("You cannot deactivate your own account.");
    }

    if (losesOwner || (isBeingDeactivated && existing.roleCodes.includes("OWNER"))) {
      const otherOwners = await countOtherActiveOwners(tx, userId);
      if (otherOwners === 0) {
        throw businessRule(
          isBeingDeactivated
            ? `${existing.username} is the last active OWNER. Appoint another owner before deactivating this account.`
            : `${existing.username} is the last active OWNER. Assign the OWNER role to another user before removing it.`
        );
      }
    }

    if (changed.length === 0 && nextRoles === null) {
      throw validationFailed("The request did not change anything.");
    }

    if (Object.keys(patch).length > 0) {
      await tx.update(users).set(patch).where(eq(users.id, userId));
    }

    if (nextRoles) {
      const sortedNow = [...existing.roleCodes].sort();
      const sortedNext = [...nextRoles].sort();
      if (JSON.stringify(sortedNow) !== JSON.stringify(sortedNext)) {
        changed.push("roleCodes");
        await assignRoles(tx, userId, nextRoles as RoleCode[], actor);
      }
    }

    // A demotion or a deactivation has to take effect now, not at token expiry.
    let sessionsRevoked = 0;
    if (changed.includes("roleCodes") || isBeingDeactivated) {
      sessionsRevoked = await revokeAllSessions(tx, userId);
    }

    if (changed.length > 0) {
      await writeAudit(tx, actor, {
        action: auditActions.USER_UPDATED,
        entityType: "user",
        entityId: userId,
        changes: Object.fromEntries(
          changed.map((field) => [field, { old: (existing as Record<string, unknown>)[field], new: patch[field as keyof typeof patch] ?? nextRoles }])
        ),
        metadata: { changed, sessionsRevoked, username: existing.username }
      });
    }

    const [row] = await tx
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        isActive: users.isActive,
        roleCodes: sql<string[]>`coalesce(array_agg(${roles.code}) filter (where ${roles.code} is not null), '{}')`
      })
      .from(users)
      .leftJoin(userRoles, eq(userRoles.userId, users.id))
      .leftJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(users.id, userId))
      .groupBy(users.id);

    return {
      user: { ...row, roleCodes: [...row.roleCodes].sort() },
      sessionsRevoked,
      changed
    };
  });
}

/** Validates role codes against the catalogue and removes duplicates. */
function normaliseRoleCodes(requested: string[]): string[] {
  const unique = [...new Set(requested.map((code) => code.trim().toUpperCase()).filter(Boolean))];
  if (unique.length === 0) {
    throw validationFailed("A user must keep at least one role.");
  }
  const known = new Set<string>(roleCodes);
  const unknown = unique.filter((code) => !known.has(code));
  if (unknown.length > 0) {
    throw validationFailed(`Unknown role(s): ${unknown.join(", ")}.`);
  }
  return unique.sort();
}

/** Counts active OWNER accounts other than the one being changed. */
async function countOtherActiveOwners(executor: Executor, excludeUserId: string): Promise<number> {
  const [row] = await executor
    .select({ value: sql<number>`count(*)::int` })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(
      and(
        eq(roles.code, "OWNER"),
        eq(users.isActive, true),
        ne(users.id, excludeUserId)
      )
    );
  return Number(row?.value ?? 0);
}

/**
 * Sessions belonging to a user, for the "sign out everywhere" action.
 *
 * Separate from `revokeAllSessions` because the Administration screen needs to
 * show what it is about to do.
 */
export async function listUserSessions(executor: Executor, userId: string) {
  return executor
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      ipAddress: sessions.ipAddress,
      userAgent: sessions.userAgent
    })
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sql`${sessions.lastSeenAt} desc`);
}

/** Revokes every session for a user; used by the "sign out everywhere" button. */
export async function revokeUserSessions(userId: string, actor?: Actor): Promise<number> {
  const { db } = getDatabase();
  const revoked = await revokeAllSessions(db, userId);

  await writeAudit(db, actor, {
    action: auditActions.USER_UPDATED,
    entityType: "user",
    entityId: userId,
    reason: "Sessions revoked by an administrator.",
    metadata: { sessionsRevoked: revoked }
  });

  return revoked;
}

/** Users who currently hold a given role; guards bulk role changes. */
export async function usersWithRole(roleCode: string, executor: Executor) {
  return executor
    .select({ id: users.id, username: users.username, isActive: users.isActive })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(roles.code, roleCode), inArray(users.isActive, [true])));
}
