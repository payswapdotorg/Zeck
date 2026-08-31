/**
 * The public error mapper (WORK-015; M25 of the discrimination list).
 *
 * Maps the canonical `PlatformError` taxonomy to stable HTTP responses:
 *  - the response body is ALWAYS the public error shape {code, message,
 *    retryable, details?} — typed with the canonical codes, never a
 *    stack trace, never a SQL error, never a host path, never provider
 *    internals;
 *  - unknown errors fail closed to a generic `PROVIDER_ERROR` 500 whose
 *    message discloses NOTHING internal (the original error is logged
 *    server-side only — `reply.log.error`, never serialized);
 *  - the status mapping is total and deterministic.
 */

import type { FastifyReply } from "fastify";
import { PlatformError } from "../shared/errors";
import type { PublicError } from "../shared/wire";
import { toPublicErrorBody } from "./serialization";

const STATUS_BY_CODE: Record<PublicError["code"], number> = {
  AUTHENTICATION_FAILED: 401,
  AUTHORIZATION_DENIED: 403,
  TENANT_SCOPE_VIOLATION: 403,
  POLICY_DENIED: 403,
  BUDGET_EXCEEDED: 402,
  IDEMPOTENCY_KEY_REUSED: 409,
  CAPABILITY_UNAVAILABLE: 422,
  NO_ELIGIBLE_ROUTE: 422,
  PROVIDER_ERROR: 502,
  TOOL_ERROR: 502,
  AGENT_ERROR: 502,
  SANDBOX_ERROR: 502,
  VERIFICATION_FAILED: 422,
  VERIFICATION_INCONCLUSIVE: 422,
  NON_CONVERGENT_EXTERNAL_EFFECT: 502,
  INVALID_STATE_TRANSITION: 409,
  EXPIRED: 410,
};

/** Human-safe validation error (the transport's own input failures). */
export class PublicValidationError extends Error {
  readonly code: PublicError["code"];
  /** Optional explicit HTTP status (default: the code's mapped status). */
  readonly httpStatus?: number;

  constructor(code: PublicError["code"], message: string, httpStatus?: number) {
    super(message);
    this.name = "PublicValidationError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Send the canonical public error body. The details are scrubbed
 * (secret-shaped keys redacted) by the serialization boundary.
 */
export function sendPublicError(
  reply: FastifyReply,
  status: number,
  body: PublicError,
): FastifyReply {
  return reply.status(status).send(body);
}

/**
 * The one error boundary of the API surface: any thrown value maps to a
 * stable public response. NEVER rethrows; never serializes the original
 * error object (M25).
 */
export function mapErrorToResponse(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof PlatformError) {
    const body = toPublicErrorBody(error.code, error.message, error.retryable, error.details);
    return sendPublicError(reply, STATUS_BY_CODE[error.code] ?? 500, body);
  }
  if (error instanceof PublicValidationError) {
    const body = toPublicErrorBody(error.code, error.message, false);
    return sendPublicError(reply, error.httpStatus ?? STATUS_BY_CODE[error.code] ?? 400, body);
  }
  // Unknown error: log server-side (never serialized), fail closed with a
  // disclosure-free 500.
  reply.log.error({ err: error }, "unhandled API error (internal details logged only)");
  return sendPublicError(
    reply,
    500,
    toPublicErrorBody("PROVIDER_ERROR", "internal error (no further detail is exposed)", true),
  );
}
