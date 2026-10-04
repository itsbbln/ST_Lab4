import { ZodError } from "zod";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { DomainError } from "../services/errors.js";

/**
 * Centralised error rendering (§4.5).
 *
 * Two rules, and they are the whole point of this module:
 *
 *  - A `DomainError` is a *deliberate* outcome. Its message is written for a
 *    person and is safe to return verbatim, so the client always receives a
 *    stable machine code alongside the sentence.
 *  - Anything else is a bug. The stack goes to the log with the request id and
 *    the user receives a generic message, because internal failures routinely
 *    embed SQL fragments, file paths and connection strings.
 */

const pgDriverCodes: Record<string, { status: number; code: string; message: string }> = {
  "23505": {
    status: 409,
    code: "DUPLICATE_RECORD",
    message: "That record already exists."
  },
  "23503": {
    status: 409,
    code: "CONFLICT",
    message: "That change would break a reference to another record."
  },
  "23514": {
    status: 400,
    code: "VALIDATION_FAILED",
    message: "The database rejected the value as invalid."
  },
  "22P02": {
    status: 400,
    code: "VALIDATION_FAILED",
    message: "The value supplied is not in a valid format."
  },
  "40001": {
    status: 409,
    code: "CONFLICT",
    message: "Another transaction changed this data at the same time. Please retry."
  },
  "40P01": {
    status: 409,
    code: "CONFLICT",
    message: "The operation deadlocked. Please retry."
  }
};

function driverCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  if (typeof candidate?.code === "string") {
    return candidate.code;
  }
  const causeCode = candidate?.cause?.code;
  return typeof causeCode === "string" ? causeCode : undefined;
}

function zodDetails(error: ZodError): Record<string, unknown> {
  return {
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

export function errorHandler(
  error: Error | FastifyError,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const logger = request.log;

  if (error instanceof DomainError) {
    logger.info(
      { code: error.code, details: error.details, reqId: request.id },
      `domain error: ${error.message}`
    );
    void reply.status(error.statusCode).send({
      error: { code: error.code, message: error.message, details: error.details ?? undefined }
    });
    return;
  }

  if (error instanceof ZodError) {
    logger.info({ reqId: request.id, issues: error.issues }, "request validation failed");
    void reply.status(400).send({
      error: {
        code: "VALIDATION_FAILED",
        message: "Some of the values supplied are not valid.",
        details: zodDetails(error)
      }
    });
    return;
  }

  // A plugin may hand back a body that is already in our error envelope rather
  // than an `Error` - `@fastify/rate-limit` does exactly this, because its
  // `errorResponseBuilder` return value is thrown verbatim. Without this branch
  // a throttled sign-in attempt surfaces as a 500 "something went wrong", which
  // is both the wrong status code and actively misleading: the request was
  // refused on purpose, so it must be reported as a refusal.
  const enveloped = error as unknown as { statusCode?: unknown; error?: { code?: unknown; message?: unknown } };
  if (
    typeof enveloped?.error?.code === "string" &&
    typeof enveloped.error.message === "string"
  ) {
    const status = typeof enveloped.statusCode === "number" ? enveloped.statusCode : 429;
    logger.info({ status, reqId: request.id }, `request refused: ${enveloped.error.message}`);
    void reply.status(status).send({ error: { code: enveloped.error.code, message: enveloped.error.message } });
    return;
  }

  const pgCode = driverCode(error);
  if (pgCode && pgDriverCodes[pgCode]) {
    const mapped = pgDriverCodes[pgCode];
    logger.warn({ pgCode, reqId: request.id, detail: error.message }, "database rejected the request");
    void reply.status(mapped.status).send({
      error: { code: mapped.code, message: mapped.message }
    });
    return;
  }

  // Fastify's own framework errors (malformed JSON, payload too large, 404 on
  // an unknown route) carry a usable statusCode and message.
  const fastifyError = error as FastifyError;
  const status = typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : 500;
  if (status < 500) {
    logger.info({ status, reqId: request.id }, `request rejected: ${fastifyError.message}`);
    void reply.status(status).send({
      error: { code: "VALIDATION_FAILED", message: fastifyError.message || "The request could not be processed." }
    });
    return;
  }

  logger.error({ err: error, reqId: request.id }, "unhandled error while handling request");
  void reply.status(500).send({
    error: {
      code: "INTERNAL",
      message: "Something went wrong. Please try again, and quote this reference if it persists.",
      details: { reference: request.id }
    }
  });
}

/** Wraps an async handler so a rejected promise reaches `errorHandler`. */
export function asyncHandler<T>(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<T>
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => handler(request, reply);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: "NOT_FOUND",
        message: `No route matches ${request.method} ${request.url}.`
      }
    });
  });
}
