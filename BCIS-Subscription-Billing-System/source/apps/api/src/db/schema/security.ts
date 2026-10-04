import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

import {
  permissions,
  permissionDescriptions,
  roleCodes,
  roleDescriptions,
  rolePermissions as rolePermissionMatrix
} from "@bcis/shared";

/**
 * Security subsystem.
 *
 * The laboratory guide requires the concepts `users`, `roles`, `permissions`,
 * `role_permissions` and `user_roles` to exist as real, queryable relations so
 * that authorization is data-driven and auditable rather than hard-coded.
 */
export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isSystem: boolean("is_system").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("roles_code_unique").on(table.code)]
);

export const permissionsTable = pgTable(
  "permissions",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    code: text("code").notNull(),
    description: text("description").notNull().default("")
  },
  (table) => [uniqueIndex("permissions_code_unique").on(table.code)]
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: integer("permission_id")
      .notNull()
      .references(() => permissionsTable.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionId] })]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    lastFailedLoginAt: timestamp("last_failed_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("users_username_unique").on(sql`lower(${table.username})`),
    index("users_display_name_idx").on(table.displayName)
  ]
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" })
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    token: text("token").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent")
  },
  (table) => [
    uniqueIndex("sessions_token_unique").on(table.token),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expiry_idx").on(table.expiresAt)
  ]
);

export const rolesRelations = relations(roles, ({ many }) => ({
  rolePermissions: many(rolePermissions),
  userRoles: many(userRoles)
}));

export const permissionsRelations = relations(permissionsTable, ({ many }) => ({
  rolePermissions: many(rolePermissions)
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissionsTable, {
    fields: [rolePermissions.permissionId],
    references: [permissionsTable.id]
  })
}));

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
  sessions: many(sessions)
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] })
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] })
}));

/** Reference matrix used by the seeder and by the documentation generator. */
export const securityReference = {
  permissions: permissions.map((code) => ({
    code,
    description: permissionDescriptions[code]
  })),
  roles: roleCodes.map((code) => ({
    code,
    description: roleDescriptions[code],
    permissions: rolePermissionMatrix[code]
  }))
};
