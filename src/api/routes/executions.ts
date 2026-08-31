/**
 * Execution routes (WORK-015 / API-001, API-005; M11/M12/M13/M26).
 *
 * THE PROJECTION/COMMAND FACADE (§6 of the Work Order): every route
 * delegates to the executions AUTHORITY (its public service) — the API
 * NEVER writes execution tables, never mutates state directly, never
 * re-implements the state machine:
 *
 *   POST /executions            → executions.createExecution
 *   GET  /executions/:id        → executions.getExecution
 *   POST /executions/:id/cancel → executions.transition(cancel)
 *   GET  /executions/:id/results       → executions.getExecution +
 *                                        listVerificationResults
 *   GET  /executions/:id/events        → executions.listEvents
 *   GET  /executions/:id/verification  → executions.listVerificationResults
 *
 * TENANT/SCOPE (M1/M2/M3): the scope is derived server-side per request;
 * every read resolves the execution row FIRST (scope-checked through the
 * authority's application-scoped getters — cross-application lookups
 * return null → 404, never another tenant's data).
 *
 * IDEMPOTENCY (§10): POST routes REQUIRE an Idempotency-Key header and
 * delegate the semantics to the executions authority (the established
 * (application, operation, key, fingerprint) arbitration — M11/M12:
 * same key + same fingerprint replays the same durable outcome; same
 * key + different fingerprint → 409 IDEMPOTENCY_KEY_REUSED; concurrent
 * identical requests converge on one durable row).
 *
 * CANCELLATION (M26): cancel goes THROUGH the execution lifecycle
 * (`transition({command: "cancel"})`) — the single write path; the API
 * has no direct state mutation.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ScopeResolver } from "../../modules/auth/public";
import type { ExecutionService } from "../../modules/executions/public";
import type {
  Execution,
  ExecutionReceipt,
  ExecutionResult,
  VerificationResult,
} from "../../shared/wire";
import { mapErrorToResponse, PublicValidationError } from "../error-mapper";
import type { Authenticate, RequestIdentity } from "../request-identity";
import { requireStringField, resolveRequestIdentity } from "../request-identity";
import { toWireEvent, toWireExecution, toWireReceipt, toWireVerification } from "../serialization";

export interface ExecutionRoutesDeps {
  readonly executions: ExecutionService;
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

/** Body keys the create route accepts (excess keys rejected — M2/M3). */
const CREATE_REQUEST_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "task",
  "inputArtifactRefs",
  "constraints",
  "metadata",
  "userId",
];

function parseCreateRequest(body: unknown): {
  readonly applicationId: string;
  readonly input: Record<string, unknown>;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PublicValidationError("CAPABILITY_UNAVAILABLE", "request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const applicationId = requireStringField(record, "applicationId");
  if (typeof record.task !== "object" || record.task === null || Array.isArray(record.task)) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      'request field "task" must be an object',
    );
  }
  const unknownKeys = Object.keys(record).filter((key) => !CREATE_REQUEST_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    // Fail closed: unknown keys are REJECTED (client tenant/provider
    // injections are unrepresentable — M2/M3 + the frozen create
    // contract's own vocabulary rule).
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request contains unknown keys (the create contract is closed): ${unknownKeys.join(", ")}`,
    );
  }
  return { applicationId, input: record };
}

export function registerExecutionRoutes(app: FastifyInstance, deps: ExecutionRoutesDeps): void {
  // POST /executions — creation through the authority (API-001).
  app.post("/executions", async (request, reply) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const { applicationId, input } = parseCreateRequest(request.body);
      const identity: RequestIdentity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const receipt = await deps.executions.createExecution(
        {
          applicationId,
          ...(input.environmentId === undefined
            ? {}
            : { environmentId: input.environmentId as string }),
          task: input.task as Record<string, unknown>,
          ...(input.inputArtifactRefs === undefined
            ? {}
            : { inputArtifactRefs: input.inputArtifactRefs as string[] }),
          ...(input.constraints === undefined
            ? {}
            : { constraints: input.constraints as Record<string, unknown> }),
          ...(input.metadata === undefined
            ? {}
            : { metadata: input.metadata as Record<string, unknown> }),
          ...(input.userId === undefined ? {} : { userId: input.userId as string }),
        },
        idempotencyKey,
        { actorId: identity.principal.actorId, tenantId: identity.scope.tenantId },
      );
      return reply.status(201).send(toWireReceipt(receipt));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // The scope-checked execution read shared by every /executions/:id route.
  const loadExecution = async (
    request: FastifyRequest,
    identity: RequestIdentity,
  ): Promise<Execution> => {
    const executionId = requireStringField(request.params as Record<string, unknown>, "id");
    const applicationId = applicationHeaderOf(request);
    const record = await deps.executions.getExecution(applicationId, executionId);
    if (record === null) {
      // Scope-checked miss: another application's execution is
      // indistinguishable from a missing one (M1 — no tenant leak).
      throw notFound("execution not found");
    }
    if (record.tenantId !== identity.scope.tenantId) {
      throw new PublicValidationError(
        "TENANT_SCOPE_VIOLATION",
        "cross-tenant execution access denied",
      );
    }
    return toWireExecution(record);
  };

  const identityFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<RequestIdentity> =>
    resolveRequestIdentity(
      request,
      reply,
      deps.authenticate,
      deps.scopeResolver,
      applicationHeaderOf(request),
    );

  app.get("/executions/:id", async (request, reply) => {
    try {
      const identity = await identityFor(request, reply);
      const execution = await loadExecution(request, identity);
      return reply.send(execution);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.post("/executions/:id/cancel", async (request, reply) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      const applicationId = applicationHeaderOf(request);
      const identity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const executionId = requireStringField(request.params as Record<string, unknown>, "id");
      const record = await deps.executions.getExecution(applicationId, executionId);
      if (record === null) {
        throw notFound("execution not found");
      }
      if (record.tenantId !== identity.scope.tenantId) {
        throw new PublicValidationError(
          "TENANT_SCOPE_VIOLATION",
          "cross-tenant execution access denied",
        );
      }
      // Cancellation THROUGH the execution lifecycle (M26): the authority
      // validates the transition (non-terminal only) and appends the
      // cancel envelope — the API never writes state directly.
      const outcome = await deps.executions.transition(
        {
          command: "cancel",
          applicationId,
          tenantId: identity.scope.tenantId,
          executionId,
          actorId: identity.principal.actorId,
        },
        idempotencyKey,
      );
      const receipt: ExecutionReceipt = {
        executionId: outcome.execution.id,
        applicationId,
        status: outcome.execution.status,
        createdAt: outcome.execution.createdAt,
        replayed: outcome.replayed,
        lastEventSequence: outcome.execution.lastEventSequence,
      };
      return reply.send(receipt);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.get("/executions/:id/events", async (request, reply) => {
    try {
      const applicationId = applicationHeaderOf(request);
      const identity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const executionId = requireStringField(request.params as Record<string, unknown>, "id");
      await loadExecution(request, identity);
      const events = await deps.executions.listEvents(applicationId, executionId);
      return reply.send(events.map(toWireEvent));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.get("/executions/:id/verification", async (request, reply) => {
    try {
      const applicationId = applicationHeaderOf(request);
      const identity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const executionId = requireStringField(request.params as Record<string, unknown>, "id");
      await loadExecution(request, identity);
      const results = await deps.executions.listVerificationResults(applicationId, executionId);
      return reply.send(results.map(toWireVerification));
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  app.get("/executions/:id/results", async (request, reply) => {
    try {
      const applicationId = applicationHeaderOf(request);
      const identity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const executionId = requireStringField(request.params as Record<string, unknown>, "id");
      const execution = await loadExecution(request, identity);
      const verification = await deps.executions.listVerificationResults(
        applicationId,
        executionId,
      );
      const events = await deps.executions.listEvents(applicationId, executionId);

      // The result package (IMPLEMENTATION.md §6) as a public
      // projection: route summary from the ledger's planning decisions,
      // cost from the durable ledger facts, verification evidence, and
      // honest warnings — computed ONLY from authority reads.
      const route = routeSummaryOf(events);
      const cost = costSummaryOf(events, verification);
      const result: ExecutionResult = {
        executionId,
        status: execution.status,
        route,
        cost,
        usage: usageOf(events),
        outputArtifacts: artifactsOf(events),
        verification: verification.map(toWireVerification),
        warnings: warningsOf(execution, verification.map(toWireVerification)),
        terminalAt: execution.terminalAt,
      };
      return reply.send(result);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });
}

/** The application selector header for /executions/:id reads. */
function applicationHeaderOf(request: { readonly headers: Record<string, unknown> }): string {
  const value = request.headers["x-zeck-application"];
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "execution reads require the X-Zeck-Application header (the application whose scope authorizes the read)",
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Result-package projections over the canonical event ledger (pure).
// ---------------------------------------------------------------------------

type LedgerEvent = {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

function routeSummaryOf(events: readonly LedgerEvent[]) {
  const decision = [...events]
    .reverse()
    .find((event) => event.type === "planning.decision-recorded");
  const payload = decision?.payload as
    | {
        readonly candidates?: readonly {
          readonly strategyId?: string;
          readonly plan?: {
            readonly steps?: readonly {
              readonly routeRef?: { readonly provider: string; readonly model: string };
            }[];
            readonly strategyClass?: string;
            readonly modelCalls?: number;
          };
        }[];
        readonly selectedStrategyId?: string;
      }
    | undefined;
  const selected = payload?.candidates?.find(
    (candidate) => candidate.strategyId === payload?.selectedStrategyId,
  );
  const plan = selected?.plan;
  const routeRef = plan?.steps?.find((step) => step.routeRef !== undefined)?.routeRef;
  if (plan === undefined) {
    return null;
  }
  return {
    provider: routeRef?.provider ?? null,
    model: routeRef?.model ?? null,
    strategyClass: plan.strategyClass ?? null,
    modelCalls: plan.modelCalls ?? 0,
  };
}

function costSummaryOf(events: readonly LedgerEvent[], verification: readonly unknown[]) {
  // Cost is surfaced when the durable ledger carries settled usage facts
  // (the budgets authority settles through its own surface); without
  // settled facts the result package reports null — never a fabricated
  // number.
  const settled = [...events].reverse().find((event) => event.type === "execution.completed");
  const costMicroUsd = (settled?.payload as { readonly costMicroUsd?: unknown } | undefined)
    ?.costMicroUsd;
  void verification;
  if (typeof costMicroUsd !== "string" || !/^\d+$/.test(costMicroUsd)) {
    return null;
  }
  return { totalMicroUsd: costMicroUsd, currency: "usd" as const };
}

function usageOf(events: readonly LedgerEvent[]) {
  const settled = [...events].reverse().find((event) => event.type === "execution.completed");
  const usage = (settled?.payload as { readonly usage?: unknown } | undefined)?.usage;
  const inputTokens = (usage as { readonly inputTokens?: unknown } | undefined)?.inputTokens;
  const outputTokens = (usage as { readonly outputTokens?: unknown } | undefined)?.outputTokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    return null;
  }
  return { inputTokens, outputTokens };
}

function artifactsOf(events: readonly LedgerEvent[]) {
  const settled = [...events].reverse().find((event) => event.type === "execution.completed");
  const artifacts = (settled?.payload as { readonly outputArtifacts?: unknown } | undefined)
    ?.outputArtifacts;
  if (!Array.isArray(artifacts)) {
    return [];
  }
  return artifacts
    .filter(
      (
        artifact,
      ): artifact is {
        readonly id: string;
        readonly digest?: string;
        readonly createdAt?: string;
      } =>
        typeof artifact === "object" &&
        artifact !== null &&
        typeof (artifact as { id?: unknown }).id === "string",
    )
    .map((artifact) => ({
      id: artifact.id,
      digest: typeof artifact.digest === "string" ? artifact.digest : null,
      createdAt: typeof artifact.createdAt === "string" ? artifact.createdAt : "",
    }));
}

function warningsOf(execution: Execution, verification: readonly VerificationResult[]): string[] {
  const warnings: string[] = [];
  const inconclusive = verification.filter((result) => result.status === "INCONCLUSIVE").length;
  if (inconclusive > 0) {
    warnings.push(`${inconclusive} verification result(s) were INCONCLUSIVE`);
  }
  if (execution.status === "FAILED") {
    warnings.push("execution failed (see events for the failure envelope)");
  }
  return warnings;
}

/** A scope-checked miss: 404, indistinguishable from missing (M1). */
function notFound(message: string): PublicValidationError {
  return new PublicValidationError("CAPABILITY_UNAVAILABLE", message, 404);
}
