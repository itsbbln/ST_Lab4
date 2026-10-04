import { buildApp } from "./app.js";

const port = Number(process.env.API_PORT ?? 3001);
const host = process.env.API_HOST ?? "127.0.0.1";

const { app } = buildApp();

/**
 * Graceful shutdown.
 *
 * The `onClose` hook installed in `app.ts` ends the PostgreSQL pool, so a
 * `tsx watch` restart or a service-manager stop does not leave connections
 * hanging and eventually exhaust the server's `max_connections`.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ err: error }, "failed to shut down cleanly");
        process.exit(1);
      }
    );
  });
}

app.listen({ port, host }).then(
  () => {
    app.log.info(`BCIS API listening at http://${host}:${port}`);
  },
  (error: unknown) => {
    app.log.error({ err: error }, "failed to start the API");
    process.exit(1);
  }
);
