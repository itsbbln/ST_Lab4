/**
 * Throttling budgets (§3.11).
 *
 * Kept in their own module because both `app.ts` (the global budget) and
 * `auth.routes.ts` (the tighter sign-in budget) need them, and importing either
 * from the other would create a cycle.
 *
 * The sign-in budget is deliberately much smaller than the global one: a
 * legitimate cashier signs in a handful of times a day, whereas password
 * guessing is unbounded. It is a coarse per-machine guard that sits in front of
 * the per-account lockout in `services/auth.ts`; neither replaces the other.
 */

/** Requests any single client may make per minute. */
export const GLOBAL_RATE_LIMIT = Number(process.env.API_RATE_LIMIT ?? 300);

/** Sign-in attempts any single client may make per minute. */
export const LOGIN_RATE_LIMIT = Number(process.env.LOGIN_RATE_LIMIT ?? 10);

export const RATE_LIMIT_WINDOW = "1 minute" as const;
