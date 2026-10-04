import { z } from "zod";

import { validationFailed } from "../services/errors.js";

/**
 * Request validation shared by every route module.
 *
 * Zod issues are converted into the standard error envelope with a dotted path
 * for each one, so the renderer can highlight the offending field instead of
 * showing "validation failed". Keeping this in one place also means a route can
 * never accidentally reply with a raw Zod error.
 */
export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  message: string
): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed(message, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    });
  }
  return parsed.data;
}
