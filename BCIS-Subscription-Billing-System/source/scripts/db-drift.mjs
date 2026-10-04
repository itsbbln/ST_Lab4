/**
 * Fails when a schema file was edited without regenerating the migration.
 *
 * Run:  npm run db:check-drift
 *
 * The laboratory specification requires every schema change to reach the
 * database through a migration. `drizzle-kit generate` is what produces that
 * migration from the TypeScript schema, so the way to detect "someone changed
 * the schema and forgot the migration" is to generate one and compare it with
 * what is committed.
 *
 * This is deliberately not a text comparison against the live database. Drizzle
 * regenerates a full `0000` file with a fresh journal hash on every run, so the
 * two are never byte-equal; the comparison below ignores the journal hash and
 * the generated filename.
 *
 * An earlier attempt parsed the schema with regular expressions and compared
 * nullability against `information_schema`. It reported dozens of false
 * positives because the parser could not find table or column boundaries, and
 * it wrongly reported a column as nullable when its `.notNull()` was simply on
 * the next line. Comparing generated SQL to committed SQL has no such blind
 * spot, which is why this replaces it.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// Resolve from this file, not process.cwd(): npm runs a workspace script with
// the workspace directory as the cwd, so paths relative to it break the moment
// the command is run from anywhere else.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const committedDir = resolve(sourceRoot, "..", "database", "migrations");

const committed = readdirSync(committedDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(committedDir, f), "utf8"))
  .join("\n");

/** Drops the journal hash, which changes on every generation. */
function normalise(sql) {
  return sql
    .replace(/^.*statement-breakpoint.*$/gm, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

const scratch = mkdtempSync(join(tmpdir(), "bcis-drift-"));
const configPath = join(sourceRoot, "drizzle.drift.config.ts");

try {
  // The config has to live inside the workspace or drizzle-kit cannot resolve
  // its own modules from it.
  writeFileSync(
    configPath,
    `import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./apps/api/src/db/schema/index.ts",
  out: ${JSON.stringify(scratch.replace(/\\/g, "/"))},
  casing: "snake_case",
  strict: true,
  verbose: false
});
`
  );

  // Invoke drizzle-kit's JS entry through the current Node binary rather than
  // the `drizzle-kit.cmd` shim: spawning a .cmd from Node on Windows needs a
  // shell, and a shell would re-quote the config path.
  const kit = join(sourceRoot, "node_modules", "drizzle-kit", "bin.cjs");
  execFileSync(process.execPath, [kit, "generate", `--config=${configPath}`, "--name=drift_check"], {
    cwd: sourceRoot,
    stdio: "pipe"
  });

  const generated = readdirSync(scratch)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(scratch, f), "utf8"))
    .join("\n");

  if (normalise(generated) === normalise(committed)) {
    console.log("No drift: the schema and database/migrations agree.");
    process.exit(0);
  }

  const generatedLines = new Set(normalise(generated).split("\n"));
  const committedLines = new Set(normalise(committed).split("\n"));
  const onlyInSchema = [...generatedLines].filter((line) => !committedLines.has(line));
  const onlyInMigration = [...committedLines].filter((line) => !generatedLines.has(line));

  console.error("The schema and database/migrations have drifted.\n");
  if (onlyInSchema.length > 0) {
    console.error("In the schema but not in the migration (run `npm run db:generate`):");
    for (const line of onlyInSchema) console.error(`  + ${line}`);
  }
  if (onlyInMigration.length > 0) {
    console.error("\nIn the migration but not in the schema (the schema was rolled back):");
    for (const line of onlyInMigration) console.error(`  - ${line}`);
  }
  process.exit(1);
} finally {
  rmSync(configPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
}
