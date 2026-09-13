/**
 * The platform-side tenant-isolation driver (VAL-024).
 *
 * The isolation slice of the validation program: drives cross-tenant
 * access-control probe batteries through the REAL platform path. The
 * REAL PostgreSQL row-scoping (every store query bound by application +
 * tenant — the execution store's locked-row discipline) is the system
 * under test:
 *
 *   * the probe taxonomy as PURE derivations — the isolation probe
 *     families the corpus exercises (cross-tenant reads, transitions,
 *     artifact/evidence fetches, step-event and planning-decision
 *     journaling attempts, cross-application state probes, forged
 *     scope headers and the control row), each mapped to its concrete
 *     probe plan: the operation attempted, the foreign reference
 *     channel and the EXPECTED typed rejection (TENANT_SCOPE_VIOLATION
 *     for the locked-row checks; the scope-checked miss — zero rows,
 *     never data — for reads; AUTHORIZATION_DENIED for the forged
 *     application scope the server-side resolver refuses);
 *   * the typed-rejection matcher and the foreign-content evidence
 *     scan as PURE derivations — every probe observation is matched
 *     against the plan's expected rejection, and no FOREIGN content
 *     marker (the other tenant's planted canary material) may appear
 *     in ANY evidence field (findings carry the marker LABEL, never
 *     the material);
 *   * the row-count invariants as PURE derivations — the foreign
 *     application's durable rows must be IDENTICAL before and after
 *     the battery (zero foreign effects), and the own application's
 *     delta must equal EXACTLY the driver's accounted journal writes
 *     (a probe that wrote anything surfaces as an unaccounted write);
 *   * the probe battery driver mirroring the VAL-021/022 drivers
 *     (authorize → plan → planning-decision BEFORE the battery →
 *     queue → start → the probe battery → the row-count window →
 *     verify → terminal: any admitted probe, any leaked content, any
 *     unaccounted write, any journal duplication → FAILED — never a
 *     partial-success shortcut), journaling each probe EXACTLY once
 *     through the platform's OWN step-event vocabulary
 *     (`agent-action-recorded` with digest references only).
 *
 * Honesty invariants:
 *   * the probes exercise the REAL platform path — the executions
 *     service surface (the locked-row checks) and the public wire
 *     family (the server-side scope derivation) are SEAM-INJECTED
 *     here (the lab contract); the integration seam binds the REAL
 *     service, the REAL public API over the REAL SQL authorities and
 *     the REAL SQL row counts;
 *   * the isolation probes need NO provider (the scope checks are
 *     pre-dispatch): a denied probe never dispatches a model, never
 *     executes a tool, never writes a durable row (rollback covers
 *     the arbitration inserts);
 *   * usage is honestly "none" (no provider dispatch — pre-dispatch
 *     scope checks) and per-probe latency is measured, never
 *     estimated;
 *   * evidence carries request DIGESTS, never payload bytes, never
 *     the other tenant's content (the mechanical scan enforces it).
 */

import type { LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

export function isolationDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The probe taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

/**
 * The isolation probe families the corpus exercises (the work order's
 * own vocabulary: cross-tenant read, cross-tenant transition,
 * cross-tenant artifact fetch, cross-application state probe —
 * extended with the create-path probes, the journaling-path probes,
 * the forged-scope family and the false-positive control).
 */
export const ISOLATION_PROBES = [
  "cross-tenant:create-application",
  "cross-tenant:create-environment",
  "cross-tenant:read",
  "cross-tenant:transition",
  "cross-tenant:artifact-fetch",
  "cross-tenant:step-event",
  "cross-tenant:planning-decision",
  "cross-application:state-probe",
  "cross-tenant:forged-scope",
  "control:healthy",
] as const;

export type IsolationProbeKind = (typeof ISOLATION_PROBES)[number];

/** The typed rejection codes the platform surfaces (the public taxonomy). */
export const ISOLATION_REJECTION_CODES = [
  "TENANT_SCOPE_VIOLATION",
  "AUTHORIZATION_DENIED",
  "CAPABILITY_UNAVAILABLE",
] as const;

export type IsolationRejectionCode = (typeof ISOLATION_REJECTION_CODES)[number];

/**
 * The per-row declared rejection summary (AC1: the corpus declares,
 * per row, the isolation probe and the expected typed rejection):
 * `SCOPE_CHECKED_MISS` = the zero-rows boundary (never data);
 * `OWN_SCOPE_DATA` = the control row's legitimate admission;
 * `NOT_APPLICABLE` = the surface carries no probe for this row.
 */
export type IsolationRejectionSummary =
  | IsolationRejectionCode
  | "SCOPE_CHECKED_MISS"
  | "OWN_SCOPE_DATA"
  | "NOT_APPLICABLE";

/** The expected outcome of ONE planned probe. */
export type IsolationExpectedOutcome =
  | {
      /** The platform's typed error code, never data. */
      readonly kind: "typed-error";
      readonly code: IsolationRejectionCode;
      /** The wire HTTP status (wire surface); null on the service surface. */
      readonly httpStatus: number | null;
    }
  /** The scope-checked miss: zero rows, a null record — never data. */
  | { readonly kind: "zero-rows" }
  /** The control row's legitimate own-scope admission (data allowed). */
  | { readonly kind: "own-scope-data" };

/** The surface one probe rides: the public wire or the executions service. */
export type IsolationProbeSurface = "wire" | "service";

/** The operation one probe attempts. */
export type IsolationProbeOperation =
  | "createExecution"
  | "getExecution"
  | "cancelExecution"
  | "getResult"
  | "listEvents"
  | "listVerification"
  | "transition"
  | "recordStepEvent"
  | "recordPlanningDecision";

/** The foreign reference channel one probe targets. */
export type IsolationProbeReference =
  | "foreign-execution"
  | "foreign-environment"
  | "foreign-application"
  | "forged-application-scope"
  | "own-execution"
  | "reverse-foreign-scope";

/** One planned probe: the operation, the reference and the expected rejection. */
export interface PlannedIsolationProbe {
  readonly probeId: string;
  readonly surface: IsolationProbeSurface;
  readonly operation: IsolationProbeOperation;
  readonly reference: IsolationProbeReference;
  readonly expected: IsolationExpectedOutcome;
}

/** The canonical rejection shapes (the REAL platform semantics, pinned). */
const TENANT_SCOPE_SERVICE = {
  kind: "typed-error",
  code: "TENANT_SCOPE_VIOLATION",
  httpStatus: null,
} as const;
const TENANT_SCOPE_WIRE = {
  kind: "typed-error",
  code: "TENANT_SCOPE_VIOLATION",
  httpStatus: 403,
} as const;
const AUTH_DENIED_WIRE = {
  kind: "typed-error",
  code: "AUTHORIZATION_DENIED",
  httpStatus: 403,
} as const;
const MISS_WIRE = { kind: "typed-error", code: "CAPABILITY_UNAVAILABLE", httpStatus: 404 } as const;
const ZERO_ROWS = { kind: "zero-rows" } as const;
const OWN_SCOPE_DATA = { kind: "own-scope-data" } as const;

/**
 * The concrete probe battery per probe kind (PURE). The plan mirrors the
 * REAL platform semantics: every locked-row path (transition, planning
 * decision, step event) rejects a foreign execution with
 * TENANT_SCOPE_VIOLATION (the store's application-scoped lock returns
 * no row) and a tenant-mismatched command with TENANT_SCOPE_VIOLATION
 * (the locked row's tenant wins); every read is a scope-checked miss
 * (zero rows, never data); the wire's create path carries the service's
 * typed violation for a foreign environment while the server-side
 * scope derivation refuses a foreign application (AUTHORIZATION_DENIED)
 * and the scope-checked miss maps to 404 CAPABILITY_UNAVAILABLE.
 */
export function planIsolationProbes(kind: IsolationProbeKind): readonly PlannedIsolationProbe[] {
  switch (kind) {
    case "cross-tenant:create-application":
      return [
        {
          probeId: "svc-create-foreign-application",
          surface: "service",
          operation: "createExecution",
          reference: "foreign-application",
          expected: TENANT_SCOPE_SERVICE,
        },
      ];
    case "cross-tenant:create-environment":
      return [
        {
          probeId: "svc-create-foreign-environment",
          surface: "service",
          operation: "createExecution",
          reference: "foreign-environment",
          expected: TENANT_SCOPE_SERVICE,
        },
        {
          probeId: "wire-create-foreign-environment",
          surface: "wire",
          operation: "createExecution",
          reference: "foreign-environment",
          expected: TENANT_SCOPE_WIRE,
        },
      ];
    case "cross-tenant:read":
      return [
        {
          probeId: "svc-read-foreign-execution",
          surface: "service",
          operation: "getExecution",
          reference: "foreign-execution",
          expected: ZERO_ROWS,
        },
        {
          probeId: "wire-read-foreign-execution",
          surface: "wire",
          operation: "getExecution",
          reference: "foreign-execution",
          expected: MISS_WIRE,
        },
      ];
    case "cross-tenant:transition":
      return [
        {
          probeId: "svc-transition-foreign-execution",
          surface: "service",
          operation: "transition",
          reference: "foreign-execution",
          expected: TENANT_SCOPE_SERVICE,
        },
        {
          probeId: "svc-transition-tenant-mismatch",
          surface: "service",
          operation: "transition",
          reference: "own-execution",
          expected: TENANT_SCOPE_SERVICE,
        },
        {
          probeId: "wire-cancel-foreign-execution",
          surface: "wire",
          operation: "cancelExecution",
          reference: "foreign-execution",
          expected: MISS_WIRE,
        },
      ];
    case "cross-tenant:artifact-fetch":
      return [
        {
          probeId: "svc-list-foreign-events",
          surface: "service",
          operation: "listEvents",
          reference: "foreign-execution",
          expected: ZERO_ROWS,
        },
        {
          probeId: "svc-list-foreign-verification",
          surface: "service",
          operation: "listVerification",
          reference: "foreign-execution",
          expected: ZERO_ROWS,
        },
        {
          probeId: "wire-result-foreign-execution",
          surface: "wire",
          operation: "getResult",
          reference: "foreign-execution",
          expected: MISS_WIRE,
        },
        {
          probeId: "wire-events-foreign-execution",
          surface: "wire",
          operation: "listEvents",
          reference: "foreign-execution",
          expected: MISS_WIRE,
        },
        {
          probeId: "wire-verification-foreign-execution",
          surface: "wire",
          operation: "listVerification",
          reference: "foreign-execution",
          expected: MISS_WIRE,
        },
      ];
    case "cross-tenant:step-event":
      return [
        {
          probeId: "svc-step-event-foreign-execution",
          surface: "service",
          operation: "recordStepEvent",
          reference: "foreign-execution",
          expected: TENANT_SCOPE_SERVICE,
        },
        {
          probeId: "svc-step-event-tenant-mismatch",
          surface: "service",
          operation: "recordStepEvent",
          reference: "own-execution",
          expected: TENANT_SCOPE_SERVICE,
        },
      ];
    case "cross-tenant:planning-decision":
      return [
        {
          probeId: "svc-planning-foreign-execution",
          surface: "service",
          operation: "recordPlanningDecision",
          reference: "foreign-execution",
          expected: TENANT_SCOPE_SERVICE,
        },
        {
          probeId: "svc-planning-tenant-mismatch",
          surface: "service",
          operation: "recordPlanningDecision",
          reference: "own-execution",
          expected: TENANT_SCOPE_SERVICE,
        },
      ];
    case "cross-application:state-probe":
      return [
        {
          probeId: "svc-read-foreign-execution",
          surface: "service",
          operation: "getExecution",
          reference: "foreign-execution",
          expected: ZERO_ROWS,
        },
        {
          probeId: "svc-read-reverse-foreign-scope",
          surface: "service",
          operation: "getExecution",
          reference: "reverse-foreign-scope",
          expected: ZERO_ROWS,
        },
        {
          probeId: "svc-list-foreign-events",
          surface: "service",
          operation: "listEvents",
          reference: "foreign-execution",
          expected: ZERO_ROWS,
        },
        {
          probeId: "svc-list-events-reverse-foreign-scope",
          surface: "service",
          operation: "listEvents",
          reference: "reverse-foreign-scope",
          expected: ZERO_ROWS,
        },
        {
          probeId: "svc-list-foreign-verification",
          surface: "service",
          operation: "listVerification",
          reference: "foreign-execution",
          expected: ZERO_ROWS,
        },
        {
          probeId: "wire-read-foreign-execution",
          surface: "wire",
          operation: "getExecution",
          reference: "foreign-execution",
          expected: MISS_WIRE,
        },
      ];
    case "cross-tenant:forged-scope":
      return [
        {
          probeId: "wire-forged-scope-read",
          surface: "wire",
          operation: "getExecution",
          reference: "forged-application-scope",
          expected: AUTH_DENIED_WIRE,
        },
        {
          probeId: "wire-create-foreign-application",
          surface: "wire",
          operation: "createExecution",
          reference: "foreign-application",
          expected: AUTH_DENIED_WIRE,
        },
      ];
    case "control:healthy":
      return [
        {
          probeId: "svc-control-read-own-execution",
          surface: "service",
          operation: "getExecution",
          reference: "own-execution",
          expected: OWN_SCOPE_DATA,
        },
        {
          probeId: "svc-control-list-own-events",
          surface: "service",
          operation: "listEvents",
          reference: "own-execution",
          expected: OWN_SCOPE_DATA,
        },
      ];
  }
}

/** The rejection summary one probe's expectation contributes to its row (PURE). */
export function rejectionSummaryOfOutcome(
  expected: IsolationExpectedOutcome,
): IsolationRejectionSummary {
  if (expected.kind === "typed-error") {
    return expected.code;
  }
  if (expected.kind === "zero-rows") {
    return "SCOPE_CHECKED_MISS";
  }
  return "OWN_SCOPE_DATA";
}

// ---------------------------------------------------------------------------
// The probe task (the app's submitted shape, validated pre-effect)
// ---------------------------------------------------------------------------

/** The task kind every corpus row's submission carries. */
export const ISOLATION_PROBE_TASK_KIND = "isolation-probe";

/** One submitted isolation-probe task (the app's public shape). */
export interface IsolationProbeTask {
  readonly kind: typeof ISOLATION_PROBE_TASK_KIND;
  readonly scenario: string;
  readonly probe: IsolationProbeKind;
}

/** The pre-effect validation verdict. */
export interface ProbeTaskValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

/**
 * Validate one isolation-probe task (PURE, pre-effect): the shape must be
 * an isolation-probe with a non-empty scenario and an in-vocabulary probe
 * kind. A violation is a platform-layer rejection BEFORE any probe effect.
 */
export function validateIsolationProbeTask(task: unknown): ProbeTaskValidation {
  if (task === null || typeof task !== "object") {
    return { valid: false, reason: "task must be an object" };
  }
  const record = task as { kind?: unknown; scenario?: unknown; probe?: unknown };
  if (record.kind !== ISOLATION_PROBE_TASK_KIND) {
    return {
      valid: false,
      reason: `task kind ${String(record.kind)} is outside the isolation-probe vocabulary`,
    };
  }
  if (typeof record.scenario !== "string" || record.scenario.length === 0) {
    return { valid: false, reason: "task.scenario must be a non-empty string" };
  }
  if (
    typeof record.probe !== "string" ||
    !ISOLATION_PROBES.includes(record.probe as IsolationProbeKind)
  ) {
    return {
      valid: false,
      reason: `task.probe ${String(record.probe)} is outside the isolation-probe-kind vocabulary`,
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// The typed-rejection matcher (PURE)
// ---------------------------------------------------------------------------

/** What one probe attempt actually observed. */
export interface ObservedProbeOutcome {
  readonly kind:
    | "typed-error"
    | "zero-rows"
    | "own-scope-data"
    | "unexpected-success"
    | "unexpected-error";
  /** The surfaced typed code (the platform's error taxonomy; null when none). */
  readonly code: string | null;
  /** The wire HTTP status (wire surface; null on the service surface). */
  readonly httpStatus: number | null;
  /** The sanitized boundary message (ids only, never foreign content). */
  readonly message: string;
}

/**
 * Match one observation against the plan's expected rejection (PURE).
 * An expected typed error matches ONLY the same code (and the wire
 * status when pinned); an expected scope-checked miss matches ONLY a
 * zero-rows observation; an expected own-scope admission matches ONLY
 * own-scope data. Anything else — an admission where a rejection was
 * expected, a rejection where own data was expected, a wrong code —
 * is a mechanical isolation failure.
 */
export function matchProbeObservation(
  expected: IsolationExpectedOutcome,
  observed: ObservedProbeOutcome,
): boolean {
  if (expected.kind === "typed-error") {
    if (observed.kind !== "typed-error" || observed.code !== expected.code) {
      return false;
    }
    if (expected.httpStatus !== null && observed.httpStatus !== expected.httpStatus) {
      return false;
    }
    return true;
  }
  if (expected.kind === "zero-rows") {
    return observed.kind === "zero-rows";
  }
  return observed.kind === "own-scope-data";
}

// ---------------------------------------------------------------------------
// The foreign-content evidence scan (PURE)
// ---------------------------------------------------------------------------

/**
 * The mechanical foreign-content scan: no foreign marker (the other
 * tenant's planted canary material — synthetic, never real content)
 * may appear in ANY evidence field. Findings carry the marker LABEL
 * and digest — never the material itself (the scan's own output
 * obeys the boundary it verifies).
 */
export function scanEvidenceForForeignContent(
  evidence: unknown,
  markers: readonly ForeignContentMarker[],
): { readonly clean: boolean; readonly findings: readonly string[] } {
  const text = JSON.stringify(evidence) ?? "null";
  const findings: string[] = [];
  for (const marker of markers) {
    if (marker.material.length > 0 && text.includes(marker.material)) {
      findings.push(`foreign-content-found:${marker.label} (digest ${marker.digest})`);
    }
  }
  return { clean: findings.length === 0, findings };
}

/** One synthetic foreign-content marker planted in the foreign world. */
export interface ForeignContentMarker {
  readonly label: string;
  readonly material: string;
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// The row-count invariants (PURE derivations)
// ---------------------------------------------------------------------------

/** The durable row counts of ONE application's world (per table). */
export interface WorldRowCounts {
  readonly executions: number;
  readonly executionEvents: number;
  readonly verificationResults: number;
  readonly idempotencyRecords: number;
}

/** One snapshot: the own and the foreign application's counts. */
export interface IsolationRowCountSnapshot {
  readonly ownApplication: WorldRowCounts;
  readonly foreignApplication: WorldRowCounts;
}

/** The accounted own-application writes the battery legitimately performs. */
export interface AccountedOwnWrites {
  readonly executionEvents: number;
  readonly idempotencyRecords: number;
}

/** The invariant derivation input. */
export interface RowCountInvariantInput {
  readonly before: IsolationRowCountSnapshot;
  readonly after: IsolationRowCountSnapshot;
  readonly accounted: AccountedOwnWrites;
}

/**
 * Derive the row-count invariant violations (PURE): the foreign
 * application's durable rows must be IDENTICAL before and after the
 * battery (zero foreign effects — a probe that created, transitioned
 * or journaled anything in the foreign world surfaces here), and the
 * own application's delta must equal EXACTLY the accounted journal
 * writes (an unaccounted own write is a mechanical isolation failure:
 * a probe that wrote anything it must not have).
 */
export function deriveRowCountViolations(input: RowCountInvariantInput): readonly string[] {
  const violations: string[] = [];
  const before = input.before.foreignApplication;
  const after = input.after.foreignApplication;
  for (const field of [
    "executions",
    "executionEvents",
    "verificationResults",
    "idempotencyRecords",
  ] as const) {
    if (before[field] !== after[field]) {
      violations.push(
        `foreign-application ${field} changed: ${before[field]} -> ${after[field]} (zero foreign effects required)`,
      );
    }
  }
  const ownBefore = input.before.ownApplication;
  const ownAfter = input.after.ownApplication;
  if (ownAfter.executions - ownBefore.executions !== 0) {
    violations.push(
      `own-application executions changed by ${ownAfter.executions - ownBefore.executions} (no probe may create an execution)`,
    );
  }
  if (ownAfter.executionEvents - ownBefore.executionEvents !== input.accounted.executionEvents) {
    violations.push(
      `own-application executionEvents delta ${ownAfter.executionEvents - ownBefore.executionEvents} != accounted ${input.accounted.executionEvents}`,
    );
  }
  if (ownAfter.verificationResults - ownBefore.verificationResults !== 0) {
    violations.push(
      `own-application verificationResults changed by ${ownAfter.verificationResults - ownBefore.verificationResults} (no probe writes verification rows)`,
    );
  }
  if (
    ownAfter.idempotencyRecords - ownBefore.idempotencyRecords !==
    input.accounted.idempotencyRecords
  ) {
    violations.push(
      `own-application idempotencyRecords delta ${ownAfter.idempotencyRecords - ownBefore.idempotencyRecords} != accounted ${input.accounted.idempotencyRecords}`,
    );
  }
  return violations;
}

// ---------------------------------------------------------------------------
// The probe seams (structurally the REAL surfaces; bound at the integration)
// ---------------------------------------------------------------------------

/**
 * The executions-service surface (structurally the REAL
 * `ExecutionService`): every method the battery probes. The REAL
 * locked-row semantics live in the binding; the driver only observes
 * (typed rejections thrown by the service, null records, empty lists).
 */
export interface IsolationExecutionsSurface {
  createExecution(
    input: {
      readonly applicationId: string;
      readonly environmentId?: string;
      readonly task: Readonly<Record<string, unknown>>;
      readonly metadata?: Readonly<Record<string, unknown>>;
    },
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly tenantId: string },
  ): Promise<unknown>;
  getExecution(applicationId: string, executionId: string): Promise<unknown | null>;
  listEvents(applicationId: string, executionId: string): Promise<readonly unknown[]>;
  listVerificationResults(applicationId: string, executionId: string): Promise<readonly unknown[]>;
  transition(
    command: {
      readonly command: string;
      readonly applicationId: string;
      readonly tenantId: string;
      readonly executionId: string;
      readonly actorId: string;
      readonly reason?: string;
    },
    idempotencyKey: string,
  ): Promise<unknown>;
  recordStepEvent(
    input: {
      readonly executionId: string;
      readonly applicationId: string;
      readonly actor: { readonly actorId: string; readonly tenantId: string };
      readonly command: string;
      readonly cause?: string;
      readonly reference?: Readonly<Record<string, unknown>>;
      readonly payload: Readonly<Record<string, unknown>>;
    },
    idempotencyKey: string,
  ): Promise<unknown>;
  recordPlanningDecision(
    input: {
      readonly applicationId: string;
      readonly executionId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly decisionId: string;
      readonly planId: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
    idempotencyKey: string,
  ): Promise<unknown>;
}

/**
 * The public wire surface (structurally the public SDK client family):
 * the scoped client (the tenant's own application scope) and the forged
 * client (the client constructed with the OTHER application's scope —
 * the header-confusion probe). The REAL server-side scope derivation
 * lives in the binding.
 */
export interface IsolationWireSurface {
  readonly scoped: {
    createExecution(
      request: {
        readonly applicationId: string;
        readonly environmentId?: string;
        readonly task: Readonly<Record<string, unknown>>;
      },
      idempotencyKey: string,
    ): Promise<unknown>;
    getExecution(executionId: string): Promise<unknown>;
    cancelExecution(executionId: string, idempotencyKey: string): Promise<unknown>;
    getResult(executionId: string): Promise<unknown>;
    listEvents(executionId: string): Promise<readonly unknown[]>;
    listVerification(executionId: string): Promise<readonly unknown[]>;
  };
  readonly forged: {
    getExecution(executionId: string): Promise<unknown>;
    createExecution(
      request: {
        readonly applicationId: string;
        readonly task: Readonly<Record<string, unknown>>;
      },
      idempotencyKey: string,
    ): Promise<unknown>;
  };
}

/** The SQL row-count snapshot seam (bound to the REAL DatabasePort). */
export type IsolationCountSnapshotter = () => Promise<IsolationRowCountSnapshot>;

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

export interface TenantIsolationLifecyclePort {
  /** Canonical transitions of the carrier's own lifecycle. */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
    readonly reason: string;
  }): Promise<void>;
  /** Durable planning decision (route facts) — before the battery. */
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: {
      readonly provider: string;
      readonly model: string;
      readonly strategyClass: string;
    };
  }): Promise<void>;
  /**
   * The isolation journal (the platform's `agent-action-recorded`
   * step-event vocabulary): called EXACTLY once per probe with digest
   * references only.
   */
  recordProbeOutcome(input: {
    readonly executionId: string;
    readonly record: IsolationProbeOutcomeRecord;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Run records + result
// ---------------------------------------------------------------------------

/** One journaled probe outcome (digests, never payload bytes). */
export interface IsolationProbeOutcomeRecord {
  readonly probeId: string;
  readonly surface: IsolationProbeSurface;
  readonly operation: IsolationProbeOperation;
  readonly reference: IsolationProbeReference;
  readonly expectedCode: string;
  readonly expectedKind: IsolationExpectedOutcome["kind"];
  readonly observedKind: ObservedProbeOutcome["kind"];
  readonly observedCode: string | null;
  readonly httpStatus: number | null;
  readonly denied: boolean;
  /** Foreign content observed in the probe's own response (never expected). */
  readonly dataLeak: boolean;
  readonly latencyMs: number;
  readonly requestDigest: string;
  readonly message: string;
}

/** The observed facts of one driven probe battery. */
export interface IsolationRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly probes: readonly IsolationProbeOutcomeRecord[];
  readonly totalProbes: number;
  readonly deniedProbes: number;
  readonly journaledProbes: number;
  readonly leakedProbes: number;
  readonly rowCountViolations: readonly string[];
  readonly totalProbeLatencyMs: number;
  readonly accountedOwnWrites: AccountedOwnWrites;
  /** Honest economics: no provider dispatch (the scope checks are pre-dispatch). */
  readonly usage: "none (pre-dispatch scope checks — no provider contact)";
}

// ---------------------------------------------------------------------------
// The foreign-world reference bundle the battery probes
// ---------------------------------------------------------------------------

/**
 * The run-time foreign-world facts: the ids of the OTHER tenant's
 * durable rows (seeded by the integration world) plus the planted
 * foreign-content markers the mechanical scan hunts. Ids are probe
 * INPUTS (the caller's own references — recordable as digests); the
 * MARKERS are the other tenant's content (never recordable).
 */
export interface ForeignWorldRefs {
  readonly foreignApplicationId: string;
  readonly foreignTenantId: string;
  readonly foreignActorId: string;
  readonly foreignExecutionId: string;
  readonly foreignEnvironmentId: string;
  readonly contentMarkers: readonly ForeignContentMarker[];
}

// ---------------------------------------------------------------------------
// The tenant-isolation probe battery driver
// ---------------------------------------------------------------------------

const MAX_MESSAGE = 200;

function sanitizeMessage(value: unknown): string {
  if (typeof value !== "string") {
    return "probe outcome (no boundary message)";
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "probe outcome (no boundary message)";
  }
  return trimmed.length <= MAX_MESSAGE ? trimmed : `${trimmed.slice(0, MAX_MESSAGE)}…`;
}

/** Normalize one thrown error into an observed probe outcome. */
function observeThrown(error: unknown, wire: boolean): ObservedProbeOutcome {
  const asTyped = error as {
    readonly status?: number;
    readonly body?: { readonly code?: string; readonly message?: string };
    readonly code?: string;
    readonly message?: string;
  };
  const code = (asTyped?.body?.code ?? asTyped?.code ?? null) as string | null;
  const message = sanitizeMessage(
    asTyped?.body?.message ??
      asTyped?.message ??
      (error instanceof Error ? error.message : String(error)),
  );
  const httpStatus = wire ? (typeof asTyped?.status === "number" ? asTyped.status : null) : null;
  return { kind: "typed-error", code, httpStatus, message };
}

/**
 * Drive one submitted isolation-probe execution to completion through
 * the platform path: authorize → plan → planning-decision BEFORE the
 * battery → queue → start → the row-count window opens → the probe
 * battery (each probe: attempt → observe → match → foreign-content
 * scan → journal EXACTLY once) → the row-count window closes → the
 * invariant derivation → verify → terminal: any admitted probe, any
 * leaked content, any row-count violation, any journal mismatch →
 * FAILED (never a partial-success shortcut).
 *
 * Honesty invariants (by construction): a denied probe never writes
 * (the service rolls the arbitration transaction back — the row-count
 * window proves it mechanically); the driver's ONLY own-application
 * writes during the window are the journal records themselves
 * (accounted exactly); the foreign application's rows are untouched;
 * no provider is ever contacted (the scope checks are pre-dispatch).
 */
export async function driveTenantIsolationExecution(options: {
  readonly executionId: string;
  readonly task: unknown;
  readonly probe: IsolationProbeKind;
  readonly lifecycle: TenantIsolationLifecyclePort;
  /** The seam binding the REAL executions service. */
  readonly executions: IsolationExecutionsSurface;
  /** The seam binding the REAL public wire clients (scoped + forged). */
  readonly wire: IsolationWireSurface;
  /** The seam binding the REAL SQL row counts. */
  readonly counts: IsolationCountSnapshotter;
  /** The run-time foreign-world facts (seeded by the integration world). */
  readonly foreign: ForeignWorldRefs;
  /** The own tenant's identity (the probe battery's home scope). */
  readonly own: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly actorId: string;
  };
  readonly now: () => Date;
  readonly idempotencyPrefix: string;
}): Promise<IsolationRunResult> {
  const { executionId, lifecycle, foreign, own } = options;
  const validation = validateIsolationProbeTask(options.task);
  const plan = planIsolationProbes(options.probe);

  await lifecycle.transition({ executionId, step: "authorize", reason: "val-024-authorize" });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-024-plan" });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "tenant-isolation-probe",
      model: "pre-dispatch-scope-checks",
      strategyClass: "tenant-isolation-probe",
    },
  });
  await lifecycle.transition({ executionId, step: "queue", reason: "val-024-queue" });
  await lifecycle.transition({ executionId, step: "start", reason: "val-024-start" });

  // The row-count window opens: everything the battery writes from here
  // is either a journal record (accounted) or an isolation violation.
  const before = validation.valid ? await options.counts() : null;
  const probes: IsolationProbeOutcomeRecord[] = [];
  let journaledProbes = 0;
  let deniedProbes = 0;
  let leakedProbes = 0;
  let totalProbeLatencyMs = 0;

  if (validation.valid) {
    for (const [index, planned] of plan.entries()) {
      const probeNumber = index + 1;
      const idempotencyKey = `${options.idempotencyPrefix}-${executionId}-probe-${probeNumber}`;
      const requestDigest = isolationDigestOf({
        probe: planned.probeId,
        surface: planned.surface,
        operation: planned.operation,
        reference: planned.reference,
      });
      const startedAt = options.now().getTime();
      const observed = await attemptProbe({
        planned,
        executions: options.executions,
        wire: options.wire,
        foreign,
        own,
        executionId,
        idempotencyKey,
      });
      const latencyMs = options.now().getTime() - startedAt;
      totalProbeLatencyMs += latencyMs;
      const denied = matchProbeObservation(planned.expected, observed.outcome);
      const leakScan = scanEvidenceForForeignContent(
        { message: observed.outcome.message, code: observed.outcome.code, data: observed.data },
        foreign.contentMarkers,
      );
      if (denied) {
        deniedProbes += 1;
      }
      if (!leakScan.clean) {
        leakedProbes += 1;
      }
      const record: IsolationProbeOutcomeRecord = {
        probeId: planned.probeId,
        surface: planned.surface,
        operation: planned.operation,
        reference: planned.reference,
        expectedCode:
          planned.expected.kind === "typed-error"
            ? planned.expected.code
            : planned.expected.kind === "zero-rows"
              ? "SCOPE_CHECKED_MISS"
              : "OWN_SCOPE_DATA",
        expectedKind: planned.expected.kind,
        observedKind: observed.outcome.kind,
        observedCode: observed.outcome.code,
        httpStatus: observed.outcome.httpStatus,
        denied,
        dataLeak: !leakScan.clean,
        latencyMs,
        requestDigest,
        message: observed.outcome.message,
      };
      probes.push(record);
      // Journaled EXACTLY once per probe (digests, never payloads).
      await lifecycle.recordProbeOutcome({ executionId, record });
      journaledProbes += 1;
    }
  }

  // The row-count window closes BEFORE the verify/complete writes: the
  // window sees ONLY the battery (the journal records + any probe write
  // that must not have happened).
  const after = validation.valid ? await options.counts() : null;
  const accounted: AccountedOwnWrites = {
    executionEvents: journaledProbes,
    idempotencyRecords: journaledProbes,
  };
  const rowCountViolations =
    before !== null && after !== null
      ? deriveRowCountViolations({ before, after, accounted })
      : [`task validation failed: ${validation.reason ?? "invalid probe task"}`];

  const criteria = deriveIsolationCriteria({
    probe: options.probe,
    validation,
    probes,
    journaledProbes,
    deniedProbes,
    leakedProbes,
    rowCountViolations,
    totalProbeLatencyMs,
  });

  const anyFail = criteria.some((criterion) => criterion.status === "FAIL");

  await lifecycle.transition({ executionId, step: "verify", reason: "val-024-verify" });
  await lifecycle.complete({
    executionId,
    verdict: anyFail ? "fail" : "pass",
    criteria,
    reason: anyFail ? "val-024-mechanical-isolation-failed" : "val-024-isolated",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    probes,
    totalProbes: probes.length,
    deniedProbes,
    journaledProbes,
    leakedProbes,
    rowCountViolations,
    totalProbeLatencyMs,
    accountedOwnWrites: accounted,
    usage: "none (pre-dispatch scope checks — no provider contact)",
  };
}

/** The outcome of one probe attempt: the observation + any returned data. */
interface ProbeAttemptOutcome {
  readonly outcome: ObservedProbeOutcome;
  readonly data: unknown;
}

/** The read target of one read-side probe (PURE reference resolution). */
function readTargetOf(
  reference: IsolationProbeReference,
  ownApplicationId: string,
  foreign: ForeignWorldRefs,
  carrierExecutionId: string,
): { readonly applicationId: string; readonly executionId: string } {
  if (reference === "foreign-execution") {
    return { applicationId: ownApplicationId, executionId: foreign.foreignExecutionId };
  }
  if (reference === "reverse-foreign-scope") {
    return { applicationId: foreign.foreignApplicationId, executionId: carrierExecutionId };
  }
  return { applicationId: ownApplicationId, executionId: carrierExecutionId };
}

/** Attempt ONE planned probe against its seam (PURE plumbing, no re-derivation). */
async function attemptProbe(input: {
  readonly planned: PlannedIsolationProbe;
  readonly executions: IsolationExecutionsSurface;
  readonly wire: IsolationWireSurface;
  readonly foreign: ForeignWorldRefs;
  readonly own: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly actorId: string;
  };
  readonly executionId: string;
  readonly idempotencyKey: string;
}): Promise<ProbeAttemptOutcome> {
  const { planned, executions, wire, foreign, own, executionId, idempotencyKey } = input;
  const ownActor = { actorId: own.actorId, tenantId: own.tenantId };
  const foreignActor = { actorId: foreign.foreignActorId, tenantId: foreign.foreignTenantId };
  const probeTask = { kind: "isolation-probe", scenario: "probe", input: "probe-reference" };

  if (planned.surface === "service") {
    switch (planned.operation) {
      case "createExecution":
        try {
          const created =
            planned.reference === "foreign-application"
              ? await executions.createExecution(
                  { applicationId: foreign.foreignApplicationId, task: probeTask },
                  idempotencyKey,
                  ownActor,
                )
              : await executions.createExecution(
                  {
                    applicationId: own.applicationId,
                    environmentId: foreign.foreignEnvironmentId,
                    task: probeTask,
                  },
                  idempotencyKey,
                  ownActor,
                );
          return { outcome: unexpectedSuccess(planned), data: created };
        } catch (error) {
          return { outcome: observeThrown(error, false), data: null };
        }
      case "getExecution":
        try {
          const target = readTargetOf(planned.reference, own.applicationId, foreign, executionId);
          const record = await executions.getExecution(target.applicationId, target.executionId);
          if (record === null) {
            return {
              outcome: { kind: "zero-rows", code: null, httpStatus: null, message: "" },
              data: null,
            };
          }
          return { outcome: ownScopeOrUnexpected(planned, record), data: record };
        } catch (error) {
          return { outcome: observeThrown(error, false), data: null };
        }
      case "listEvents":
      case "listVerification":
        try {
          const target = readTargetOf(planned.reference, own.applicationId, foreign, executionId);
          const rows =
            planned.operation === "listEvents"
              ? await executions.listEvents(target.applicationId, target.executionId)
              : await executions.listVerificationResults(target.applicationId, target.executionId);
          if (rows.length === 0) {
            return {
              outcome: { kind: "zero-rows", code: null, httpStatus: null, message: "" },
              data: null,
            };
          }
          return { outcome: ownScopeOrUnexpected(planned, rows), data: rows };
        } catch (error) {
          return { outcome: observeThrown(error, false), data: null };
        }
      case "transition":
        try {
          const outcome =
            planned.reference === "foreign-execution"
              ? await executions.transition(
                  {
                    command: "cancel",
                    applicationId: own.applicationId,
                    tenantId: own.tenantId,
                    executionId: foreign.foreignExecutionId,
                    actorId: own.actorId,
                    reason: "val-024-cross-tenant-transition-probe",
                  },
                  idempotencyKey,
                )
              : await executions.transition(
                  {
                    command: "cancel",
                    applicationId: own.applicationId,
                    tenantId: foreign.foreignTenantId,
                    executionId,
                    actorId: foreign.foreignActorId,
                    reason: "val-024-tenant-mismatch-probe",
                  },
                  idempotencyKey,
                );
          return { outcome: unexpectedSuccess(planned), data: outcome };
        } catch (error) {
          return { outcome: observeThrown(error, false), data: null };
        }
      case "recordStepEvent": {
        const stepInput =
          planned.reference === "foreign-execution"
            ? {
                executionId: foreign.foreignExecutionId,
                applicationId: own.applicationId,
                actor: ownActor,
                command: "agent-action-recorded",
                cause: "val-024-cross-tenant-step-event-probe",
                reference: {
                  artifactRef: `foreign-artifact-ref-${foreign.foreignExecutionId.slice(-8)}`,
                },
                payload: { probe: "cross-tenant" },
              }
            : {
                executionId,
                applicationId: own.applicationId,
                actor: foreignActor,
                command: "agent-action-recorded",
                cause: "val-024-tenant-mismatch-step-event-probe",
                reference: { artifactRef: "own-artifact-ref-probe" },
                payload: { probe: "tenant-mismatch" },
              };
        try {
          const outcome = await executions.recordStepEvent(stepInput, idempotencyKey);
          return { outcome: unexpectedSuccess(planned), data: outcome };
        } catch (error) {
          return { outcome: observeThrown(error, false), data: null };
        }
      }
      case "recordPlanningDecision": {
        const decisionInput =
          planned.reference === "foreign-execution"
            ? {
                applicationId: own.applicationId,
                executionId: foreign.foreignExecutionId,
                tenantId: own.tenantId,
                actorId: own.actorId,
                decisionId: `val-024-decision-${idempotencyKey.slice(-12)}`,
                planId: `val-024-plan-${idempotencyKey.slice(-12)}`,
                payload: { probe: "cross-tenant" },
              }
            : {
                applicationId: own.applicationId,
                executionId,
                tenantId: foreign.foreignTenantId,
                actorId: foreign.foreignActorId,
                decisionId: `val-024-decision-${idempotencyKey.slice(-12)}`,
                planId: `val-024-plan-${idempotencyKey.slice(-12)}`,
                payload: { probe: "tenant-mismatch" },
              };
        try {
          const outcome = await executions.recordPlanningDecision(decisionInput, idempotencyKey);
          return { outcome: unexpectedSuccess(planned), data: outcome };
        } catch (error) {
          return { outcome: observeThrown(error, false), data: null };
        }
      }
      default:
        return {
          outcome: {
            kind: "unexpected-error",
            code: null,
            httpStatus: null,
            message: `service surface carries no ${planned.operation} probe`,
          },
          data: null,
        };
    }
  }

  // The wire surface.
  switch (planned.operation) {
    case "getExecution":
      try {
        const record =
          planned.reference === "forged-application-scope"
            ? await wire.forged.getExecution(foreign.foreignExecutionId)
            : await wire.scoped.getExecution(foreign.foreignExecutionId);
        return { outcome: unexpectedSuccess(planned), data: record };
      } catch (error) {
        return { outcome: observeThrown(error, true), data: null };
      }
    case "cancelExecution":
      try {
        const outcome = await wire.scoped.cancelExecution(
          foreign.foreignExecutionId,
          idempotencyKey,
        );
        return { outcome: unexpectedSuccess(planned), data: outcome };
      } catch (error) {
        return { outcome: observeThrown(error, true), data: null };
      }
    case "getResult":
      try {
        const result = await wire.scoped.getResult(foreign.foreignExecutionId);
        return { outcome: unexpectedSuccess(planned), data: result };
      } catch (error) {
        return { outcome: observeThrown(error, true), data: null };
      }
    case "listEvents":
      try {
        const rows = await wire.scoped.listEvents(foreign.foreignExecutionId);
        return rows.length === 0
          ? { outcome: unexpectedSuccess(planned), data: rows }
          : { outcome: unexpectedSuccess(planned), data: rows };
      } catch (error) {
        return { outcome: observeThrown(error, true), data: null };
      }
    case "listVerification":
      try {
        const rows = await wire.scoped.listVerification(foreign.foreignExecutionId);
        return { outcome: unexpectedSuccess(planned), data: rows };
      } catch (error) {
        return { outcome: observeThrown(error, true), data: null };
      }
    case "createExecution":
      try {
        const created =
          planned.reference === "foreign-application"
            ? await wire.scoped.createExecution(
                { applicationId: foreign.foreignApplicationId, task: probeTask },
                idempotencyKey,
              )
            : await wire.scoped.createExecution(
                {
                  applicationId: own.applicationId,
                  environmentId: foreign.foreignEnvironmentId,
                  task: probeTask,
                },
                idempotencyKey,
              );
        return { outcome: unexpectedSuccess(planned), data: created };
      } catch (error) {
        return { outcome: observeThrown(error, true), data: null };
      }
    default:
      return {
        outcome: {
          kind: "unexpected-error",
          code: null,
          httpStatus: null,
          message: `wire surface carries no ${planned.operation} probe`,
        },
        data: null,
      };
  }
}

function unexpectedSuccess(planned: PlannedIsolationProbe): ObservedProbeOutcome {
  return {
    kind: "unexpected-success",
    code: null,
    httpStatus: null,
    message: `${planned.operation} admitted the ${planned.reference} probe (isolation failure)`,
  };
}

function ownScopeOrUnexpected(planned: PlannedIsolationProbe, data: unknown): ObservedProbeOutcome {
  if (planned.expected.kind === "own-scope-data") {
    return {
      kind: "own-scope-data",
      code: null,
      httpStatus: null,
      message: "own-scope data admitted (legitimate access)",
    };
  }
  void data;
  return {
    kind: "unexpected-success",
    code: null,
    httpStatus: null,
    message: `${planned.operation} returned data for the ${planned.reference} probe (data disclosure)`,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanical criteria for one isolation run (PURE): the same
 * probe outcomes + row-count facts always yield the same verdicts. The
 * criteria prove the ISOLATION (every probe denied with its expected
 * typed rejection — never data, never effects), the digest-only
 * evidence discipline (no foreign content marker anywhere), the
 * row-count invariants (zero foreign effects; own writes accounted),
 * the journal-exactly-once contract and the honest economics.
 */
export function deriveIsolationCriteria(input: {
  readonly probe: IsolationProbeKind;
  readonly validation: ProbeTaskValidation;
  readonly probes: readonly IsolationProbeOutcomeRecord[];
  readonly journaledProbes: number;
  readonly deniedProbes: number;
  readonly leakedProbes: number;
  readonly rowCountViolations: readonly string[];
  readonly totalProbeLatencyMs: number;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];
  const isControl = input.probe === "control:healthy";

  // 1. The typed-rejection contract: every probe of the battery
  //    observed its expected typed rejection (probe rows) or its
  //    legitimate own-scope admission (the control row). An admitted
  //    cross-tenant probe or a wrong typed code FAILs mechanically.
  const allMatched = input.deniedProbes === input.probes.length && input.probes.length > 0;
  criteria.push({
    criterionId: "typed-rejection-observed",
    strategy: "deterministic",
    status: allMatched ? "PASS" : "FAIL",
    evidence: [
      `probe:${input.probe}`,
      `probes:${input.probes.length}`,
      `matched:${input.deniedProbes}`,
      `control:${String(isControl)}`,
      ...(input.validation.valid ? [] : [`task-invalid:${input.validation.reason ?? "unknown"}`]),
    ],
  });

  // 2. Zero data disclosure: no foreign content marker appears in ANY
  //    probe outcome (the error evidence carries the boundary, never
  //    the other tenant's content).
  criteria.push({
    criterionId: "zero-data-disclosure",
    strategy: "deterministic",
    status: input.leakedProbes === 0 ? "PASS" : "FAIL",
    evidence: [
      `leakedProbes:${input.leakedProbes}`,
      ...(input.leakedProbes === 0
        ? []
        : input.probes
            .filter((record) => record.dataLeak)
            .map((record) => `leak:${record.probeId}`)),
    ],
  });

  // 3. Zero foreign effects: the foreign application's durable rows are
  //    IDENTICAL before and after the battery.
  const foreignClean =
    input.rowCountViolations.length === 0 ||
    !input.rowCountViolations.some((violation) => violation.startsWith("foreign-application"));
  criteria.push({
    criterionId: "zero-foreign-effects",
    strategy: "deterministic",
    status: foreignClean ? "PASS" : "FAIL",
    evidence: [
      `violations:${input.rowCountViolations.length}`,
      ...(foreignClean ? [] : input.rowCountViolations),
    ],
  });

  // 4. Own writes accounted: the own application's row-count delta
  //    equals EXACTLY the driver's journal writes (an unaccounted write
  //    is a mechanical isolation failure).
  const ownAccounted = input.rowCountViolations.every(
    (violation) => !violation.startsWith("own-application"),
  );
  criteria.push({
    criterionId: "own-writes-accounted",
    strategy: "deterministic",
    status: ownAccounted ? "PASS" : "FAIL",
    evidence: [
      `violations:${input.rowCountViolations.length}`,
      ...(ownAccounted ? [] : input.rowCountViolations),
    ],
  });

  // 5. Cross-application queries return zero rows: every read-side
  //    probe observed the scope-checked miss (the control row observes
  //    its own-scope data instead).
  const zeroRowsOk = input.probes.every((record) => {
    if (isControl) {
      return record.observedKind === "own-scope-data";
    }
    if (record.expectedKind === "zero-rows") {
      return record.observedKind === "zero-rows";
    }
    return record.denied;
  });
  criteria.push({
    criterionId: "cross-application-zero-rows",
    strategy: "deterministic",
    status: zeroRowsOk ? "PASS" : "FAIL",
    evidence: [
      `readProbes:${input.probes.filter((record) => record.expectedKind === "zero-rows").length}`,
      `missesObserved:${input.probes.filter((record) => record.observedKind === "zero-rows").length}`,
    ],
  });

  // 6. The isolation journal records each denied probe EXACTLY once
  //    (the driver journals every probe of the battery; a duplication
  //    or a miss is a journal-contract failure).
  const journalOk = input.journaledProbes === input.probes.length;
  criteria.push({
    criterionId: "journal-exactly-once-per-probe",
    strategy: "deterministic",
    status: journalOk ? "PASS" : "FAIL",
    evidence: [`journaled:${input.journaledProbes}`, `probes:${input.probes.length}`],
  });

  // 7. Digest-only evidence: the probe records carry request DIGESTS
  //    and boundary codes — never payload bytes, never foreign content.
  const digestOnly = input.probes.every((record) => /^[0-9a-f]{8}$/.test(record.requestDigest));
  criteria.push({
    criterionId: "evidence-digest-only",
    strategy: "deterministic",
    status: digestOnly ? "PASS" : "FAIL",
    evidence: [
      `perProbeDigests:${input.probes.map((record) => record.requestDigest).join("|") || "none"}`,
      `foreignMarkersDeclared:${input.leakedProbes === 0 ? "absent (clean)" : "PRESENT"}`,
    ],
  });

  // 8. Honest economics: no provider dispatch (the scope checks are
  //    pre-dispatch); per-probe latency measured, never estimated.
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      "usage:none (pre-dispatch scope checks — no provider contact)",
      `probes:${input.probes.length}`,
      `latencyMs:${input.totalProbeLatencyMs}`,
    ],
  });

  return criteria;
}
