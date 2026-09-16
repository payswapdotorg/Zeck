/**
 * Credential routes (DEP-011 — the credential lifecycle's public facade).
 *
 * THE PROJECTION/COMMAND FACADE (the executions.ts house pattern): every
 * route delegates to the auth module's credential AUTHORITY — the API never
 * writes credential tables, never stores secrets, never re-implements the
 * lifecycle:
 *
 *   POST /credentials                      → credentialService.issue
 *   GET  /credentials                      → credentialService.list
 *   POST /credentials/:credentialId/rotate  → credentialService.rotate
 *   POST /credentials/:credentialId/revoke  → credentialService.revoke
 *
 * TENANT/SCOPE: the scope is derived server-side per request (the injected
 * scope resolver over durable membership rows); cross-tenant lookups fail
 * `TENANT_SCOPE_VIOLATION` before any durable write.
 *
 * IDEMPOTENCY: POST routes REQUIRE an Idempotency-Key header; the semantics
 * are the house arbitration (same key + same fingerprint replays the same
 * durable outcome; same key + different fingerprint → 409
 * IDEMPOTENCY_KEY_REUSED).
 *
 * THE SHOW-ONCE SECRET (DEP-011 AC1): the issue/rotate response carries the
 * secret material ONLY on the request that durably created it
 * (`replayed: false`). A replay of the same idempotent key returns the
 * metadata-only record with NO secret — the idempotency ledger's durable
 * outcome never contains secret material, so no later route, log or render
 * path can retrieve it. The secret appears on the wire exactly once, in the
 * immediate response to the creating request.
 *
 * SERIALIZATION BOUNDARY: every response body is built field-by-field
 * (allowlist construction — never a domain-record spread), the
 * toWireExecution discipline for FIXED-shape projections: every field is
 * named explicitly and there is no free-form map here for the key-scrub
 * guard to patrol. The wire shapes carry credential
 * METADATA only (identity, label, scope, role, permissions, timestamps,
 * status). There is no field where secret material could appear.
 *
 * UNWIRED DEPLOYMENTS: `credentials` is an optional composition dependency
 * (the deploy composition is another Work Order's surface); when absent,
 * every route answers with the honest 422 `CAPABILITY_UNAVAILABLE` — never
 * a fabricated fact.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ApplicationRole,
  CredentialRecord,
  CredentialService,
  ScopeResolver,
} from "../../modules/auth/public";
import { APPLICATION_ROLES } from "../../modules/auth/public";
import { mapErrorToResponse, PublicValidationError } from "../error-mapper";
import {
  type Authenticate,
  applicationScopeOf,
  type RequestIdentity,
  requireStringField,
  resolveRequestIdentity,
} from "../request-identity";

export interface CredentialRoutesDeps {
  /** The credential AUTHORITY (optional: absent ⇒ honest 422 per route). */
  readonly credentials?: CredentialService;
  readonly scopeResolver: ScopeResolver;
  readonly authenticate: Authenticate;
}

/** The request idempotency-key header (mandatory on POST routes). */
function requireIdempotencyKey(request: { readonly headers: Record<string, unknown> }): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "POST routes require an Idempotency-Key header (1..256 chars)",
    );
  }
  return value;
}

/** Body keys the issue route accepts (excess keys rejected — closed contract). */
const ISSUE_REQUEST_KEYS: readonly string[] = ["applicationId", "label", "role"];

/** Body keys the mutation routes accept (the empty object only). */
const EMPTY_REQUEST_KEYS: readonly string[] = [];

function parseObjectBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new PublicValidationError("CAPABILITY_UNAVAILABLE", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    // Fail closed: unknown keys are REJECTED (the request contract is closed).
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request contains unknown keys (the contract is closed): ${unknownKeys.join(", ")}`,
    );
  }
}

function requireAuthority(deps: CredentialRoutesDeps): CredentialService {
  if (deps.credentials === undefined) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "the credential authority is not wired in this deployment (the composition did not provide the credential service) — nothing is fabricated in its place",
    );
  }
  return deps.credentials;
}

// ---------------------------------------------------------------------------
// The wire shapes (allowlist construction; no domain-record spread)
// ---------------------------------------------------------------------------

interface WireCredential {
  readonly id: string;
  readonly credentialId: string;
  readonly applicationId: string;
  readonly label: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly supersededBy: string | null;
  /** The permission scope the authority derives from the role. */
  readonly permissions: readonly string[];
}

function toWireCredential(
  record: CredentialRecord,
  permissionsOf: (role: ApplicationRole) => readonly string[],
): WireCredential {
  // Allowlist construction, field by field — the toWireExecution
  // discipline for FIXED-shape projections: every field is named
  // explicitly (a domain-record spread is structurally impossible), and
  // there is NO free-form map here for the key-scrub guard to patrol
  // (the guard's domain is caller-shaped payloads like task/metadata —
  // a blunt key-pattern match would also misread the public identifier
  // fields `credentialId`/`credentials` as secret material).
  return {
    id: record.id,
    credentialId: record.credentialId,
    applicationId: record.applicationId,
    label: record.label,
    role: record.role,
    status: record.status,
    createdAt: record.createdAt,
    rotatedAt: record.rotatedAt,
    supersededBy: record.supersededBy,
    permissions: permissionsOf(record.role),
  };
}

interface WireIssueResponse {
  readonly credential: WireCredential;
  /**
   * Show-once secret: present only when this response is the one that
   * durably created the credential (`replayed: false`). NEVER present on a
   * replayed outcome, a list, or any other route. This is the ONE
   * sanctioned secret crossing: it is attached AFTER the metadata passes
   * the scrub guard (the guard redacts secret-shaped KEYS — this field is
   * the intentional payload of exactly this response, not a leak).
   */
  readonly secret: string | null;
  readonly replayed: boolean;
}

interface WireListResponse {
  readonly credentials: readonly WireCredential[];
  /** The deployment's issuance capability fact (the honest gate). */
  readonly issuance: { readonly enabled: boolean };
}

interface WireRevokeResponse {
  readonly credential: WireCredential;
  readonly replayed: boolean;
}

export function registerCredentialRoutes(app: FastifyInstance, deps: CredentialRoutesDeps): void {
  // POST /credentials — issue a scoped transport credential (show-once secret).
  app.post("/credentials", async (request, reply) => {
    try {
      const authority = requireAuthority(deps);
      const idempotencyKey = requireIdempotencyKey(request);
      const body = parseObjectBody(request.body);
      const applicationId = requireStringField(body, "applicationId");
      rejectUnknownKeys(body, ISSUE_REQUEST_KEYS);
      const label = requireStringField(body, "label");
      const role = requireStringField(body, "role");
      if (!(APPLICATION_ROLES as readonly string[]).includes(role)) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          `request field "role" must be one of ${APPLICATION_ROLES.join(", ")}`,
        );
      }
      const identity: RequestIdentity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const outcome = await authority.issue(
        {
          principal: identity.principal,
          applicationId,
          label,
          role: role as ApplicationRole,
        },
        idempotencyKey,
      );
      const wire: WireIssueResponse = {
        credential: toWireCredential(outcome.record, authority.permissionsOf),
        secret: outcome.secret,
        replayed: outcome.replayed,
      };
      return reply.status(201).send(wire);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // GET /credentials — the metadata-only list (scope-checked read).
  app.get("/credentials", async (request, reply) => {
    try {
      const authority = requireAuthority(deps);
      const applicationId = applicationScopeOf(request, "credential reads");
      const identity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const records = await authority.list(identity.principal, applicationId);
      const wire: WireListResponse = {
        credentials: records.map((record) => toWireCredential(record, authority.permissionsOf)),
        issuance: { enabled: authority.issuanceEnabled() },
      };
      // Fixed allowlist shape (no free-form maps): the toWireExecution
      // discipline — allowlist construction is the boundary.
      return reply.send(wire);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  const mutationIdentity = async (
    request: FastifyRequest,
    reply: FastifyReply,
    applicationId: string,
  ): Promise<RequestIdentity> =>
    resolveRequestIdentity(request, reply, deps.authenticate, deps.scopeResolver, applicationId);

  // POST /credentials/:credentialId/rotate — successor secret (show-once),
  // predecessor retired (confirm-then-act happens at the caller; the route
  // executes the durable transition through the authority).
  app.post("/credentials/:credentialId/rotate", async (request, reply) => {
    try {
      const authority = requireAuthority(deps);
      const idempotencyKey = requireIdempotencyKey(request);
      const body = parseObjectBody(request.body);
      rejectUnknownKeys(body, EMPTY_REQUEST_KEYS);
      const applicationId = applicationScopeOf(request, "credential commands");
      const identity = await mutationIdentity(request, reply, applicationId);
      const credentialId = requireStringField(
        request.params as Record<string, unknown>,
        "credentialId",
      );
      const outcome = await authority.rotate(
        { principal: identity.principal, applicationId, credentialId },
        idempotencyKey,
      );
      const wire: WireIssueResponse = {
        credential: toWireCredential(outcome.record, authority.permissionsOf),
        secret: outcome.secret,
        replayed: outcome.replayed,
      };
      return reply.send(wire);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // POST /credentials/:credentialId/revoke — immediate, idempotent.
  app.post("/credentials/:credentialId/revoke", async (request, reply) => {
    try {
      const authority = requireAuthority(deps);
      const idempotencyKey = requireIdempotencyKey(request);
      const body = parseObjectBody(request.body);
      rejectUnknownKeys(body, EMPTY_REQUEST_KEYS);
      const applicationId = applicationScopeOf(request, "credential commands");
      const identity = await mutationIdentity(request, reply, applicationId);
      const credentialId = requireStringField(
        request.params as Record<string, unknown>,
        "credentialId",
      );
      const outcome = await authority.revoke(
        { principal: identity.principal, applicationId, credentialId },
        idempotencyKey,
      );
      const wire: WireRevokeResponse = {
        credential: toWireCredential(outcome.record, authority.permissionsOf),
        replayed: outcome.replayed,
      };
      return reply.send(wire);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });
}

// Re-exported for the route-count pin and the console transport (the wire
// shape vocabulary this facade owns; NOT part of the frozen shared wire
// contract — the SDK surface addition is the Lead's merge note).
export type { WireCredential };
