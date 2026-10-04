import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env" });

/**
 * Drizzle Kit configuration.
 *
 * The laboratory specification requires that every schema change is applied
 * through a migration (§2.3) and that migrations live in `database/migrations/`
 * at the submission root (§9.1), so the generated SQL is written there rather
 * than inside the API workspace.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/api/src/db/schema/index.ts",
  out: "../database/migrations",
  casing: "snake_case",
  strict: true,
  verbose: true
});
