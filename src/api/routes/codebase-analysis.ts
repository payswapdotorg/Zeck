/**
 * Codebase-analysis routes (WORK-022 / DTR-005, HUM-001..003;
 * M1/M2/M3/M8..M16 of the Work Order's discrimination list).
 *
 * ANALYSIS IS AN EXECUTION (the Work Order's architecture invariant):
 * every POST /codebase-analysis FIRST creates a real execution through
 * the executions AUTHORITY (`createExecution` — request-idempotent,
 * provider-selection-free) and drives it through the REAL single write
 * path (`authorize` — POLICY ADMISSION through the REQUIRED
 * authorization port — then plan/queue/start), and ONLY THEN runs the
 * learning module's advisory analyzer. The analysis runs while the
 * execution is RUNNING and completes through `verify` -> `pass` with
 * the durable verification result binding the analysis digest. A
 * policy denial at `authorize` fails the route with `POLICY_DENIED`
 * BEFORE any learning row is written (M2/M4: unapproved analysis is
 * denied before side effects). The API layer is transport-only: each
 * step delegates to an authority; no state is written directly.
 *
 * TENANT/SCOPE (M1/M26): the scope is derived server-side per request;
 * every read resolves through the analyzer's application-scoped
 * getters (cross-tenant lookups are indistinguishable from missing —
 * 404, never another tenant's data).
 *
 * IDEMPOTENCY: POST routes REQUIRE an Idempotency-Key header. The
 * analysis execution converges on the key (the executions authority's
 * (application, operation, key, fingerprint) arbitration); the
 * analysis row converges on the execution binding; ratings converge
 * on (finding, rater, question); transitions converge on the
 * content-derived transition identity.
 *
 * READ-ONLY BY DEFAULT (§5): the analyzer READS the caller-supplied
 * selected subgraph and EMITS advisory findings. No route mutates
 * customer code, deploys replacements or promotes anything (§18: the
 * transition route advances advisory -> candidate -> verified only,
 * with evidence — 'promoted' does not exist on this surface).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ScopeResolver } from "../../modules/auth/public";
import type { ExecutionService, ExecutionTransitionCommand } from "../../modules/executions/public";
import type { SelectedSubgraph } from "../../modules/learning/public";
import {
  buildExecutionGraph,
  EVALUATION_QUESTION_KINDS,
  EVALUATION_RATING_ANSWERS,
  EVALUATION_RATING_SCHEMA_VERSION,
  FINDING_STATES,
  FINDING_TRANSITION_EVIDENCE_KINDS,
  type OpportunityAnalyzer,
} from "../../modules/learning/public";
import { PlatformError } from "../../shared/errors";
import type {
  CodebaseAnalysisReport,
  CodebaseFindingTransitionReceipt,
  CodebaseRatingReceipt,
} from "../../shared/wire";
import { mapErrorToResponse, PublicValidationError } from "../error-mapper";
import type { Authenticate, RequestIdentity } from "../request-identity";
import { requireStringField, resolveRequestIdentity } from "../request-identity";
import {
  toWireCodebaseAnalysisReport,
  toWireCodebaseFindingTransitionReceipt,
  toWireCodebaseRatingReceipt,
} from "../serialization";

export interface CodebaseAnalysisRoutesDeps {
  readonly executions: ExecutionService;
  readonly analyzer: OpportunityAnalyzer;
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

function applicationHeaderOf(request: { readonly headers: Record<string, unknown> }): string {
  const value = request.headers["x-zeck-application"];
  if (typeof value !== "string" || value.length === 0) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      "codebase-analysis routes require the X-Zeck-Application header (the application whose scope authorizes the operation)",
    );
  }
  return value;
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

/** A scope-checked miss: another application's/tenant's row is indistinguishable from a missing one (M1 — 404, no leak). */
function notFound(message: string): PublicValidationError {
  return new PublicValidationError("CAPABILITY_UNAVAILABLE", message, 404);
}

/** A closed-vocabulary body field (fail closed — 422). */
function requireOneOf(
  container: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string {
  const value = container[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request field "${key}" must be one of: ${allowed.join(", ")}`,
    );
  }
  return value;
}

/**
 * The analyzer's domain verdicts are REQUEST-SEMANTICS failures (the
 * learning module's `PROVIDER_ERROR` usage is validation/legality
 * only — it performs no external calls): at the transport boundary
 * they surface as 422 CAPABILITY_UNAVAILABLE, never as a 502 provider
 * outage. Non-validation codes (e.g. IDEMPOTENCY_KEY_REUSED) keep
 * their canonical mapping.
 */
function mapAnalyzerError(error: unknown): unknown {
  if (error instanceof PlatformError && error.code === "PROVIDER_ERROR") {
    return new PublicValidationError("CAPABILITY_UNAVAILABLE", error.message);
  }
  return error;
}

/** Invoke an analyzer call, surfacing its domain verdicts as 422s. */
async function mapAnalyzerCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw mapAnalyzerError(error);
  }
}

const CREATE_REQUEST_KEYS: readonly string[] = ["applicationId", "source", "subgraph", "friction"];

const RATING_REQUEST_KEYS: readonly string[] = [
  "applicationId",
  "findingId",
  "counterpartFindingId",
  "promptId",
  "rater",
  "questionKind",
  "answer",
  "confidence",
  "rationale",
  "evidenceRefs",
  "submittedVia",
];

const TRANSITION_REQUEST_KEYS: readonly string[] = [
  "applicationId",
  "toState",
  "evidenceKind",
  "evidenceRefs",
  "verifiedEquivalence",
];

/** An optional nullable string field: absent or null -> null; present -> non-empty string. */
function optionalNullableStringField(
  container: Record<string, unknown>,
  key: string,
): string | null {
  const value = container[key];
  if (value === undefined || value === null) {
    return null;
  }
  return requireStringField(container, key);
}

function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unknownKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknownKeys.length > 0) {
    // Fail closed: unknown keys are REJECTED (the create-contract
    // vocabulary rule — a client tenant/provider injection is
    // unrepresentable).
    throw new PublicValidationError(
      "CAPABILITY_UNAVAILABLE",
      `request contains unknown keys (the contract is closed): ${unknownKeys.join(", ")}`,
    );
  }
}

/**
 * The verification result that binds the analysis receipt to the
 * completed execution (the completion rule: every COMPLETED execution
 * is bound to durable verification evidence).
 */
function analysisReceiptVerification(analysisDigest: string): {
  readonly criterionId: string;
  readonly strategy: string;
  readonly status: "PASS";
  readonly recordedBy: string;
  readonly evidence: readonly string[];
} {
  return {
    criterionId: "codebase-analysis-receipt",
    strategy: "analysis-digest-binding",
    status: "PASS",
    recordedBy: "api:codebase-analysis",
    evidence: [analysisDigest],
  };
}

export function registerCodebaseAnalysisRoutes(
  app: FastifyInstance,
  deps: CodebaseAnalysisRoutesDeps,
): void {
  // POST /codebase-analysis — the governed advisory analysis.
  app.post("/codebase-analysis", async (request, reply) => {
    try {
      const idempotencyKey = requireIdempotencyKey(request);
      if (
        typeof request.body !== "object" ||
        request.body === null ||
        Array.isArray(request.body)
      ) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          "request body must be a JSON object",
        );
      }
      const body = request.body as Record<string, unknown>;
      rejectUnknownKeys(body, CREATE_REQUEST_KEYS);
      const applicationId = requireStringField(body, "applicationId");
      const source = requireObjectField(body, "source");
      const repository = requireStringField(source, "repository");
      const revision = requireStringField(source, "revision");
      const subgraph = requireObjectField(body, "subgraph");
      const frictionRaw = body.friction === undefined ? {} : requireObjectField(body, "friction");
      const friction: Record<string, unknown> = {
        userFrictionThreshold: frictionRaw.userFrictionThreshold,
        maxPrompts: frictionRaw.maxPrompts,
      };
      // PRE-VALIDATION (pure, no side effects): the selected subgraph is
      // validated against the learning module's closed execution-graph
      // contract BEFORE any execution is created — a malformed selection
      // (missing provenance, mixed revisions, unknown kinds) fails closed
      // with 422 and leaves NO row anywhere (M11/M12/M27/M28 fail before
      // side effects). The analyzer re-validates on the same contract.
      try {
        buildExecutionGraph({
          ...(subgraph as unknown as SelectedSubgraph),
          source: { repository, revision },
        });
      } catch (error) {
        if (error instanceof PublicValidationError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "invalid subgraph";
        throw new PublicValidationError("CAPABILITY_UNAVAILABLE", `invalid subgraph: ${message}`);
      }
      const identity: RequestIdentity = await resolveRequestIdentity(
        request,
        reply,
        deps.authenticate,
        deps.scopeResolver,
        applicationId,
      );
      const actor = { actorId: identity.principal.actorId, tenantId: identity.scope.tenantId };

      // 1. THE ANALYSIS EXECUTION — created through the executions
      //    authority (request-idempotent, provider-selection-free).
      const receipt = await deps.executions.createExecution(
        {
          applicationId,
          task: {
            kind: "codebase-analysis",
            repository,
            revision,
          },
        },
        idempotencyKey,
        actor,
      );
      const executionId = receipt.executionId;
      const transitionKey = (command: string) => `${command}:${idempotencyKey}`;
      const commandOf = (command: string): ExecutionTransitionCommand =>
        ({
          command,
          applicationId,
          tenantId: identity.scope.tenantId,
          executionId,
          actorId: identity.principal.actorId,
        }) as ExecutionTransitionCommand;

      // 2. POLICY ADMISSION FIRST (M2/M4: "Analysis is an Execution" —
      //    policy and tenant scope are evaluated before codebase
      //    access). A denial fails closed here: NO learning row is
      //    ever written.
      await deps.executions.transition(commandOf("authorize"), transitionKey("authorize"));
      // 3. The real lifecycle to RUNNING (the single write path).
      for (const command of ["plan", "queue", "start"] as const) {
        await deps.executions.transition(commandOf(command), transitionKey(command));
      }

      // 4. THE ANALYSIS (advisory, read-only, execution-bound).
      const analysis = await deps.analyzer.analyzeSubgraph({
        applicationId,
        tenantId: identity.scope.tenantId,
        executionId,
        source: { repository, revision },
        subgraph: subgraph as never,
        friction:
          friction.userFrictionThreshold === undefined && friction.maxPrompts === undefined
            ? undefined
            : (friction as never),
      });

      // 5. Completion through verification (the completion rule): the
      //    durable verification result binds the analysis digest.
      await deps.executions.transition(commandOf("verify"), transitionKey("verify"));
      await deps.executions.transition(
        {
          command: "pass",
          applicationId,
          tenantId: identity.scope.tenantId,
          executionId,
          actorId: identity.principal.actorId,
          verificationResults: [analysisReceiptVerification(analysis.analysis.digest)],
        },
        transitionKey("pass"),
      );

      const report: CodebaseAnalysisReport = toWireCodebaseAnalysisReport({
        analysis: analysis.analysis,
        findings: analysis.findings,
        prompts: analysis.prompts,
        replayed: analysis.replayed,
      });
      return reply.status(201).send(report);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  const identityFor = async (
    request: FastifyRequest,
    reply: FastifyReply,
    applicationId: string,
  ): Promise<RequestIdentity> =>
    resolveRequestIdentity(request, reply, deps.authenticate, deps.scopeResolver, applicationId);

  // The scope-checked analyzer read shared by every
  // /codebase-analysis/:id route: a cross-tenant analysis is
  // indistinguishable from a missing one (M1/M26: 404, never another
  // tenant's data).
  const scopeCheckedAnalysis = async (
    request: FastifyRequest,
    reply: FastifyReply,
    applicationId: string,
  ) => {
    const identity = await identityFor(request, reply, applicationId);
    const analysisId = requireStringField(request.params as Record<string, unknown>, "id");
    try {
      const report = await deps.analyzer.getAnalysis({
        applicationId,
        tenantId: identity.scope.tenantId,
        analysisId,
      });
      return { identity, analysisId, report };
    } catch (error) {
      if (error instanceof PlatformError && error.message.includes("analysis not found")) {
        throw notFound("analysis not found");
      }
      throw error;
    }
  };

  const loadReport = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<CodebaseAnalysisReport> => {
    const applicationId = applicationHeaderOf(request);
    const { report } = await scopeCheckedAnalysis(request, reply, applicationId);
    return toWireCodebaseAnalysisReport({
      analysis: report.analysis,
      findings: report.findings,
      prompts: report.prompts,
      replayed: false,
    });
  };

  // GET /codebase-analysis/:id — the advisory report (findings + prompts).
  app.get("/codebase-analysis/:id", async (request, reply) => {
    try {
      const report = await loadReport(request, reply);
      return reply.send(report);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // POST /codebase-analysis/:id/ratings — immutable evaluation evidence.
  app.post("/codebase-analysis/:id/ratings", async (request, reply) => {
    try {
      requireIdempotencyKey(request);
      if (
        typeof request.body !== "object" ||
        request.body === null ||
        Array.isArray(request.body)
      ) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          "request body must be a JSON object",
        );
      }
      const body = request.body as Record<string, unknown>;
      rejectUnknownKeys(body, RATING_REQUEST_KEYS);
      const applicationId = requireStringField(body, "applicationId");
      const identity = await identityFor(request, reply, applicationId);
      const analysisId = requireStringField(request.params as Record<string, unknown>, "id");
      const findingId = requireStringField(body, "findingId");
      const rater = requireStringField(body, "rater");
      // Closed vocabularies at the transport boundary (the domain
      // validators are the second, identical gate).
      const questionKind = requireOneOf(body, "questionKind", [...EVALUATION_QUESTION_KINDS]);
      const answer = requireOneOf(body, "answer", [...EVALUATION_RATING_ANSWERS]);
      const evidenceRefsRaw = body.evidenceRefs;
      if (
        !Array.isArray(evidenceRefsRaw) ||
        evidenceRefsRaw.length === 0 ||
        evidenceRefsRaw.some((ref) => typeof ref !== "string" || ref.length === 0)
      ) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          'request field "evidenceRefs" must be a non-empty array of strings (what the rater examined)',
        );
      }
      const submittedVia =
        body.submittedVia === undefined
          ? "api:codebase-analysis"
          : requireStringField(body, "submittedVia");

      // Resolve the finding (scope-checked) so the rating binds to the
      // analysis execution + revision + context (§14 — the route
      // DERIVES the binding, the caller cannot assert it).
      const { report } = await scopeCheckedAnalysis(request, reply, applicationId);
      const finding = report.findings.find((candidate) => candidate.findingId === findingId);
      if (finding === undefined) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          "finding not found within the analysis",
        );
      }
      const rating = await mapAnalyzerCall(() =>
        deps.analyzer.recordEvaluationRating({
          applicationId,
          tenantId: identity.scope.tenantId,
          analysisId,
          findingId,
          counterpartFindingId: optionalNullableStringField(body, "counterpartFindingId"),
          executionId: report.analysis.executionId,
          promptId: optionalNullableStringField(body, "promptId"),
          rater,
          questionKind: questionKind as never,
          answer: answer as never,
          confidence: body.confidence === undefined ? undefined : (body.confidence as number),
          rationale: body.rationale === undefined ? undefined : (body.rationale as string),
          sourceRevision: finding.provenance.revision,
          context: {
            repository: finding.provenance.repository,
            targetNodeIds: [...finding.targetNodeIds],
            findingClass: finding.class,
            population: finding.confidence.population,
          },
          evidenceRefs: [...evidenceRefsRaw] as string[],
          provenance: { submittedVia },
          schemaVersion: EVALUATION_RATING_SCHEMA_VERSION,
        }),
      );
      const receipt: CodebaseRatingReceipt = toWireCodebaseRatingReceipt(rating);
      return reply.status(201).send(receipt);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });

  // POST /codebase-analysis/:id/findings/:findingId/transition — the
  // evidence-gated advisory -> candidate -> verified advance (§18: no
  // 'promoted' exists on this surface; the promotion gate is external).
  app.post("/codebase-analysis/:id/findings/:findingId/transition", async (request, reply) => {
    try {
      requireIdempotencyKey(request);
      if (
        typeof request.body !== "object" ||
        request.body === null ||
        Array.isArray(request.body)
      ) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          "request body must be a JSON object",
        );
      }
      const body = request.body as Record<string, unknown>;
      rejectUnknownKeys(body, TRANSITION_REQUEST_KEYS);
      const applicationId = requireStringField(body, "applicationId");
      const identity = await identityFor(request, reply, applicationId);
      const findingId = requireStringField(request.params as Record<string, unknown>, "findingId");
      const toState = requireOneOf(body, "toState", [...FINDING_STATES]);
      const evidenceKind = requireOneOf(body, "evidenceKind", [
        ...FINDING_TRANSITION_EVIDENCE_KINDS,
      ]);
      const evidenceRefsRaw = body.evidenceRefs;
      if (
        !Array.isArray(evidenceRefsRaw) ||
        evidenceRefsRaw.length === 0 ||
        evidenceRefsRaw.some((ref) => typeof ref !== "string" || ref.length === 0)
      ) {
        throw new PublicValidationError(
          "CAPABILITY_UNAVAILABLE",
          'request field "evidenceRefs" must be a non-empty array of strings (the transition\'s evidence references)',
        );
      }
      const outcome = await mapAnalyzerCall(() =>
        deps.analyzer.advanceFinding({
          applicationId,
          tenantId: identity.scope.tenantId,
          findingId,
          toState,
          evidenceKind,
          evidenceRefs: [...evidenceRefsRaw] as string[],
          verifiedEquivalence: body.verifiedEquivalence,
          requestedBy: identity.principal.actorId,
        }),
      );
      const receipt: CodebaseFindingTransitionReceipt = toWireCodebaseFindingTransitionReceipt(
        outcome.transition,
        outcome.replayed,
      );
      return reply.status(201).send(receipt);
    } catch (error) {
      return mapErrorToResponse(reply, error);
    }
  });
}
