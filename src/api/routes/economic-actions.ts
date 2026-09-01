/**
 * Economic-action routes (WORK-032 / ECO-001, ECO-006, ECO-007; the
 * "directly-required economic-action API surface" declared surface).
 *
 * THE PROJECTION/COMMAND FACADE (same discipline as executions.ts): every
 * route delegates to the economics AUTHORITY through its public service —
 * the API never writes economics tables, never evaluates an admission
 * chain, never touches a payment rail and never mutates action state:
 *
 *   POST /economic-actions            → economics.createEconomicAction
 *   GET  /economic-actions/:id        → economics.getEconomicAction
 *   GET  /economic-actions/:id/events → economics.listEconomicActionEvents
 *   GET  /economic-actions/:id/outcome→ economics.deliveryEvidence
 *                                       (settlement + delivery as SEPARATE
 *                                       axes — payment success is never
 *                                       delivered-as-verified)
 *
 * WHAT IS DELIBERATELY NOT HERE: authorization/charge/settlement/delivery
 * mutation routes. Bounded payment authorization, rail charges, external
 * settlement correlation and delivery evidence recording flow through the
 * economics module's own governed seams (agent runtime / composition
 * wiring), not through this directly-required surface; raw payment
 * credentials never cross this boundary in either direction — the request
 * carries ONLY intent material (opaque recipient references, integer
 * micro-USD bounds, neutral rail preference string), and the response
 * projections carry no credential-shaped field at all.
 *
 * TENANT/SCOPE (M1/M2/M3): the scope is derived server-side per request
 * (the application names the scope, membership/tenant resolve from durable
 * rows); every read resolves the action row FIRST through the authority's
 * application-scoped getter — cross-application lookups return null → 404,
 * never another tenant's data.
 *
 * IDEMPOTENCY (§10): the create route REQUIRES an Idempotency-Key header
 * and delegates the semantics to the economics authority (the established
 * (application, operation, key, fingerprint) arbitration — material
 * economic constraints participate in the fingerprint, so the same key
 * against a mutated constraint fails IDEMPOTENCY_KEY_REUSED).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ScopeResolver } from "../../modules/auth/public";
import type { EconomicActionService } from "../../modules/economics/public";
import { mapErrorToResponse, PublicValidationError } from "../error-mapper";
import type { Authenticate, RequestIdentity } from "../request-identity";
import { requireStringField, resolveRequestIdentity } from "../request-identity";
import {
  toWireEconomicAction,
  toWireEconomicActionEvent,
  toWireEconomicActionOutcome,
  toWireEconomicActionReceipt,
} from "../serialization";

export interface EconomicActionRoutesDeps {
  /** The economics AUTHORITY (its public service surface). */
  readonly economics: EconomicActionService;
  readonly scopeResolver: ScopeResolver;
  readonly authenticate: Authenticate;
}

/** The request idempotency-key header (mandatory on the create route). */
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

/** Body keys the create route accepts (excess keys rejected — M2/M3). */
const CREATE_REQUEST_KEYS: readonly string[] = [
  "applicationId",
  "executionId",
  "purpose",
  "recipient",
  "amount",
  "currency",
  "expiresAt",
  "requiredCapabilities",
  "railPreference",
  "metadata",
];

interface ParsedCapabilityRequirement {
  readonly kind: string;
  readonly name: string;
  readonly minVersion?: string;
}

interface ParsedCreateRequest {
  readonly applicationId: string;
  readonly executionId: string;
  readonly purpose: string;
  readonly recipient: { readonly kind: string; readonly id: string };
  readonly amount:
    | { readonly kind: "exact"; readonly microUsd: string }
    | { readonly kind: "range"; readonly minMicroUsd: string; readonly maxMicroUsd: string };
  readonly currency: string;
  readonly expiresAt: string;
  readonly requiredCapabilities: readonly ParsedCapabilityRequirement[];
  readonly railPreference?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function requireObjectField(
  container: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = container[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request field "${key}" must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

/** Fail-closed create-request parsing (closed contract, typed shapes). */
function parseCreateRequest(body: unknown): ParsedCreateRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PublicValidationError("CAPABILITY_UNAVAILABLE", "request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !CREATE_REQUEST_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    // Fail closed: unknown keys are REJECTED (client tenant/provider/
    // credential injections are unrepresentable — M2/M3 + the frozen
    // create contract's own vocabulary rule).
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request contains unknown keys (the create contract is closed): ${unknownKeys.join(", ")}`,
    );
  }

  const applicationId = requireStringField(record, "applicationId");
  const executionId = requireStringField(record, "executionId");
  const purpose = requireStringField(record, "purpose");
  const currency = requireStringField(record, "currency");
  const expiresAt = requireStringField(record, "expiresAt");

  // Recipient: an OPAQUE external reference pair — there is no field where
  // a raw payment credential could even appear.
  const recipient = requireObjectField(record, "recipient");
  const recipientKind = requireStringField(recipient, "kind");
  const recipientId = requireStringField(recipient, "id");
  const recipientUnknown = Object.keys(recipient).filter((key) => key !== "kind" && key !== "id");
  if (recipientUnknown.length > 0) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `recipient contains unknown keys (kind + id only): ${recipientUnknown.join(", ")}`,
    );
  }

  // Amount: exact or an explicit bounded range (integer micro-USD strings).
  const amount = requireObjectField(record, "amount");
  const amountKind = requireStringField(amount, "kind");
  if (amountKind === "exact") {
    return {
      applicationId,
      executionId,
      purpose,
      recipient: { kind: recipientKind, id: recipientId },
      amount: { kind: "exact", microUsd: requireStringField(amount, "microUsd") },
      currency,
      expiresAt,
      requiredCapabilities: parseRequiredCapabilities(record),
      ...parseOptionalFields(record),
    };
  }
  if (amountKind === "range") {
    return {
      applicationId,
      executionId,
      purpose,
      recipient: { kind: recipientKind, id: recipientId },
      amount: {
        kind: "range",
        minMicroUsd: requireStringField(amount, "minMicroUsd"),
        maxMicroUsd: requireStringField(amount, "maxMicroUsd"),
      },
      currency,
      expiresAt,
      requiredCapabilities: parseRequiredCapabilities(record),
      ...parseOptionalFields(record),
    };
  }
  throw new PublicValidationError(
    "CAPABILITY_UNAVAILABLE",
    'request field "amount.kind" must be "exact" or "range"',
  );
}

function parseRequiredCapabilities(
  record: Record<string, unknown>,
): readonly ParsedCapabilityRequirement[] {
  const value = record.requiredCapabilities;
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      'request field "requiredCapabilities" must be an array',
    );
  }
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new PublicValidationError(
        "CAPABILITY_UNAVAILABLE",
        "requiredCapabilities entries must be objects",
      );
    }
    const requirement = entry as Record<string, unknown>;
    const parsed: ParsedCapabilityRequirement = {
      kind: requireStringField(requirement, "kind"),
      name: requireStringField(requirement, "name"),
      ...(requirement.minVersion === undefined
        ? {}
        : { minVersion: requireStringField(requirement, "minVersion") }),
    };
    const unknown = Object.keys(requirement).filter(
      (key) => key !== "kind" && key !== "name" && key !== "minVersion",
    );
    if (unknown.length > 0) {
      throw new PublicValidationError(
        "CAPABILITY_UNAVAILABLE",
        `requiredCapabilities entries contain unknown keys: ${unknown.join(", ")}`,
      );
    }
    return parsed;
  });
}

function parseOptionalFields(record: Record<string, unknown>): {
  railPreference?: string;
  metadata?: Readonly<Record<string, unknown>>;
} {
  const optional: { railPreference?: string; metadata?: Readonly<Record<string, unknown>> } = {};
  if (record.railPreference !== undefined) {
    optional.railPreference = requireStringField(record, "railPreference");
  }
  if (record.metadata !== undefined) {
    const metadata = requireObjectField(record, "metadata");
    optional.metadata = metadata;
  }
  return optional;
}

/** The application selector header for /economic-actions/:id reads. */
function applicationHeaderOf(request: { readonly headers: Record<string, unknown> }): string {
  const value = request.headers["x-zeck-application"];
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "economic action reads require the X-Zeck-Application header (the application whose scope authorizes the read)",
    );
  }
  return value;
}

export function registerEconomicActionRoutes(
  app: FastifyInstance,
  deps: EconomicActionRoutesDeps,
): void {
  // POST /economic-actions — economic intent creation through the
  // authority (the intent is NEVER an authorization — the admission chain
  // lives in the economics service, invoked by its own governed seams).
  app.post("/economic-actions", async (request, reply) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const parsed = parseCreateRequest(request.body);
      const identity: RequestIdentity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        parsed.applicationId,
      );
      const outcome = await deps.economics.createEconomicAction(
        {
          applicationId: parsed.applicationId,
          // SERVER-DERIVED scope (never a client assertion).
          tenantId: identity.scope.tenantId,
          actorId: identity.principal.actorId,
          executionId: parsed.executionId,
          purpose: parsed.purpose,
          recipient: parsed.recipient,
          amount: parsed.amount,
          currency: parsed.currency,
          expiresAt: parsed.expiresAt,
          requiredCapabilities: parsed.requiredCapabilities,
          ...(parsed.railPreference === undefined ? {} : { railPreference: parsed.railPreference }),
          ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
        },
        idempotencyKey,
      );
      return reply.status(201).send(toWireEconomicActionReceipt(outcome));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // The scope-checked action read shared by every /economic-actions/:id
  // route (the tenant check is the API's own fail-closed guard on top of
  // the authority's application-scoped getter).
  const loadAction = async (
    request: FastifyRequest,
    identity: RequestIdentity,
    applicationId: string,
  ): Promise<ReturnType<typeof toWireEconomicAction>> => {
    const actionId = requireStringField(request.params as Record<string, unknown>, "id");
    const record = await deps.economics.getEconomicAction(applicationId, actionId);
    if (record === null) {
      // Scope-checked miss: another application's action is
      // indistinguishable from a missing one (M1 — no tenant leak).
      throw notFound("economic action not found");
    }
    if (record.tenantId !== identity.scope.tenantId) {
      throw new PublicValidationError(
        "TENANT_SCOPE_VIOLATION",
        "cross-tenant economic action access denied",
      );
    }
    return toWireEconomicAction(record);
  };

  const identityFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    applicationId: string,
  ): Promise<RequestIdentity> =>
    resolveRequestIdentity(request, reply, deps.authenticate, deps.scopeResolver, applicationId);

  // GET /economic-actions/:id — the durable intent record (status read).
  app.get("/economic-actions/:id", async (request, reply) => {
    try {
      const applicationId = applicationHeaderOf(request);
      const identity = await identityFor(request, reply, applicationId);
      const action = await loadAction(request, identity, applicationId);
      return reply.send(action);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // GET /economic-actions/:id/events — the append-only per-action
  // provenance ledger (ECO-007).
  app.get("/economic-actions/:id/events", async (request, reply) => {
    try {
      const applicationId = applicationHeaderOf(request);
      const identity = await identityFor(request, reply, applicationId);
      await loadAction(request, identity, applicationId);
      const actionId = requireStringField(request.params as Record<string, unknown>, "id");
      const events = await deps.economics.listEconomicActionEvents(applicationId, actionId);
      return reply.send(events.map(toWireEconomicActionEvent));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // GET /economic-actions/:id/outcome — the outcome read: the correlated
  // settlement (external evidence) and the delivery observations as
  // SEPARATE axes (ECO-006: settlement is never delivery verification;
  // the verification authority alone decides delivery).
  app.get("/economic-actions/:id/outcome", async (request, reply) => {
    try {
      const applicationId = applicationHeaderOf(request);
      const identity = await identityFor(request, reply, applicationId);
      await loadAction(request, identity, applicationId);
      const actionId = requireStringField(request.params as Record<string, unknown>, "id");
      const bundle = await deps.economics.deliveryEvidence(applicationId, actionId);
      if (bundle === null) {
        throw notFound("economic action not found");
      }
      return reply.send(toWireEconomicActionOutcome(bundle));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });
}

/** A scope-checked miss: 404, indistinguishable from missing (M1). */
function notFound(message: string): PublicValidationError {
  return new PublicValidationError("CAPABILITY_UNAVAILABLE", message, 404);
}
