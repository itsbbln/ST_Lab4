import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import { loadEnvironment } from "../config/env.js";
import * as schema from "./schema/index.js";

/**
 * Applies every pending SQL migration to the database named by `DATABASE_URL`.
 *
 * Drizzle's migrator records what it has run in `__drizzle_migrations`, so this
 * is safe to run repeatedly: a second invocation is a no-op. That matters
 * because the acceptance tests and the demo seed both call it, and because a
 * half-applied migration would be far worse than a re-run.
 *
 * Usage:
 *   npm run db:migrate -w @bcis/api
 *   DATABASE_URL=postgresql://.../bcis_test npm run db:migrate -w @bcis/api
 */

const envFile = loadEnvironment();

/**
 * Locates `database/migrations` by walking up from this module.
 *
 * The folder sits at the submission root, above the npm workspace, so a
 * cwd-relative path would depend on which directory npm happened to launch the
 * script from. `MIGRATIONS_FOLDER` still wins for unusual layouts.
 */
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
  throw new Error(
    "Could not find database/migrations. Set MIGRATIONS_FOLDER to its absolute path."
  );
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }
  const migrationsFolder = resolveMigrationsFolder();

  const pool = new Pool({ connectionString: url, max: 1, options: "-c timezone=UTC" });
  try {
    const db = drizzle(pool, { schema, casing: "snake_case" });
    console.log(`Target: ${redact(url)}`);
    console.log(`Env:    ${envFile ?? "(none; using process environment)"}`);
    console.log(`Applying migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

/** Hides the password so the URL can safely appear in console output. */
function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]*@/, "//$1:***@");
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
