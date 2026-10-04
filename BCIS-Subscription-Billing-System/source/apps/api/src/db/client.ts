import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SQLWrapper } from "drizzle-orm/sql";
import pg from "pg";
import { Pool, type PoolConfig } from "pg";

import { loadEnvironment } from "../config/env.js";
import * as schema from "./schema/index.js";

loadEnvironment();

export type Database = NodePgDatabase<typeof schema>;

/**
 * The handle Drizzle passes to a `db.transaction()` callback. Services are
 * written against this type so that a function can run either inside or outside
 * an explicit transaction without changing its signature.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Read-only handle. Drizzle uses the same query builder for transactions. */
export type Executor = Database | Transaction;

export const DEFAULT_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/bcis";

/**
 * Money in this system is an integer number of centavos. `pg` returns `bigint`
 * columns as strings by default, but every monetary column in the schema is
 * declared with `mode: "number"`, so the driver must hand back `number` for
 * `int8` instead of silently stringifying it.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() || DEFAULT_DATABASE_URL;
}

export function poolConfig(): PoolConfig {
  return {
    connectionString: databaseUrl(),
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // Three office PCs share this API, so a stuck query must not hold a
    // connection open forever.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Money is exact integer centavos, but timestamps must be unambiguous
    // across the LAN rather than depending on the server's local zone.
    options: "-c timezone=UTC"
  };
}

export function createPool(): Pool {
  return new Pool(poolConfig());
}

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema, casing: "snake_case" });
}

/**
 * A database plus the pool that backs it, so callers can close both.
 */
export interface DatabaseHandle {
  db: Database;
  pool: Pool;
  close: () => Promise<void>;
}

export function connect(overrides: Partial<PoolConfig> = {}): DatabaseHandle {
  const pool = new Pool({ ...poolConfig(), ...overrides });
  const db = createDatabase(pool);
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
    }
  };
}

let shared: DatabaseHandle | undefined;

/**
 * Process-wide handle used by the API server. Created lazily so that importing
 * the database module does not open a connection, which keeps unit tests that
 * never touch the database cheap.
 */
export function getDatabase(): DatabaseHandle {
  shared ??= connect();
  return shared;
}

export async function closeDatabase(): Promise<void> {
  if (shared) {
    await shared.close();
    shared = undefined;
  }
}

/**
 * Runs `work` inside a database transaction, rolling back on any thrown error.
 *
 * Every multi-step financial posting (billing generation, payment allocation,
 * reversal, remittance) must run through this helper so that a failure part-way
 * through cannot leave a half-posted invoice or an unbalanced ledger behind
 * (§2.3).
 */
export async function inTransaction<T>(
  work: (tx: Transaction) => Promise<T>,
  options: { isolation?: "read committed" | "repeatable read" | "serializable" } = {}
): Promise<T> {
  const { db } = getDatabase();
  return db.transaction(work, options.isolation ? { isolationLevel: options.isolation } : undefined);
}

/** Cheap liveness probe used by `/health` and by the migration scripts. */
export async function ping(): Promise<boolean> {
  const { pool } = getDatabase();
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a raw SQL query and returns its rows.
 *
 * `executor.execute()` does **not** return an array. Against node-postgres it
 * resolves to the driver's own `Result`, so the rows are on `.rows`. Code that
 * treats the return value as the rows gets `undefined` from indexing `[0]` and
 * then fails somewhere far away from the query that caused it.
 *
 * Every raw `sql` fragment in the services goes through here, which also means
 * the row type is stated once at the call site instead of being forced through
 * a double cast.
 */
export async function queryRows<T = Record<string, unknown>>(
  executor: Executor,
  query: SQLWrapper
): Promise<T[]> {
  const result = await executor.execute(query);
  return result.rows as T[];
}

/** Runs a raw query expected to match at most one row, or `undefined`. */
export async function queryRow<T = Record<string, unknown>>(
  executor: Executor,
  query: SQLWrapper
): Promise<T | undefined> {
  const rows = await queryRows<T>(executor, query);
  return rows[0];
}
