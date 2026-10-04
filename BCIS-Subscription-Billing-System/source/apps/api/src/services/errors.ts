/**
 * Application-level error taxonomy.
 *
 * §4.5 requires that a user sees an understandable message while the technical
 * detail goes to the structured log. Every service therefore throws a
 * `DomainError`, which carries a human message, an HTTP status and a stable
 * machine-readable code. The Fastify error handler renders the message and logs
 * the code; anything that is *not* a `DomainError` is treated as an unexpected
 * failure and its stack is logged but never shown to the user.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "UNAUTHENTICATED"
  | "CONFLICT"
  | "DUPLICATE_REFERENCE"
  | "DUPLICATE_RECORD"
  | "INVALID_STATE"
  | "BUSINESS_RULE"
  | "STOCK_SHORTAGE"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA"
  | "INTERNAL";

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function notFound(what: string, id?: string): DomainError {
  return new DomainError(
    "NOT_FOUND",
    id ? `${what} ${id} was not found.` : `${what} was not found.`,
    404,
    id ? { id } : undefined
  );
}

export function conflict(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("CONFLICT", message, 409, details);
}

export function businessRule(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("BUSINESS_RULE", message, 422, details);
}

export function forbidden(message = "You do not have permission to perform this action."): DomainError {
  return new DomainError("FORBIDDEN", message, 403);
}

export function invalidState(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("INVALID_STATE", message, 409, details);
}

export function validationFailed(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("VALIDATION_FAILED", message, 400, details);
}

/** Raised when a unique index rejects a duplicate. */
export function duplicateRecord(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("DUPLICATE_RECORD", message, 409, details);
}

/** Raised when an upload exceeds the configured size cap (§4.4). */
export function payloadTooLarge(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("PAYLOAD_TOO_LARGE", message, 413, details);
}

/** Raised when an upload's content type is not on the allow-list (§4.4). */
export function unsupportedMedia(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError("UNSUPPORTED_MEDIA", message, 415, details);
}

/** Raised when a GCash reference has already been used (AT-05). */
export function duplicateReference(reference: string): DomainError {
  return new DomainError(
    "DUPLICATE_REFERENCE",
    `GCash reference ${reference} has already been used by a verified payment. ` +
      "Verify it manually before posting it again.",
    409,
    { reference }
  );
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
