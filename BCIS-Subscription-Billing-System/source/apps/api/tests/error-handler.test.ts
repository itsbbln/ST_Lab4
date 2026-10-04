import { describe, expect, it } from "vitest";

import { errorHandler } from "../src/http/error-handler.js";

/**
 * Regressions found by `npm run smoke` against a real seeded database.
 *
 * These are worth pinning because both were invisible to the unit tests: the
 * numeric one needs a live PostgreSQL connection, and the throttle one only
 * appears once the rate limiter actually trips.
 */

function fakeRequest(id = "req-1") {
  const logged: unknown[] = [];
  return {
    request: {
      id,
      log: {
        info: (...args: unknown[]) => logged.push(args),
        warn: (...args: unknown[]) => logged.push(args),
        error: (...args: unknown[]) => logged.push(args)
      }
    } as never,
    logged
  };
}

function captureReply() {
  const sent: { status?: number; body?: unknown } = {};
  const reply = {
    status(code: number) {
      sent.status = code;
      return reply;
    },
    send(body: unknown) {
      sent.body = body;
      return reply;
    }
  };
  return { reply: reply as never, sent };
}

describe("error handler: pre-shaped error envelopes", () => {
  /**
   * `@fastify/rate-limit` throws whatever `errorResponseBuilder` returned, so the
   * handler receives a plain object instead of an `Error`. Treating that as a bug
   * turned a throttled sign-in attempt into a 500.
   */
  it("passes through a throttled request as 429 rather than 500", () => {
    const { request } = fakeRequest();
    const { reply, sent } = captureReply();

    errorHandler(
      {
        statusCode: 429,
        error: {
          code: "TOO_MANY_REQUESTS",
          message: "Too many sign-in attempts from this device. Please wait a minute and try again."
        }
      } as never,
      request,
      reply
    );

    expect(sent.status).toBe(429);
    expect(sent.body).toEqual({
      error: {
        code: "TOO_MANY_REQUESTS",
        message: "Too many sign-in attempts from this device. Please wait a minute and try again."
      }
    });
  });

  it("defaults an envelope with no status to 429", () => {
    const { request } = fakeRequest();
    const { reply, sent } = captureReply();

    errorHandler(
      { error: { code: "TOO_MANY_REQUESTS", message: "Slow down." } } as never,
      request,
      reply
    );

    expect(sent.status).toBe(429);
  });

  it("does not leak the internal statusCode field into the body", () => {
    const { request } = fakeRequest();
    const { reply, sent } = captureReply();

    errorHandler(
      { statusCode: 429, error: { code: "TOO_MANY_REQUESTS", message: "Slow down." } } as never,
      request,
      reply
    );

    expect(sent.body).not.toHaveProperty("statusCode");
  });

  it("still returns 500 for a genuine unexpected error", () => {
    const { request } = fakeRequest();
    const { reply, sent } = captureReply();

    errorHandler(new TypeError("cannot read property of undefined"), request, reply);

    expect(sent.status).toBe(500);
    expect(sent.body).toMatchObject({ error: { code: "INTERNAL" } });
  });

  it("does not mistake a driver error for an envelope", () => {
    const { request } = fakeRequest();
    const { reply, sent } = captureReply();

    const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });
    errorHandler(uniqueViolation, request, reply);

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({ error: { code: "DUPLICATE_RECORD" } });
  });
});
