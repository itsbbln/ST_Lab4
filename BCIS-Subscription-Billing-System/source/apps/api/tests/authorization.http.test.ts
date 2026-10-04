import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../src/services/auth.js")>("../src/services/auth.js");
  return {
    ...actual,
    resolveSession: vi.fn()
  };
});

import { buildApp } from "../src/app.js";
import { resolveSession } from "../src/services/auth.js";

const resolveSessionMock = vi.mocked(resolveSession);

/**
 * HTTP-level authorization regression for AT-10.
 *
 * The specification requires proof that a cashier cannot call an admin-only
 * operation directly over HTTP. This stays out of the database on purpose: the
 * route must reject the request in its preHandler before any handler logic runs.
 */
describe("server-side authorization", () => {
  afterEach(() => {
    resolveSessionMock.mockReset();
  });

  it("rejects a cashier calling the admin-only users endpoint", async () => {
    resolveSessionMock.mockResolvedValue({
      id: "cashier-user",
      username: "cashier",
      displayName: "Cashier",
      permissions: ["payment.view", "payment.create", "receivables.view"]
    });

    const { app } = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/users",
        headers: {
          authorization: "Bearer cashier-token"
        }
      });

      expect(response.statusCode).toBe(403);
      expect(response.headers["www-authenticate"]).toBe('Bearer error="insufficient_scope"');
      expect(response.json()).toEqual({
        error: {
          code: "FORBIDDEN",
          message: "This action requires the following permission(s): user.manage."
        }
      });
      expect(resolveSessionMock).toHaveBeenCalledWith("cashier-token");
    } finally {
      await app.close();
    }
  });

  it("rejects a direct call with no bearer token at all", async () => {
    const { app } = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/users"
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          code: "UNAUTHENTICATED",
          message: "A bearer token is required."
        }
      });
      expect(resolveSessionMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
