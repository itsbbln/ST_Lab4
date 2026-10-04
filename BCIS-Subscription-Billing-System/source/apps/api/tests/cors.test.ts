import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

/**
 * CORS regression test for the packaged desktop client.
 *
 * A packaged renderer loads over `file://`, so the browser sends the literal
 * string `null` as its `Origin` header. This was verified against a running
 * server: a preflight from `null` came back 204 with no
 * `Access-Control-Allow-Origin`, so a packaged client would fail every request
 * while the server log still reported success.
 *
 * The rule these tests pin down: `null` is only allowed when it is configured
 * explicitly. `null` is also what a sandboxed frame or a `data:` document sends,
 * so allowing it by default would let any page in a browser on the office LAN
 * attempt cross-origin calls against the API.
 */

const originalEnv = process.env.CORS_ORIGINS;

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CORS_ORIGINS;
  } else {
    process.env.CORS_ORIGINS = originalEnv;
  }
});

async function preflight(origin: string, corsOrigins: string[]) {
  process.env.CORS_ORIGINS = corsOrigins.join(",");
  const { app } = buildApp({ logger: false, corsOrigins });
  await app.ready();

  try {
    const response = await app.inject({
      method: "OPTIONS",
      url: "/auth/login",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });

    return {
      status: response.statusCode,
      allowOrigin: response.headers["access-control-allow-origin"] as string | undefined
    };
  } finally {
    await app.close();
  }
}

describe("CORS for the packaged desktop client", () => {
  it("refuses the opaque file:// origin by default", async () => {
    const probe = await preflight("null", []);

    expect(probe.status).toBe(204);
    expect(probe.allowOrigin).toBeUndefined();
  });

  it("allows the opaque origin once it is configured", async () => {
    const probe = await preflight("null", ["null"]);

    expect(probe.status).toBe(204);
    expect(probe.allowOrigin).toBe("null");
  });

  it("still refuses an unknown LAN origin", async () => {
    const probe = await preflight("http://attacker.example", ["null"]);

    expect(probe.allowOrigin).toBeUndefined();
  });

  it("allows the renderer dev server without configuration", async () => {
    const probe = await preflight("http://127.0.0.1:5173", []);

    expect(probe.allowOrigin).toBe("http://127.0.0.1:5173");
  });
});
