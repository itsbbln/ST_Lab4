import { defineConfig } from "vitest/config";

/**
 * `npm test` runs the unit suites only.
 *
 * The integration suite talks to a real PostgreSQL database, so it is excluded
 * from the default run and invoked deliberately via `npm run test:integration`.
 * Keeping it out of `test` means a plain `npm test` on a fresh checkout needs no
 * database, while the financial end-to-end checks stay one command away.
 *
 * The switch is the `BCIS_INTEGRATION=1` environment variable that
 * `test:integration` sets, rather than a second config file, so the two modes
 * cannot drift apart.
 *
 * The integration file additionally refuses to run against any database whose
 * name does not end in `_test`. This config is the first line of defence;
 * that check is the second.
 */
const integration = process.env.BCIS_INTEGRATION === "1";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: integration ? ["node_modules/**"] : ["tests/integration.*.test.ts", "node_modules/**"]
  }
});
