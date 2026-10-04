import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

/**
 * Loads `.env` from a predictable place.
 *
 * `dotenv` resolves its default path against `process.cwd()`, which is wrong
 * for this repository: npm runs workspace scripts with the cwd set to
 * `source/apps/api`, while the `.env` file lives in `source/`. The result is a
 * silent "injected env (0)" and a missing `DATABASE_URL`, so the environment is
 * located by walking up from this module instead of trusting the cwd.
 *
 * Real environment variables always win: the file only fills in what is absent,
 * so a container or CI job that injects configuration is not silently overridden
 * by a developer's local file.
 */

let loaded = false;

function moduleDir(): string {
  // `src/config/env.ts` -> `src/config` -> `src` -> `apps/api`
  return dirname(fileURLToPath(import.meta.url));
}

/** First `.env` found walking up from the API package to the filesystem root. */
export function findEnvFile(): string | undefined {
  if (process.env.DOTENV_CONFIG_PATH) {
    return existsSync(process.env.DOTENV_CONFIG_PATH)
      ? resolve(process.env.DOTENV_CONFIG_PATH)
      : undefined;
  }

  let directory = moduleDir();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return undefined;
}

export function loadEnvironment(): string | undefined {
  if (loaded) {
    return findEnvFile();
  }
  const file = findEnvFile();
  if (file) {
    // `override: false` keeps any real environment variable in place.
    loadEnv({ path: file, override: false, quiet: true });
  }
  loaded = true;
  return file;
}
