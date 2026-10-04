import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";

import { closeDatabase, ping } from "./db/client.js";
import { registerErrorHandling } from "./http/error-handler.js";
import { GLOBAL_RATE_LIMIT, RATE_LIMIT_WINDOW } from "./http/limits.js";
import { registerAttachmentRoutes } from "./routes/attachments.routes.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerBackupRoutes } from "./routes/backup.routes.js";
import { registerBillingRoutes } from "./routes/billing.routes.js";
import { registerCollectionRoutes } from "./routes/collections.routes.js";
import { registerDashboardRoutes } from "./routes/dashboard.routes.js";
import { registerDirectoryRoutes } from "./routes/directory.routes.js";
import { registerLedgerRoutes } from "./routes/ledger.routes.js";
import { registerPaymentRoutes } from "./routes/payments.routes.js";
import { registerReceivablesRoutes } from "./routes/receivables.routes.js";
import { registerReportRoutes } from "./routes/reports.routes.js";
import { registerServiceControlRoutes } from "./routes/service-control.routes.js";
import { registerSystemRoutes } from "./routes/system.routes.js";
import { MAX_ATTACHMENT_BYTES } from "./services/attachments.js";

/**
 * The API server (§2.2).
 *
 * One Fastify instance serves all three office clients over the LAN. The shape of
 * the app is deliberately thin:
 *
 *  - `helmet` sets the baseline headers. Because the Electron renderer is a
 *    `file://` page talking to `http://<server>:3001`, CORS is restricted to
 *    loopback in development and to the configured origins otherwise.
 *  - `rate-limit` is applied globally but tightened hard on `/auth/login`,
 *    because that is the only endpoint an attacker can hammer without a token.
 *  - Routes are grouped by feature and each one names the permissions it needs.
 *    Nothing authorizes by hiding UI.
 *  - `closeDatabase` runs on shutdown so `tsx watch` restarts do not leak
 *    connections.
 *
 * The database handle is created lazily on first use (see `db/client.ts`), so
 * building the app does not open a socket and the acceptance tests can build it
 * without a live database.
 */

export interface BuiltApp {
  app: FastifyInstance;
}

export interface BuildAppOptions {
  logger?: boolean;
  /** Extra origins allowed by CORS, e.g. the office server's address. */
  corsOrigins?: string[];
}

export function buildApp(options: BuildAppOptions = {}): BuiltApp {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            // The structured log is what §4.5 accountability evidence is built
            // from, so request ids are always present.
            redact: {
              paths: [
                "req.headers.authorization",
                "req.body.password",
                "req.body.newPassword",
                "req.body.currentPassword"
              ],
              censor: "[redacted]"
            }
          },
    genReqId: (request) => (request.headers["x-request-id"] as string) || randomUUID(),
    // Uploads are only proofs of payment and backups, both capped well below
    // this; anything larger is rejected rather than buffered.
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true
  });

  registerErrorHandling(app);

  void app.register(helmet, {
    // The renderer loads its own bundle; the API serves JSON, not HTML, so the
    // default CSP would only get in the way of the Electron security model.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });

  void app.register(cors, {
    origin: allowedOrigins(options.corsOrigins),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });

  void app.register(rateLimit, {
    max: GLOBAL_RATE_LIMIT,
    timeWindow: RATE_LIMIT_WINDOW,
    // Rate limits are tracked per office client so one busy terminal cannot lock
    // out the whole LAN.
    keyGenerator: (request) => request.ip ?? "unknown",
    skipOnError: true
  });

  // Multipart is registered for payment-proof uploads (§3.6, §4.4). The limits
  // are the enforcement half of the upload policy: the service re-checks the type
  // against the file's magic bytes and the size with its own counter, so a request
  // that arrives without going through this parser is still bounded. One file per
  // request keeps the shape unambiguous - a proof is a single screenshot.
  void app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_ATTACHMENT_BYTES,
      // Fields are only used to carry the entity reference; anything larger is a
      // mistake rather than a legitimate request.
      fields: 10,
      fieldSize: 512
    }
  });

  // A tight budget for sign-in attempts, applied as route config on
  // `POST /auth/login` (see `auth.routes.ts`). It is deliberately much smaller
  // than the global budget so that repeatedly retrying a password cannot exhaust
  // a normal user's quota. The service additionally locks an individual account
  // after repeated failures; this protects the API from a distributed attempt
  // across many usernames from one machine.
  app.get("/health", async (_request, reply) => {
    const database = await ping();
    if (!database) {
      return reply.status(503).send({ status: "degraded", database: "unreachable" });
    }
    return { status: "ok", database: "ok" };
  });

  void app.register(registerAuthRoutes);
  void app.register(registerDashboardRoutes);
  void app.register(registerDirectoryRoutes);
  void app.register(registerBillingRoutes);
  void app.register(registerPaymentRoutes);
  void app.register(registerCollectionRoutes);
  void app.register(registerReceivablesRoutes);
  void app.register(registerServiceControlRoutes);
  void app.register(registerReportRoutes);
  void app.register(registerLedgerRoutes);
  void app.register(registerSystemRoutes);
  void app.register(registerBackupRoutes);
  void app.register(registerAttachmentRoutes);

  app.addHook("onClose", async () => {
    await closeDatabase();
  });

  return { app };
}

/**
 * CORS allow-list.
 *
 * Loopback origins are always permitted so the renderer works on a developer
 * machine with no configuration. `CORS_ORIGINS` adds the LAN addresses the three
 * office PCs use.
 *
 * A packaged desktop client loads its pages over `file://`, and a page with an
 * opaque origin sends the literal string `null` as its `Origin` header. That is
 * not covered by a loopback entry, so a packaged client must be given `null`
 * explicitly, which is what the desktop app does when it starts the API itself.
 * It is deliberately *not* a default: `null` is also sent by sandboxed frames
 * and `data:` documents, so allowing it unconditionally would let any page in a
 * browser on the LAN attempt cross-origin calls against the API.
 */
function allowedOrigins(extra: string[] = []): string[] {
  const fromEnv = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...fromEnv,
    ...extra
  ];
}
