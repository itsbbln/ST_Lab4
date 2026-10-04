import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { type Permission, permissionsForRole, roleCodes, type RoleCode } from "@bcis/shared";

import { getDatabase, inTransaction, type Executor } from "../db/client.js";
import {
  permissionsTable,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users
} from "../db/schema/index.js";
import { auditActions, writeAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import type { Actor } from "./types.js";

const scryptAsync = promisify(scrypt);

/**
 * Authentication and session management (§4.4).
 *
 * Passwords use scrypt with a **per-user random salt** and are stored as
 * `salt:hash`. Verification is constant-time. Failed logins increment a counter
 * and lock the account for a configurable window once the threshold is passed,
 * which gives the "sensible failed-login handling" the guide asks for.
 *
 * Sessions live in the database with an explicit `expires_at`, so a token issued
 * before an application restart keeps working and a token past its expiry is
 * rejected even if the process never had a chance to clean it up.
 */

const HASH_KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const useSalt = salt ?? randomBytes(SALT_BYTES).toString("hex");
  const derived = (await scryptAsync(password, useSalt, HASH_KEY_LENGTH)) as Buffer;
  return { hash: derived.toString("hex"), salt: useSalt };
}

export async function verifyPassword(password: string, passwordHash: string, passwordSalt: string): Promise<boolean> {
  const { hash } = await hashPassword(password, passwordSalt);
  const expected = Buffer.from(passwordHash, "hex");
  const actual = Buffer.from(hash, "hex");
  if (expected.length !== actual.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

function sessionTtlMinutes(): number {
  const parsed = Number(process.env.SESSION_TTL_MINUTES ?? 120);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
}

function loginPolicy() {
  const maxAttempts = readPositiveInt(process.env.LOGIN_MAX_ATTEMPTS, 5);
  const lockoutMinutes = readPositiveInt(process.env.LOGIN_LOCKOUT_MINUTES, 15);
  return { maxAttempts, lockoutMinutes };
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    mustChangePassword: boolean;
    roles: RoleCode[];
    permissions: Permission[];
  };
}

/**
 * Resolves a user's effective permissions by joining `user_roles` ->
 * `role_permissions` -> `permissions`. Authorization is therefore entirely
 * data-driven; the TypeScript matrix in `@bcis/shared` is only the seed.
 */
export async function loadPermissionsForUser(
  executor: Executor,
  userId: string
): Promise<{ roles: RoleCode[]; permissions: Permission[] }> {
  const rows = await executor
    .selectDistinct({ code: roles.code, permission: permissionsTable.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissionsTable, eq(rolePermissions.permissionId, permissionsTable.id))
    .where(eq(userRoles.userId, userId));

  const userRoleRows = await executor
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));

  return {
    roles: userRoleRows.map((row) => row.code as RoleCode),
    permissions: [...new Set(rows.map((row) => row.permission as Permission))]
  };
}

export async function login(
  username: string,
  password: string,
  context: { ipAddress?: string | null; userAgent?: string | null } = {}
): Promise<LoginResult> {
  const { db } = getDatabase();
  const { maxAttempts, lockoutMinutes } = loginPolicy();
  const now = new Date();

  const found = await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = lower(${username})`)
    .limit(1);
  const user = found[0];

  // Uniform failure handling: a missing user and a wrong password produce the
  // same message and both cost a comparable amount of work.
  if (!user) {
    await writeAudit(db, undefined, {
      action: auditActions.LOGIN_FAILED,
      entityType: "user",
      entityId: username,
      reason: "Unknown username"
    });
    throw new DomainError("UNAUTHENTICATED", "Invalid username or password.", 401);
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    const minutes = Math.max(1, Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000));
    throw new DomainError(
      "UNAUTHENTICATED",
      `This account is temporarily locked after repeated failed sign-in attempts. Try again in ${minutes} minute(s).`,
      423
    );
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash, user.passwordSalt);

  if (!passwordMatches) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= maxAttempts;
    const lockUntil = shouldLock
      ? new Date(now.getTime() + lockoutMinutes * 60_000)
      : null;

    await db
      .update(users)
      .set({
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: lockUntil,
        lastFailedLoginAt: now,
        updatedAt: now
      })
      .where(eq(users.id, user.id));

    await writeAudit(db, undefined, {
      action: auditActions.LOGIN_FAILED,
      entityType: "user",
      entityId: user.id,
      reason: shouldLock ? `Locked after ${attempts} failed attempts` : `Attempt ${attempts} of ${maxAttempts}`,
      metadata: { username: user.username, locked: shouldLock }
    });

    throw new DomainError(
      "UNAUTHENTICATED",
      shouldLock
        ? `Too many failed attempts. This account is locked for ${lockoutMinutes} minutes.`
        : "Invalid username or password.",
      401
    );
  }

  if (!user.isActive) {
    throw new DomainError(
      "FORBIDDEN",
      "This account has been deactivated. Contact an administrator.",
      403
    );
  }

  const { roles: roleList, permissions } = await loadPermissionsForUser(db, user.id);
  const token = randomUUID();
  const expiresAt = new Date(now.getTime() + sessionTtlMinutes() * 60_000);

  await inTransaction(async (tx) => {
    await tx.insert(sessions).values({
      token,
      userId: user.id,
      expiresAt,
      ipAddress: context.ipAddress ?? null,
      userAgent: context.userAgent ?? null
    });
    await tx
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
        lastFailedLoginAt: null,
        updatedAt: now
      })
      .where(eq(users.id, user.id));
    await writeAudit(
      tx,
      {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        permissions,
        ipAddress: context.ipAddress ?? null
      },
      { action: auditActions.LOGIN_SUCCEEDED, entityType: "user", entityId: user.id }
    );
  });

  return {
    token,
    expiresAt,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
      roles: roleList,
      permissions
    }
  };
}

export async function logout(token: string, actor?: Actor): Promise<void> {
  const { db } = getDatabase();
  const existing = await db.select().from(sessions).where(eq(sessions.token, token)).limit(1);
  if (existing[0]) {
    await db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.token, token));
  }
  await writeAudit(db, actor, {
    action: auditActions.LOGOUT,
    entityType: "user",
    entityId: actor?.id ?? existing[0]?.userId
  });
}

/** Invalidates every live session for a user, e.g. after a role change. */
/**
 * Marks every live session for a user as revoked and reports how many.
 *
 * The count is returned because callers that change a user's roles or deactivate
 * them record "sessions revoked" in the audit trail, and a number that is not
 * measured is a number that is guessed.
 */
export async function revokeAllSessions(executor: Executor, userId: string): Promise<number> {
  const revoked = await executor
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), sql`${sessions.revokedAt} IS NULL`))
    .returning({ id: sessions.id });
  return revoked.length;
}

/**
 * Resolves a bearer token into an `Actor`. Returns `undefined` for unknown,
 * expired, revoked or inactive tokens rather than throwing, so the auth
 * preHandler stays a single branch and unauthenticated requests simply fail the
 * route's permission check.
 */
export async function resolveSession(token: string): Promise<Actor | undefined> {
  const { db } = getDatabase();
  const rows = await db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      revokedAt: sessions.revokedAt,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      isActive: users.isActive
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.token, token))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt || !row.isActive || row.expiresAt <= new Date()) {
    return undefined;
  }

  const { permissions } = await loadPermissionsForUser(db, row.userId);

  // Touch the session occasionally rather than on every request, so a busy
  // cashier workstation does not generate a write per keystroke-driven fetch.
  await db
    .update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(and(eq(sessions.id, row.sessionId), lt(sessions.lastSeenAt, new Date(Date.now() - 60_000))));

  return {
    id: row.userId,
    username: row.username,
    displayName: row.displayName,
    permissions
  };
}

export async function listSessions(userId: string) {
  const { db } = getDatabase();
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sql`${sessions.createdAt} DESC`);
}

/** Housekeeping: drop sessions that expired more than a day ago. */
export async function pruneExpiredSessions(): Promise<number> {
  const { db } = getDatabase();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(sessions)
    .where(and(lt(sessions.expiresAt, cutoff), sql`${sessions.revokedAt} IS NOT NULL`))
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function changePassword(
  executor: Executor,
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const found = await executor.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = found[0];
  if (!user) {
    throw new DomainError("NOT_FOUND", "User was not found.", 404);
  }
  if (!(await verifyPassword(currentPassword, user.passwordHash, user.passwordSalt))) {
    throw new DomainError("UNAUTHENTICATED", "Your current password is incorrect.", 401);
  }
  const { hash, salt } = await hashPassword(newPassword);
  await executor
    .update(users)
    .set({
      passwordHash: hash,
      passwordSalt: salt,
      passwordChangedAt: new Date(),
      mustChangePassword: false,
      updatedAt: new Date()
    })
    .where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// User administration
// ---------------------------------------------------------------------------

export async function createUser(
  executor: Executor,
  input: {
    username: string;
    displayName: string;
    email?: string | null;
    password: string;
    roleCodes: string[];
    isActive: boolean;
  },
  actor?: Actor
) {
  const requested = input.roleCodes.filter((code): code is RoleCode =>
    (roleCodes as readonly string[]).includes(code)
  );
  if (requested.length !== input.roleCodes.length) {
    const unknown = input.roleCodes.filter((code) => !requested.includes(code as RoleCode));
    throw new DomainError("VALIDATION_FAILED", `Unknown role(s): ${unknown.join(", ")}.`, 400);
  }

  const { hash, salt } = await hashPassword(input.password);
  const [user] = await executor
    .insert(users)
    .values({
      username: input.username,
      displayName: input.displayName,
      email: input.email ?? null,
      passwordHash: hash,
      passwordSalt: salt,
      isActive: input.isActive
    })
    .returning();

  await assignRoles(executor, user.id, requested, actor);
  await writeAudit(executor, actor, {
    action: auditActions.USER_CREATED,
    entityType: "user",
    entityId: user.id,
    changes: {
      username: { new: input.username },
      displayName: { new: input.displayName },
      isActive: { new: input.isActive },
      roles: { new: requested }
    }
  });
  return user;
}

export async function assignRoles(
  executor: Executor,
  userId: string,
  roleCodeList: RoleCode[],
  actor?: Actor
): Promise<void> {
  const roleRows = await executor
    .select({ id: roles.id, code: roles.code })
    .from(roles)
    .where(inArray(roles.code, roleCodeList as string[]));
  if (roleRows.length !== roleCodeList.length) {
    const found = new Set(roleRows.map((row) => row.code));
    throw new DomainError(
      "VALIDATION_FAILED",
      `Unknown role(s): ${roleCodeList.filter((code) => !found.has(code)).join(", ")}.`,
      400
    );
  }
  await executor.delete(userRoles).where(eq(userRoles.userId, userId));
  await executor.insert(userRoles).values(
    roleRows.map((row) => ({ userId, roleId: row.id, assignedBy: actor?.id ?? null }))
  );
}

export async function listUsers(executor: Executor) {
  const rows = await executor
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      isActive: users.isActive,
      lockedUntil: users.lockedUntil,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      roleCodes: sql<string[]>`coalesce(array_agg(${roles.code}) filter (where ${roles.code} is not null), '{}')`
    })
    .from(users)
    .leftJoin(userRoles, eq(userRoles.userId, users.id))
    .leftJoin(roles, eq(userRoles.roleId, roles.id))
    .groupBy(users.id)
    .orderBy(users.username);

  return rows.map((row) => ({
    ...row,
    isLocked: Boolean(row.lockedUntil && row.lockedUntil > new Date())
  }));
}

export async function listRoleMatrix(executor: Executor) {
  const rows = await executor
    .select({ roleCode: roles.code, roleName: roles.name, permission: permissionsTable.code })
    .from(roles)
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissionsTable, eq(rolePermissions.permissionId, permissionsTable.id))
    .orderBy(roles.code, permissionsTable.code);

  const matrix = new Map<string, { roleCode: string; roleName: string; permissions: string[] }>();
  for (const row of rows) {
    const entry = matrix.get(row.roleCode) ?? {
      roleCode: row.roleCode,
      roleName: row.roleName,
      permissions: []
    };
    if (row.permission) {
      entry.permissions.push(row.permission);
    }
    matrix.set(row.roleCode, entry);
  }
  return [...matrix.values()];
}

/** Seeds `roles`, `permissions` and `role_permissions` from the shared matrix. */
export async function seedSecurityCatalog(executor: Executor): Promise<void> {
  const allPermissions = [...new Set(roleCodes.flatMap((code) => permissionsForRole(code)))];

  const permissionRows = allPermissions.map((code) => ({ code }));
  await executor
    .insert(permissionsTable)
    .values(permissionRows)
    .onConflictDoNothing({ target: permissionsTable.code });

  const roleRows = roleCodes.map((code) => ({
    code,
    name: code
      .split("_")
      .map((part) => part.charAt(0) + part.slice(1).toLowerCase())
      .join(" "),
    isSystem: true
  }));
  await executor
    .insert(roles)
    .values(roleRows)
    .onConflictDoNothing({ target: roles.code });

  const permissionIdRows = await executor
    .select({ id: permissionsTable.id, code: permissionsTable.code })
    .from(permissionsTable)
    .where(inArray(permissionsTable.code, allPermissions));
  const permissionIdByCode = new Map(permissionIdRows.map((row) => [row.code, row.id]));

  const storedRoles = await executor.select().from(roles);
  const roleIdByCode = new Map(storedRoles.map((row) => [row.code, row.id]));

  const grants = roleCodes.flatMap((code) =>
    permissionsForRole(code)
      .map((permission) => ({
        roleId: roleIdByCode.get(code)!,
        permissionId: permissionIdByCode.get(permission)!
      }))
      .filter((grant) => grant.roleId !== undefined && grant.permissionId !== undefined)
  );

  await executor.insert(rolePermissions).values(grants).onConflictDoNothing();
}

export async function activeSessionCount(executor: Executor): Promise<number> {
  const rows = await executor
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(sql`${sessions.revokedAt} IS NULL`, gt(sessions.expiresAt, new Date())));
  return rows.length;
}
