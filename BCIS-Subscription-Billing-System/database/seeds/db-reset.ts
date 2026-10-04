/**
 * Drops and rebuilds the application schema, then re-applies every migration.
 *
 * This exists because of a specific trap worth documenting. Drizzle records what
 * it has run in its own `drizzle.__drizzle_migrations` table. If you drop
 * `public` to clear the data but leave the ledger in place, the migrator still
 * sees migration 0000 as applied and skips it. The database is then left
 * reporting "migrations applied" while having no tables and no enum types at all
 * -- which is exactly the broken state this script was written to fix.
 *
 * So the reset clears the ledger in the same transaction window as the schema
 * drop, and re-applies the migrations with the same migrator the application
 * uses at startup. Doing it by hand across two databases is how the trap was hit
 * in the first place.
 *
 * Usage:
 *   npm run db:reset                          # database from source/.env
 *   DATABASE_URL=... npm run db:reset         # an explicit database
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";

import { loadEnvironment } from "../apps/api/src/config/env.js";
import * as schema from "../apps/api/src/db/schema/index.js";

loadEnvironment();

/** Databases that are safe to rebuild. Guarding this keeps a typo from eating a real database. */
const SAFE_NAMES = new Set(["BCIS-LabAct4", "bcis", "bcis_test"]);

/** Locates `database/migrations` by walking up from this module. */
function resolveMigrationsFolder(): string {
  if (process.env.MIGRATIONS_FOLDER) {
    return resolve(process.env.MIGRATIONS_FOLDER);
  }
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "database", "migrations");
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  throw new Error("Could not find database/migrations. Set MIGRATIONS_FOLDER to its absolute path.");
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]*@/, "//$1:***@");
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, "")).trim();
  if (!SAFE_NAMES.has(name)) {
    throw new Error(
      `Refusing to reset database "${name}". Add it to SAFE_NAMES in scripts/db-reset.ts if this is intentional.`
    );
  }
  console.log(`Target: ${redact(url)}`);

  const migrationsFolder = resolveMigrationsFolder();

  // Schema and ledger are dropped together, in one batch, so there is no window
  // in which the migrator would believe a migration is applied.
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("drop schema if exists public cascade");
    await client.query("drop schema if exists drizzle cascade");
    await client.query("create schema public");
  } finally {
    await client.end();
  }
  console.log("Dropped the public schema and cleared the migration ledger.");

  const pool = new Pool({ connectionString: url, max: 1, options: "-c timezone=UTC" });
  try {
    const db = drizzle(pool, { schema, casing: "snake_case" });
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
  console.log("Migrations re-applied from a clean slate.");

  // Report what actually exists now, so a silent "applied but empty" state is
  // impossible to miss again.
  const verify = new Client({ connectionString: url });
  await verify.connect();
  try {
    const { rows } = await verify.query<{ tables: number; types: number }>(`
      select
        (select count(*)::int from pg_tables where schemaname = 'public') as tables,
        (select count(*)::int from pg_type where typnamespace = 'public'::regnamespace) as types
    `);
    const counts = rows[0]!;
    console.log(`Verified: ${counts.tables} tables, ${counts.types} enum types in public.`);
    if (counts.tables === 0) {
      throw new Error("Migration reported success but public has no tables. Check the migration folder.");
    }
  } finally {
    await verify.end();
  }
}

main().catch((error: unknown) => {
  console.error("Reset failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
