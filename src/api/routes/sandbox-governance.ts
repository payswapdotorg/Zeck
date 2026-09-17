/**
 * Sandbox governance routes (DEP-014 — the sandbox lifecycle's public
 * facade).
 *
 * THE PROJECTION/COMMAND FACADE (the executions.ts / credentials.ts house
 * pattern): every route delegates to the budgets module's QUOTA authority
 * and the sandbox module's IDENTITY authority — the API never writes
 * quota or identity tables, never re-implements the lifecycle:
 *
 *   GET  /sandbox/quotas                    → quotaService.assess
 *   GET  /sandbox/identities/:identityId    → identityService.get
 *   POST /sandbox/identities/:identityId/reset → identityService.reset
 *   GET  /sandbox/data-policy               → the versioned policy artifact
 *
 * TENANT/SCOPE: the scope is derived server-side per request; every read
 * resolves the record FIRST (scope-checked through the authority's
 * application-scoped getters — cross-application lookups return null →
 * 404, never another tenant's data). Cross-scope mutations fail with the
 * house TENANT_SCOPE_VIOLATION semantics.
 *
 * IDEMPOTENCY: the reset POST REQUIRES an Idempotency-Key header; the
 * service's own convergence (an already-reset predecessor returns its
 * existing successor) makes re-confirmation a no-op success — the AC4
 * discipline.
 *
 * THE POLICY ARTIFACT: GET /sandbox/data-policy serves the synthetic-data
 * policy document VERBATIM (the versioned, digest-carrying platform
 * artifact — one source of truth; the console renders THIS, never a
 * local copy). No secrets exist anywhere in these shapes.
 *
 * SERIALIZATION BOUNDARY: every response body is built field-by-field
 * (allowlist construction — never a domain-record spread).
 *
 * UNWIRED DEPLOYMENTS: the authorities are optional composition
 * dependencies; when absent, every route answers with the honest 422
 * CAPABILITY_UNAVAILABLE — never a fabricated fact.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ScopeResolver } from "../../modules/auth/public";
import type { QuotaService } from "../../modules/budgets/public";
import type { SandboxIdentityService } from "../../modules/sandbox/public";
import { SYNTHETIC_DATA_POLICY } from "../../modules/sandbox/public";
import { mapErrorToResponse, PublicValidationError } from "../error-mapper";
import {
  type Authenticate,
  applicationScopeOf,
  type RequestIdentity,
  resolveRequestIdentity,
} from "../request-identity";

export interface SandboxGovernanceRoutesDeps {
  /** The quota AUTHORITY (optional: absent ⇒ honest 422 per route). */
  readonly quotas?: QuotaService;
  /** The identity AUTHORITY (optional: absent ⇒ honest 422 per route). */
  readonly identities?: SandboxIdentityService;
  readonly scopeResolver: ScopeResolver;
  readonly authenticate: Authenticate;
}

/** The request idempotency-key header (mandatory on the reset POST). */
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

/** Body keys the reset route accepts (excess keys rejected — closed contract). */
const RESET_REQUEST_KEYS: readonly string[] = ["executionId"];

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
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request contains unknown keys (the contract is closed): ${unknownKeys.join(", ")}`,
    );
  }
}

function requireQuotas(deps: SandboxGovernanceRoutesDeps): QuotaService {
  if (deps.quotas === undefined) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "the quota authority is not wired in this deployment (the composition did not provide the quota service) — nothing is fabricated in its place",
    );
  }
  return deps.quotas;
}

function requireIdentities(deps: SandboxGovernanceRoutesDeps): SandboxIdentityService {
  if (deps.identities === undefined) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "the sandbox identity authority is not wired in this deployment (the composition did not provide the identity service) — nothing is fabricated in its place",
    );
  }
  return deps.identities;
}

// ---------------------------------------------------------------------------
// The wire shapes (allowlist construction; no domain-record spread)
// ---------------------------------------------------------------------------

interface WireQuota {
  readonly id: string;
  readonly applicationId: string;
  readonly dimension: string;
  readonly limit: string;
  readonly consumed: string;
  readonly window: string;
  readonly status: string;
  readonly identityId: string | null;
  readonly updatedAt: string;
}

interface WireQuotaListResponse {
  readonly quotas: readonly WireQuota[];
  /**
   * The honest telemetry boundary: the public API exposes no real-time
   * consumption stream — consumption updates on read, not live.
   */
  readonly telemetry: { readonly realtime: false };
}

interface WireIdentity {
  readonly id: string;
  readonly applicationId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly supersededBy: string | null;
  readonly supersedes: string | null;
  /** The honest TTL fact: expired at read time (never a silent 404). */
  readonly expired: boolean;
}

interface WireResetResponse {
  readonly identity: WireIdentity;
  readonly resetOf: string;
  /** The explicit nothing-carries-forward contract. */
  readonly stateCarriedForward: false;
  /** Honest ledger fact: false when no execution binding was supplied. */
  readonly ledgerRecorded: boolean;
}

export function registerSandboxGovernanceRoutes(
  app: FastifyInstance,
  deps: SandboxGovernanceRoutesDeps,
): void {
  // GET /sandbox/quotas — the per-scope quota state (scope-checked read).
  app.get("/sandbox/quotas", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const authority = requireQuotas(deps);
      const applicationId = applicationScopeOf(request, "sandbox quota reads");
      const identity: RequestIdentity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const records = await authority.assess({
        applicationId,
        tenantId: identity.scope.tenantId,
      });
      const wire: WireQuotaListResponse = {
        quotas: records.map((record) => ({
          id: record.id,
          applicationId: record.applicationId,
          dimension: record.dimension,
          limit: record.limit,
          consumed: record.consumed,
          window: record.window,
          status: record.status,
          identityId: record.identityId,
          updatedAt: record.updatedAt,
        })),
        telemetry: { realtime: false },
      };
      return reply.status(200).send(wire);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // GET /sandbox/identities/:identityId — the honest expiration state.
  app.get(
    "/sandbox/identities/:identityId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const authority = requireIdentities(deps);
        const applicationId = applicationScopeOf(request, "sandbox identity reads");
        const identity: RequestIdentity = await resolveRequestIdentity(
          request,
          reply,
          deps.authenticate,
          deps.scopeResolver,
          applicationId,
        );
        const params = request.params as { identityId?: string };
        const identityId = params.identityId ?? "";
        const record = await authority.get(applicationId, identityId);
        if (record === null) {
          return reply.status(404).send({
            code: "AUTHORIZATION_DENIED",
            message: `no sandbox identity "${identityId}" is visible to this scope`,
            retryable: false,
          });
        }
        const wire: WireIdentity = {
          id: record.id,
          applicationId: record.applicationId,
          status: record.status,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          supersededBy: record.supersededBy,
          supersedes: record.supersedes,
          expired: record.status === "expired",
        };
        return reply.status(200).send({ identity: wire });
      } catch (error) {
        return mapErrorToResponse(reply, error);
      }
    },
  );

  // POST /sandbox/identities/:identityId/reset — the idempotent,
  // state-non-carrying reset (confirm-then-act lives in the console; the
  // API is the single governed write path).
  app.post(
    "/sandbox/identities/:identityId/reset",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const authority = requireIdentities(deps);
        const idempotencyKey = requireIdempotencyKey(request);
        const body = parseObjectBody(request.body);
        rejectUnknownKeys(body, RESET_REQUEST_KEYS);
        const applicationId = applicationScopeOf(request, "sandbox identity resets");
        const identity: RequestIdentity = await resolveRequestIdentity(
          request,
          reply,
          deps.authenticate,
          deps.scopeResolver,
          applicationId,
        );
        const params = request.params as { identityId?: string };
        const identityId = params.identityId ?? "";
        const executionId =
          typeof body.executionId === "string" && body.executionId.length > 0
            ? body.executionId
            : undefined;
        const successor = await authority.reset({
          actorId: identity.principal.actorId,
          applicationId,
          tenantId: identity.scope.tenantId,
          identityId,
          ...(executionId === undefined ? {} : { executionId }),
          idempotencyKey,
        });
        const wire: WireResetResponse = {
          identity: {
            id: successor.id,
            applicationId: successor.applicationId,
            status: successor.status,
            createdAt: successor.createdAt,
            expiresAt: successor.expiresAt,
            supersededBy: successor.supersededBy,
            supersedes: successor.supersedes,
            expired: false,
          },
          resetOf: identityId,
          stateCarriedForward: false,
          ledgerRecorded: executionId !== undefined,
        };
        return reply.status(200).send(wire);
      } catch (error) {
        return mapErrorToResponse(reply, error);
      }
    },
  );

  // GET /sandbox/data-policy — the versioned synthetic-data policy
  // artifact, served verbatim (one source of truth; no secrets exist in
  // this shape — it is the PUBLIC policy document).
  app.get("/sandbox/data-policy", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(200).send({
      artifact: SYNTHETIC_DATA_POLICY.artifact,
      version: SYNTHETIC_DATA_POLICY.version,
      digest: SYNTHETIC_DATA_POLICY.digest,
      permittedClasses: SYNTHETIC_DATA_POLICY.permittedClasses,
      prohibitedClasses: SYNTHETIC_DATA_POLICY.prohibitedClasses,
      enforcement: SYNTHETIC_DATA_POLICY.enforcement,
      violationRecording: SYNTHETIC_DATA_POLICY.violationRecording,
    });
  });
}
