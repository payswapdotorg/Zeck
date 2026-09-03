/**
 * Request authentication + server-side scope resolution (WORK-015;
 * M1/M2/M3 of the discrimination list, acceptance criterion 9).
 *
 * THE TENANT/IDENTITY MODEL (the frozen rule):
 *  - the caller authenticates ONCE per request through the injected
 *    `authenticate` seam (transport credential → `Principal` — the auth
 *    module's contract: "an already-authenticated actor reference");
 *  - the effective application/tenant scope is ALWAYS derived
 *    SERVER-SIDE by the auth module's scope resolver from durable
 *    membership/ownership rows. A client-supplied tenantId or
 *    ownerId is NEVER read as authorization authority (M2/M3) — unknown
 *    body fields are rejected outright, and there is no code path that
 *    reads a tenant from the request;
 *  - every handler resolves its scope from the PATH/route identity
 *    (applicationId from the request body for creation, executionId →
 *    durable row for reads) — cross-tenant lookups fail
 *    `TENANT_SCOPE_VIOLATION`/`AUTHORIZATION_DENIED` before any
 *    downstream module call (M1).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { Principal, ScopeResolver, TenantScope } from "../modules/auth/public";
import { ZECK_APPLICATION_HEADER } from "../shared/wire";
import { PublicValidationError } from "./error-mapper";

/** The injected transport-authentication seam (credential → principal). */
export type Authenticate = (request: FastifyRequest) => Promise<Principal>;

export interface RequestIdentity {
  readonly principal: Principal;
  readonly scope: TenantScope;
}

/** Extract the bearer credential from the Authorization header. */
export function bearerTokenOf(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new PublicValidationError(
      "AUTHENTICATION_FAILED",
      "missing or malformed Authorization header (expected: Bearer <token>)",
    );
  }
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) {
    throw new PublicValidationError("AUTHENTICATION_FAILED", "empty bearer credential");
  }
  return token;
}

/**
 * Resolve the request identity: authenticate, then derive the scope for
 * `applicationId` SERVER-SIDE. The client's tenant/application
 * assertions are never consulted (M2/M3).
 */
export async function resolveRequestIdentity(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticate: Authenticate,
  scopeResolver: ScopeResolver,
  applicationId: string,
): Promise<RequestIdentity> {
  const principal = await authenticate(request);
  const scope = await scopeResolver.resolveApplicationScope(principal, applicationId);
  void reply;
  return { principal, scope };
}

/**
 * The application-scope selector every scoped route requires (WORK-034,
 * single-sourced): the canonical header names the application whose
 * durable membership rows authorize the request — the effective scope is
 * still resolved SERVER-SIDE by the scope resolver, so the selector never
 * authorizes by itself. All scoped route families (executions, agents,
 * codebase analysis, economic actions) consume this one rule; no route
 * holds a local copy.
 */
export function applicationScopeOf(
  request: { readonly headers: Record<string, unknown> },
  surface: string,
): string {
  const value = request.headers[ZECK_APPLICATION_HEADER];
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `${surface} require the X-Zeck-Application header (the application whose scope authorizes the request)`,
    );
  }
  return value;
}

/** A non-empty string body field (fail-closed input validation). */
export function requireStringField(container: Record<string, unknown>, key: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request body field "${key}" must be a non-empty string`,
    );
  }
  return value;
}
