/**
 * Execution outcome telemetry (learning module domain; WORK-014 / LRN-001,
 * TOL-003, INT-006; `spec/architecture.md` §19, ADR-0005).
 *
 * THE OBSERVATION MODEL. An `ExecutionOutcomeTelemetry` datum is the
 * immutable, closed-shape record of ONE terminal execution's observed
 * outcome — the single seed of every learned fact in the platform:
 *
 * ```text
 *   Execution (authority: /executions)
 *     → observed outcome + evidence (receipt / verification results)
 *       → THIS telemetry datum (observation, learning-owned)
 *         → versioned scorecards / aggregates (learning-owned)
 *           → planning-consumable signal (READ by /planning, never authority)
 * ```
 *
 * TRACEABILITY IS PHYSICAL, NOT DOCUMENTED (M10/M11/M12 of the WORK-014
 * discrimination list):
 *  - `executionId` is MANDATORY and non-empty — an orphaned "model
 *    performance" fact with no source execution is UNREPRESENTABLE
 *    (fail-closed validation here; `learning.execution_telemetry` in
 *    migration 0009 binds the row to the executions module's canonical
 *    execution table with a
 *    composite FK `(execution_id, application_id)` exactly like the
 *    sandbox/verification stores);
 *  - `evidenceRefs` is MANDATORY and non-empty — every learned datum
 *    carries its durable evidence references (execution receipt /
 *    verification result ids) (CHECK `evidence_refs <> '[]'`);
 *  - `applicationId` + `tenantId` are MANDATORY — tenant identity is
 *    never dropped (composite FK to `applications.applications`).
 *
 * ONE AUTHORITATIVE OBSERVATION PER SOURCE EXECUTION (IDENTITY-IDEMPOTENCY
 * for the learning axis, `spec/contracts.md` "Idempotency response rule"):
 * the durable identity is `(execution_id)` — UNIQUE at the storage
 * boundary. Re-ingesting the same execution with the SAME request
 * fingerprint converges (replayed outcome); the same execution with a
 * DIFFERENT fingerprint fails closed with `IDEMPOTENCY_KEY_REUSED`
 * (the authoritative observation of one execution can never silently
 * fork into two conflicting "facts").
 *
 * The record vocabulary is provider-NEUTRAL by construction: routes cross
 * as opaque `{provider, model}` neutral strings exactly like the planning
 * `PlanStepRouteRef` and the policy restriction vocabulary (M18). The
 * outcome vocabulary mirrors the EXECUTION terminal states — the learning
 * axis OBSERVES them, it never owns them (M6: learning cannot change
 * execution state; it records what the execution authority already
 * decided).
 *
 * DETERMINISTICIZATION COMPATIBILITY (§11 of the Work Order, DTR future
 * WORK-021): `subgraphs` preserves per-subgraph identity
 * (`subgraphId`/`stepPath`/`computationType` — the planning module's
 * `SubgraphObservation` vocabulary) so future analysis can answer
 * "these N executions using model X followed the same subgraph". WORK-014
 * records the identity; it performs NO deterministicization and owns NO
 * promotion/rollout decision (M19).
 *
 * This file contains NO side effects and imports NO other module.
 */

import { PlatformError } from "../../../shared/errors";

/** Frozen telemetry record schema version (M13/M14 versioning anchor). */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * The observed outcome vocabulary — EXACTLY the execution terminal states
 * (`spec/contracts.md`), prefixed `execution-` to keep the learning axis
 * honest about what it observes. Learning never invents outcome classes
 * (provider/tool/verification success are SEPARATE recorded fields, never
 * conflated into this vocabulary).
 */
export const TELEMETRY_OUTCOMES = [
  "execution-completed",
  "execution-failed",
  "execution-cancelled",
  "execution-expired",
] as const;

export type TelemetryOutcome = (typeof TELEMETRY_OUTCOMES)[number];

export function isTelemetryOutcome(value: string): value is TelemetryOutcome {
  return (TELEMETRY_OUTCOMES as readonly string[]).includes(value);
}

/** A provider/model route observation — opaque NEUTRAL strings (M18). */
export interface RouteObservation {
  readonly provider: string;
  readonly model: string;
}

/** Verification observations recorded alongside the outcome (VER axis). */
export interface VerificationObservation {
  /** Durable verification result ids bound to the execution. */
  readonly resultIds: readonly string[];
  /** Observed statuses, one per result id (PASS | FAIL | INCONCLUSIVE). */
  readonly statuses: readonly string[];
  /** Evaluator identities (kind:id@version) that produced the results. */
  readonly evaluatorIds: readonly string[];
  /** Count of PASS results (integer, not float-derived). */
  readonly passCount: number;
  /** Count of FAIL results. */
  readonly failCount: number;
  /** Count of INCONCLUSIVE results. */
  readonly inconclusiveCount: number;
  /**
   * Honest verification rollup: `true` when ≥1 PASS and 0 FAIL,
   * `false` when ≥1 FAIL, `null` when no results / only INCONCLUSIVE.
   * INCONCLUSIVE is NEVER coerced to true (the WORK-013 rule).
   */
  readonly verified: boolean | null;
}

/**
 * Per-subgraph observation preserved for future deterministicization
 * discovery (DTR-001/DTR-004 identity only — WORK-021 owns the analysis).
 */
export interface SubgraphTelemetryObservation {
  readonly subgraphId: string;
  readonly stepPath: readonly string[];
  readonly computationType: string;
}

/** The immutable execution outcome observation (migration 0009 shape). */
export interface ExecutionOutcomeTelemetry {
  readonly telemetryId: string;
  /** Source execution — MANDATORY (M10). */
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Task class / kind identity (the planning `TaskKind` string). */
  readonly taskClass: string;
  /** Digest of the task profile that produced the plan (may be absent). */
  readonly taskProfileDigest?: string;
  /** Context strategy identity used (may be absent). */
  readonly contextStrategy?: string;
  /** Capability ids the plan resolved. */
  readonly capabilities: readonly string[];
  /** Content-addressed plan identity (M: plan/revision identity). */
  readonly planId: string;
  readonly planRevision: number;
  /** Strategy class of the executed plan (may be absent pre-WORK-009). */
  readonly strategyClass?: string;
  /** Route observations (opaque provider/model strings). */
  readonly routes: readonly RouteObservation[];
  /** Tool identities invoked. */
  readonly tools: readonly string[];
  /** Compute-environment identities/kinds used. */
  readonly environments: readonly string[];
  /** Verification observations (VER axis, never conflated with outcome). */
  readonly verification: VerificationObservation;
  /** Observed cost — integer micro-USD string (never a float). */
  readonly costMicroUsd: string;
  /** Observed wall latency — non-negative integer milliseconds. */
  readonly latencyMs: number;
  /** The observed execution outcome (terminal-state vocabulary). */
  readonly outcome: TelemetryOutcome;
  /** Timestamp the observation was recorded (RFC 3339). */
  readonly recordedAt: string;
  /** Evidence references — MANDATORY, non-empty (M11). */
  readonly evidenceRefs: readonly string[];
  /** Subgraph identity observations (DTR future-proofing). */
  readonly subgraphs: readonly SubgraphTelemetryObservation[];
  /** The telemetry record schema version of this datum. */
  readonly schemaVersion: number;
}

const MICRO_USD_INT = /^\d{1,19}$/;
const NONEMPTY_STRING = /^.{1,256}$/;
const OUTCOME_STATUS = /^(PASS|FAIL|INCONCLUSIVE)$/;
const SUBGRAPH_COMPUTATION_TYPES = [
  "deterministic",
  "generative",
  "hybrid",
  "retrieval",
  "tool",
  "human",
  "verification",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(container: Record<string, unknown>, key: string, what: string): string {
  const value = container[key];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `telemetry ${what} must be a non-empty string (max 256)`,
      details: { field: key },
    });
  }
  return value;
}

function requireStringArray(
  container: Record<string, unknown>,
  key: string,
  what: string,
): readonly string[] {
  const value = container[key];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `telemetry ${what} must be an array of non-empty strings`,
      details: { field: key },
    });
  }
  return value as readonly string[];
}

function optionalString(
  container: Record<string, unknown>,
  key: string,
  what: string,
): string | undefined {
  const value = container[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `telemetry ${what} must be a non-empty string when present`,
      details: { field: key },
    });
  }
  return value;
}

/**
 * Closed-shape validation of a telemetry datum. Fails closed with typed
 * `PROVIDER_ERROR` (the module-domain validation convention of the
 * planner/verification records): every mandatory traceability field must
 * be present — M10 (source execution), M11 (evidence refs), M12 (tenant
 * identity) are unrepresentable-as-absent, not merely discouraged.
 */
export function validateExecutionTelemetry(
  value: unknown,
): asserts value is ExecutionOutcomeTelemetry {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "telemetry must be an object" });
  }
  const datum = value;

  requireString(datum, "telemetryId", "telemetryId");
  // M10: the source execution binding is mandatory.
  requireString(datum, "executionId", "executionId (source execution binding, M10)");
  requireString(datum, "applicationId", "applicationId");
  requireString(datum, "tenantId", "tenantId (tenant scope, M12)");
  requireString(datum, "taskClass", "taskClass");
  optionalString(datum, "taskProfileDigest", "taskProfileDigest");
  optionalString(datum, "contextStrategy", "contextStrategy");
  requireStringArray(datum, "capabilities", "capabilities");
  requireString(datum, "planId", "planId");
  const planRevision = datum.planRevision;
  if (typeof planRevision !== "number" || !Number.isInteger(planRevision) || planRevision < 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry planRevision must be an integer >= 1",
      details: { field: "planRevision" },
    });
  }
  optionalString(datum, "strategyClass", "strategyClass");
  requireStringArray(datum, "tools", "tools");
  requireStringArray(datum, "environments", "environments");

  const routes = datum.routes;
  if (!Array.isArray(routes)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry routes must be an array",
      details: { field: "routes" },
    });
  }
  for (const route of routes) {
    if (!isRecord(route)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "each telemetry route must be an object with neutral provider/model strings",
        details: { field: "routes" },
      });
    }
    requireString(route, "provider", "route provider");
    requireString(route, "model", "route model");
  }

  const verification = datum.verification;
  if (!isRecord(verification)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry verification must be an observation object",
      details: { field: "verification" },
    });
  }
  const resultIds = requireStringArray(verification, "resultIds", "verification resultIds");
  const statuses = requireStringArray(verification, "statuses", "verification statuses");
  if (statuses.some((status) => !OUTCOME_STATUS.test(status))) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry verification statuses must be PASS | FAIL | INCONCLUSIVE",
      details: { field: "verification.statuses" },
    });
  }
  if (resultIds.length !== statuses.length) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry verification resultIds and statuses must align one-to-one",
      details: { field: "verification" },
    });
  }
  requireStringArray(verification, "evaluatorIds", "verification evaluatorIds");
  for (const key of ["passCount", "failCount", "inconclusiveCount"] as const) {
    const count = verification[key];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `telemetry verification ${key} must be a non-negative integer`,
        details: { field: `verification.${key}` },
      });
    }
  }
  if (verification.verified !== null && typeof verification.verified !== "boolean") {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry verification verified must be boolean or null (never coerced)",
      details: { field: "verification.verified" },
    });
  }

  const costMicroUsd = datum.costMicroUsd;
  if (typeof costMicroUsd !== "string" || !MICRO_USD_INT.test(costMicroUsd)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry costMicroUsd must be an integer micro-USD string",
      details: { field: "costMicroUsd" },
    });
  }
  const latencyMs = datum.latencyMs;
  if (typeof latencyMs !== "number" || !Number.isInteger(latencyMs) || latencyMs < 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry latencyMs must be a non-negative integer",
      details: { field: "latencyMs" },
    });
  }

  const outcome = datum.outcome;
  if (typeof outcome !== "string" || !isTelemetryOutcome(outcome)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry outcome must be an execution terminal-state observation",
      details: { field: "outcome", allowed: TELEMETRY_OUTCOMES },
    });
  }

  requireString(datum, "recordedAt", "recordedAt");

  // M11: evidence references are mandatory and non-empty.
  const evidenceRefs = requireStringArray(datum, "evidenceRefs", "evidenceRefs");
  if (evidenceRefs.length === 0) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "telemetry evidenceRefs must be non-empty (every learned datum carries evidence, M11)",
      details: { field: "evidenceRefs" },
    });
  }

  const subgraphs = datum.subgraphs;
  if (!Array.isArray(subgraphs)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry subgraphs must be an array (may be empty)",
      details: { field: "subgraphs" },
    });
  }
  for (const subgraph of subgraphs) {
    if (!isRecord(subgraph)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "each telemetry subgraph observation must be an object",
        details: { field: "subgraphs" },
      });
    }
    requireString(subgraph, "subgraphId", "subgraph subgraphId");
    const stepPath = subgraph.stepPath;
    if (
      !Array.isArray(stepPath) ||
      stepPath.some((step) => typeof step !== "string" || !NONEMPTY_STRING.test(step))
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "subgraph stepPath must be an array of step ids",
        details: { field: "subgraphs.stepPath" },
      });
    }
    const computationType = subgraph.computationType;
    if (
      typeof computationType !== "string" ||
      !(SUBGRAPH_COMPUTATION_TYPES as readonly string[]).includes(computationType)
    ) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "subgraph computationType must be the planning computation vocabulary",
        details: { field: "subgraphs.computationType", allowed: SUBGRAPH_COMPUTATION_TYPES },
      });
    }
  }

  const schemaVersion = datum.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "telemetry schemaVersion must be a positive integer (M13/M14 version anchor)",
      details: { field: "schemaVersion" },
    });
  }
}

/**
 * The canonical fingerprint basis of a telemetry datum: everything EXCEPT
 * the assigned `telemetryId` and `recordedAt` (identity and wall-clock are
 * not observation content). The service digests this canonical form —
 * identical re-observations of the same execution converge, conflicting
 * re-observations fail closed (`IDEMPOTENCY_KEY_REUSED`).
 */
export function telemetryFingerprintBasis(
  datum: Omit<ExecutionOutcomeTelemetry, "telemetryId" | "recordedAt">,
): Readonly<Record<string, unknown>> {
  return {
    executionId: datum.executionId,
    applicationId: datum.applicationId,
    tenantId: datum.tenantId,
    taskClass: datum.taskClass,
    taskProfileDigest: datum.taskProfileDigest ?? null,
    contextStrategy: datum.contextStrategy ?? null,
    capabilities: [...datum.capabilities],
    planId: datum.planId,
    planRevision: datum.planRevision,
    strategyClass: datum.strategyClass ?? null,
    routes: datum.routes.map((route) => ({ provider: route.provider, model: route.model })),
    tools: [...datum.tools],
    environments: [...datum.environments],
    verification: {
      resultIds: [...datum.verification.resultIds],
      statuses: [...datum.verification.statuses],
      evaluatorIds: [...datum.verification.evaluatorIds],
      passCount: datum.verification.passCount,
      failCount: datum.verification.failCount,
      inconclusiveCount: datum.verification.inconclusiveCount,
      verified: datum.verification.verified,
    },
    costMicroUsd: datum.costMicroUsd,
    latencyMs: datum.latencyMs,
    outcome: datum.outcome,
    evidenceRefs: [...datum.evidenceRefs],
    subgraphs: datum.subgraphs.map((subgraph) => ({
      subgraphId: subgraph.subgraphId,
      stepPath: [...subgraph.stepPath],
      computationType: subgraph.computationType,
    })),
    schemaVersion: datum.schemaVersion,
  };
}
