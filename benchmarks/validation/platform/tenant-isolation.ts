/**
 * The platform-side tenant-isolation driver (VAL-024).
 *
 * The isolation slice of the validation program: drives isolation
 * probes (cross-tenant read / transition / planning / artifact fetch /
 * artifact adoption / create confusion / environment confusion /
 * forged scope / cross-application state) through the REAL platform
 * path, verifying the platform's typed scope boundary:
 *
 *   * the typed-rejection taxonomy as PURE derivations —
 *     `classifyPlatformRejection` (the executions/artifacts/scope
 *     authorities' own `PlatformError` codes → the typed rejection
 *     vocabulary: `TENANT_SCOPE_VIOLATION` for the execution store's
 *     locked-row checks and the artifacts tenant namespace, and
 *     `AUTHORIZATION_DENIED` for the scope resolver's membership
 *     boundary), `classifySdkRejection` (the public wire's own error
 *     codes + HTTP statuses → the same vocabulary, with the
 *     `SCOPE_CHECKED_MISS` class for the 404 indistinguishable miss —
 *     another application's execution is indistinguishable from a
 *     missing one, never a tenant oracle) and `redactForeignMarkers`
 *     (the zero-data-disclosure discipline: an observed message that
 *     carries the other tenant's content is REDACTED to its boundary
 *     marker LABELS — evidence carries the boundary, never the other
 *     tenant's content);
 *   * `scanForForeignContent` (PURE): the mechanical evidence scan —
 *     none of the other tenant's canary content may appear anywhere
 *     in the run's own records (findings name LABELS, never content);
 *   * the isolation-journal discipline: every driven probe is
 *     journaled EXACTLY once (digests in the journal, never payload
 *     bytes; per-probe-distinct idempotency keys where the ledger
 *     sees distinct payloads — the VAL-018 lesson);
 *   * the bounded probe policy: a denied probe is NEVER retried (the
 *     scope checks are deterministic pre-dispatch machinery); a probe
 *     that DISCLOSES foreign data terminates the battery immediately
 *     (the breach fails the run — never a partial-success shortcut);
 *   * the execution driver mirroring the VAL-019/020/021 drivers
 *     (authorize → plan → planning-decision BEFORE the first probe →
 *     queue → start → probes (each journaled exactly once) → verify →
 *     terminal: any disclosure or any failed criterion → FAILED).
 *
 * Honesty invariants (the inversion the isolation slice pins): the
 * DENIAL is the pass condition — a probe that receives the typed
 * rejection with zero disclosure verifies the boundary (the run
 * COMPLETES); a probe that receives foreign data, foreign rows or a
 * foreign effect is a BREACH (the run FAILS honestly — never a
 * silently tolerated violation, never a fabricated boundary). An
 * out-of-vocabulary probe family is a platform-layer rejection before
 * any probe is driven (zero probes, zero effects).
 *
 * Everything is seam-injected here (the lab contract): the
 * integration seam binds the REAL executions service, the REAL
 * artifacts service, the REAL scope resolver and the REAL PostgreSQL
 * row-scoping — every store query bound by application + tenant is
 * the system under test at the crown.
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The isolation taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

/**
 * The isolation probe families (the work order's four named families
 * plus the discrimination families AC6 pins: forged tenant/scope
 * headers, application-id confusion and artifact-ref probing, plus the
 * own-tenant control that proves the boundary does not over-deny).
 */
export const ISOLATION_PROBE_FAMILIES = [
  // the work order's named families
  "cross-tenant-read",
  "cross-tenant-transition",
  "cross-tenant-artifact-fetch",
  "cross-application-state",
  // the AC6 discrimination families
  "cross-tenant-create",
  "cross-tenant-environment",
  "cross-tenant-planning",
  "cross-tenant-artifact-adoption",
  "forged-scope-header",
  // the control: the same access within one's own tenant is granted
  "own-tenant-control",
] as const;

export type IsolationProbeFamily = (typeof ISOLATION_PROBE_FAMILIES)[number];

/** The typed rejections the platform's isolation boundary produces. */
export const TYPED_REJECTIONS = [
  /**
   * The execution store's locked-row checks and the artifacts tenant
   * namespace: cross-tenant access to executions, environments and
   * artifact digests (HTTP 403 on the public wire).
   */
  "TENANT_SCOPE_VIOLATION",
  /**
   * The scope resolver's membership boundary: an actor holding no
   * membership for the selected application (HTTP 403 on the public
   * wire) — the application-id confusion and forged-scope shapes.
   */
  "AUTHORIZATION_DENIED",
  /**
   * The scope-checked miss: another application's execution is
   * indistinguishable from a missing one — the public wire answers
   * 404 with the SAME body an unknown id produces (zero data, zero
   * tenant oracle); platform-side the app-scoped getter returns null
   * and the app-scoped queries return zero rows.
   */
  "SCOPE_CHECKED_MISS",
] as const;

export type TypedRejection = (typeof TYPED_REJECTIONS)[number];

/** The HTTP status each typed rejection surfaces on the public wire. */
export const REJECTION_HTTP_STATUS: Readonly<Record<TypedRejection, number>> = {
  TENANT_SCOPE_VIOLATION: 403,
  AUTHORIZATION_DENIED: 403,
  SCOPE_CHECKED_MISS: 404,
};

/**
 * Classify a platform-authority rejection (the `PlatformError` codes
 * the executions service, the artifacts service and the scope
 * resolver throw). PURE. An in-vocabulary code maps to its typed
 * rejection; anything else is `null` (an honest unexpected rejection —
 * the observation records it and the criteria fail it, never a
 * fabricated match).
 */
export function classifyPlatformRejection(code: string): TypedRejection | null {
  if (code === "TENANT_SCOPE_VIOLATION") return "TENANT_SCOPE_VIOLATION";
  if (code === "AUTHORIZATION_DENIED") return "AUTHORIZATION_DENIED";
  return null;
}

/**
 * Classify a public-wire rejection (the SDK's `ZeckApiError` shape:
 * HTTP status + the public error body's own code). PURE. The 404
 * `CAPABILITY_UNAVAILABLE` shape is the scope-checked miss (the
 * indistinguishable-miss discipline — the route answers missing and
 * foreign identically); the 403 codes map to their typed rejections;
 * anything else is `null` (honest unexpected).
 */
export function classifySdkRejection(input: {
  readonly status: number;
  readonly code: string;
}): TypedRejection | null {
  if (input.status === 404 && input.code === "CAPABILITY_UNAVAILABLE") {
    return "SCOPE_CHECKED_MISS";
  }
  if (input.status === 403 && input.code === "TENANT_SCOPE_VIOLATION") {
    return "TENANT_SCOPE_VIOLATION";
  }
  if (input.status === 403 && input.code === "AUTHORIZATION_DENIED") {
    return "AUTHORIZATION_DENIED";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Foreign-content markers (the zero-data-disclosure discipline)
// ---------------------------------------------------------------------------

/**
 * One canary content item of the OTHER tenant: a marker string planted
 * in the foreign tenant's fixture state (its execution task input, its
 * artifact payload). Evidence and probe observations must NEVER carry
 * the marker itself — findings and redactions name the LABEL only.
 */
export interface ForeignContentMarker {
  readonly label: string;
  readonly marker: string;
}

const MAX_OBSERVATION_MESSAGE = 240;

function truncateMessage(value: string): string {
  return value.length <= MAX_OBSERVATION_MESSAGE ? value : `${value.slice(0, 240)}…`;
}

/**
 * Scan a text for foreign content markers. PURE: returns the LABELS of
 * the markers found (never the marker content — a finding itself must
 * not become a leak).
 */
export function scanForForeignContent(
  text: string,
  markers: readonly ForeignContentMarker[],
): readonly string[] {
  return markers.filter((item) => text.includes(item.marker)).map((item) => item.label);
}

/**
 * Sanitize an observed boundary message: if the other tenant's content
 * appears (a leaky error message), the message is REDACTED to the
 * boundary — the marker LABELS, never the content. Length-capped.
 */
export function redactForeignMarkers(
  message: string,
  markers: readonly ForeignContentMarker[],
): string {
  const found = scanForForeignContent(message, markers);
  if (found.length === 0) {
    return truncateMessage(message);
  }
  return truncateMessage(
    `[REDACTED: foreign-content marker(s) ${found.join(", ")} present in observed message — ` +
      "the boundary evidence never carries the other tenant's content]",
  );
}

// ---------------------------------------------------------------------------
// The isolation journal record + probe observation
// ---------------------------------------------------------------------------

/**
 * The digest helper for probe targets and granted data (digest
 * references only in evidence — never payload bytes).
 */
export function isolationDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The observed outcome of ONE isolation probe. */
export type IsolationProbeObservation =
  | {
      /** The typed rejection was produced — the boundary held. */
      readonly kind: "denied";
      readonly rejection: TypedRejection;
      readonly message: string;
      readonly latencyMs: number;
      readonly targetDigest: string;
      /** The public-wire HTTP status (null on service-level probes). */
      readonly httpStatus: number | null;
      /** Foreign-marker LABELS found in the observed text (labels only). */
      readonly foreignMarkerLabels?: readonly string[];
    }
  | {
      /**
       * The scope-checked miss: the app-scoped query answered null /
       * zero rows — indistinguishable from missing, zero disclosure.
       */
      readonly kind: "miss";
      readonly rejection: "SCOPE_CHECKED_MISS";
      readonly message: string;
      readonly latencyMs: number;
      readonly targetDigest: string;
      readonly httpStatus: number | null;
      /** Rows the foreign-scoped query returned (zero by contract). */
      readonly rowsReturned: number;
      /** Foreign-marker LABELS found in the observed text (labels only). */
      readonly foreignMarkerLabels?: readonly string[];
    }
  | {
      /**
       * The own-tenant control: the same access within the probe's own
       * tenant is granted (the boundary does not over-deny). Data
       * digests only — never payload bytes.
       */
      readonly kind: "granted";
      readonly rejection: null;
      readonly message: string;
      readonly latencyMs: number;
      readonly targetDigest: string;
      readonly httpStatus: number | null;
      readonly rowsReturned: number;
      readonly dataDigest: string | null;
      /** Foreign-marker LABELS found in the observed text (labels only). */
      readonly foreignMarkerLabels?: readonly string[];
    }
  | {
      /**
       * A DISCLOSURE: foreign data, foreign rows or a foreign effect
       * crossed the boundary. The message is redacted (labels only);
       * the breach fails the run honestly.
       */
      readonly kind: "disclosed";
      readonly rejection: null;
      readonly message: string;
      readonly latencyMs: number;
      readonly targetDigest: string;
      readonly httpStatus: number | null;
      readonly rowsReturned: number;
      readonly foreignMarkerLabels: readonly string[];
    };

/** The platform-side probe operations the corpus rows declare. */
export const ISOLATION_OPERATIONS = [
  /** createExecution naming the OTHER tenant's application. */
  "svc-create-foreign-application",
  /** createExecution for one's own application naming the OTHER tenant's environment. */
  "svc-create-foreign-environment",
  /** the app-scoped execution getter with a foreign execution id. */
  "svc-read-foreign-execution",
  /** a lifecycle transition (the locked-row check) on a foreign execution. */
  "svc-transition-foreign-execution",
  /** a planning decision (the locked-row check) on a foreign execution. */
  "svc-planning-foreign-execution",
  /** the app-scoped event ledger query for a foreign execution. */
  "svc-events-foreign-execution",
  /** the artifacts tenant-namespace get with a foreign digest. */
  "svc-artifact-fetch-foreign",
  /** putArtifact adopting a foreign digest as a lineage parent. */
  "svc-artifact-adopt-foreign-parent",
  /** the scope resolver against an application the actor has no membership for. */
  "svc-resolve-forged-scope",
  /** the own-tenant control reads (the boundary does not over-deny). */
  "svc-read-own-execution",
  "svc-artifact-fetch-own",
] as const;

export type IsolationOperation = (typeof ISOLATION_OPERATIONS)[number];

/** One journaled isolation probe (digests, never payload bytes). */
export interface IsolationProbeRecord {
  /** 1-based probe ordinal within the run. */
  readonly probe: number;
  readonly operation: IsolationOperation;
  readonly kind: "denied" | "miss" | "granted" | "disclosed";
  readonly rejection: TypedRejection | null;
  readonly latencyMs: number;
  readonly targetDigest: string;
  readonly httpStatus: number | null;
  readonly rowsReturned: number | null;
  /** Foreign-marker LABELS found in the observed text (never content). */
  readonly foreignMarkerLabels: readonly string[];
  readonly message: string;
}

/** The observed row-count facts of the foreign tenant's namespace. */
export interface IsolationWorldFacts {
  /** Executions under the foreign application (must not change). */
  readonly foreignExecutionCount: number;
  /** Ledger events under the foreign application (must not change). */
  readonly foreignEventCount: number;
  /** Artifacts in the foreign tenant's namespace (must not change). */
  readonly foreignArtifactCount: number;
  /** The foreign execution row's own status (must not change). */
  readonly foreignExecutionStatus: string;
  /** The foreign execution row's last event sequence (must not change). */
  readonly foreignExecutionLastEventSequence: number;
}

// ---------------------------------------------------------------------------
// The lifecycle port (bound to the REAL executions service)
// ---------------------------------------------------------------------------

export interface IsolationLifecyclePort {
  /** Canonical transitions (no tool/human waits in this slice). */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
    readonly reason: string;
  }): Promise<void>;
  /** Durable planning decision (route facts) — before the first probe. */
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
   * step-event vocabulary): called EXACTLY once per driven probe with
   * digest references only — the denied boundary, never payload bytes.
   */
  recordProbe(input: {
    readonly executionId: string;
    readonly record: IsolationProbeRecord;
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
// The probe seam (bound to the REAL platform authorities)
// ---------------------------------------------------------------------------

/**
 * ONE isolation probe against the bound platform surfaces. The crown
 * binds each operation to the REAL executions service / artifacts
 * service / scope resolver; the seam catches the authorities' own
 * rejections and reports the observation (zero fabrication: an
 * unexpected rejection or a foreign disclosure is reported as
 * observed). The seam NEVER retries (the scope checks are
 * deterministic pre-dispatch machinery).
 */
export type IsolationProbeSeam = (input: {
  readonly probeOrdinal: number;
  readonly operation: IsolationOperation;
}) => Promise<IsolationProbeObservation>;

// ---------------------------------------------------------------------------
// The oracle (the corpus row's expected isolation contract)
// ---------------------------------------------------------------------------

/** One expected observation (the ordered probe contract). */
export interface ExpectedObservation {
  readonly kind: "denied" | "miss" | "granted" | "disclosed";
  readonly rejection: TypedRejection | null;
}

/** The ground truth one isolation probe row is judged by. */
export interface IsolationOracle {
  readonly family: IsolationProbeFamily;
  readonly expected: {
    /** The ordered expected platform-probe observation sequence. */
    readonly observations: readonly ExpectedObservation[];
    /** The ordered expected app-side (SDK) observation sequence. */
    readonly appObservations: readonly ExpectedObservation[];
    readonly terminal: "COMPLETED" | "FAILED";
    /** Zero foreign rows across every scoped query the row drives. */
    readonly zeroForeignRows: boolean;
  };
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export interface IsolationRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly probes: readonly IsolationProbeRecord[];
  readonly totalProbes: number;
  /** The driver's own count of recordProbe calls (journal exactly-once). */
  readonly journaledProbes: number;
  /** Whether any probe disclosed foreign data/rows (the breach flag). */
  readonly disclosed: boolean;
  readonly totalProbeLatencyMs: number;
  /** Measured usage (null: this slice dispatches no model — recorded honestly). */
  readonly usage: LabUsage | null;
}

// ---------------------------------------------------------------------------
// The isolation execution driver
// ---------------------------------------------------------------------------

/**
 * Drive one submitted isolation-probe execution to completion through
 * the platform path: authorize → plan → planning-decision BEFORE the
 * first probe → queue → start → the declared probes (each journaled
 * EXACTLY once; a denied probe never retried; a disclosure terminates
 * the battery immediately) → verify → terminal: a disclosure or any
 * failed criterion → FAILED.
 *
 * The world-facts provider is called BEFORE the first probe (the
 * baseline) and at verify time (the final) — the per-run row-count
 * invariants (the foreign tenant's executions, events, artifacts and
 * the foreign execution row itself must be untouched).
 */
export async function driveIsolationExecution(options: {
  readonly executionId: string;
  readonly task: { readonly kind: string; readonly input?: Readonly<Record<string, unknown>> };
  readonly groundTruth: IsolationOracle;
  readonly platformProbes: readonly IsolationOperation[];
  readonly lifecycle: IsolationLifecyclePort;
  readonly probe: IsolationProbeSeam;
  /** The foreign-namespace facts provider (async — REAL SQL counts). */
  readonly worldFacts: () => Promise<IsolationWorldFacts> | IsolationWorldFacts;
  /**
   * The other tenant's canary content (defense in depth: the driver
   * REDACTS every journaled message and merges the scan labels — a
   * leaky seam can never leak through the journal itself).
   */
  readonly foreignMarkers?: readonly ForeignContentMarker[];
  readonly now: () => Date;
}): Promise<IsolationRunResult> {
  const { executionId, groundTruth, lifecycle } = options;

  await lifecycle.transition({ executionId, step: "authorize", reason: "val-024-authorize" });
  await lifecycle.transition({ executionId, step: "plan", reason: "val-024-plan" });
  await lifecycle.recordPlanningDecision({
    executionId,
    route: {
      provider: "platform-scope-authorities",
      model: "pre-dispatch-scope-checks",
      strategyClass: "tenant-isolation-probe",
    },
  });
  await lifecycle.transition({ executionId, step: "queue", reason: "val-024-queue" });
  await lifecycle.transition({ executionId, step: "start", reason: "val-024-start" });

  const probes: IsolationProbeRecord[] = [];
  let journaledProbes = 0;
  let disclosed = false;

  // The family vocabulary check: an out-of-vocabulary family is a
  // platform-layer rejection BEFORE any probe is driven (zero probes,
  // zero effects) — the run fails honestly.
  const declaredFamily = String(
    (options.task.input as { family?: unknown } | undefined)?.family ?? "",
  );
  const familyInVocabulary = (ISOLATION_PROBE_FAMILIES as readonly string[]).includes(
    declaredFamily,
  );

  const baseline = await Promise.resolve(options.worldFacts());

  if (familyInVocabulary) {
    for (const operation of options.platformProbes) {
      const probeOrdinal = probes.length + 1;
      const observation = await options.probe({ probeOrdinal, operation });
      // Foreign-marker LABELS found anywhere in the observed text (a
      // leaky DENIED message is caught exactly like a disclosed payload
      // — labels only, never the content). The driver additionally
      // REDACTS the journaled message itself: even a seam that forgot
      // the redaction discipline can never leak through the journal.
      const markers = options.foreignMarkers ?? [];
      const messageLabels = scanForForeignContent(observation.message, markers);
      const foreignMarkerLabels = [
        ...new Set([...(observation.foreignMarkerLabels ?? []), ...messageLabels]),
      ];
      const journaledMessage = redactForeignMarkers(observation.message, markers);
      const record: IsolationProbeRecord = {
        probe: probeOrdinal,
        operation,
        kind: observation.kind,
        rejection: observation.rejection,
        latencyMs: observation.latencyMs,
        targetDigest: observation.targetDigest,
        httpStatus: observation.httpStatus,
        rowsReturned:
          observation.kind === "miss" ||
          observation.kind === "granted" ||
          observation.kind === "disclosed"
            ? observation.rowsReturned
            : null,
        foreignMarkerLabels,
        message: journaledMessage,
      };
      probes.push(record);
      // Journaled EXACTLY once per probe (digests, never payloads; the
      // idempotency key carries the probe ordinal — per-probe distinct
      // where the ledger sees distinct payloads, the VAL-018 lesson).
      await lifecycle.recordProbe({ executionId, record });
      journaledProbes += 1;
      if (observation.kind === "disclosed") {
        // The breach terminates the battery immediately — never a
        // partial-success shortcut, never a compounded violation.
        disclosed = true;
        break;
      }
      // A denied probe is NEVER retried: the scope checks are
      // deterministic pre-dispatch machinery (the bounded policy).
    }
  }

  const finalFacts = await Promise.resolve(options.worldFacts());
  const totalProbeLatencyMs = probes.reduce((sum, record) => sum + record.latencyMs, 0);

  const criteria = deriveIsolationCriteria({
    groundTruth,
    probes,
    journaledProbes,
    baseline,
    finalFacts,
    totalProbeLatencyMs,
    familyInVocabulary,
  });

  // The honest terminal: any disclosure or any failed criterion FAILS
  // the execution (the inversion: a correctly-denied boundary
  // COMPLETES — the denial IS the verified outcome).
  const anyFail = disclosed || criteria.some((criterion) => criterion.status === "FAIL");

  await lifecycle.transition({ executionId, step: "verify", reason: "val-024-verify" });
  await lifecycle.complete({
    executionId,
    verdict: anyFail ? "fail" : "pass",
    criteria,
    reason: anyFail ? "val-024-mechanical-verification-failed" : "val-024-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    probes,
    totalProbes: probes.length,
    journaledProbes,
    disclosed,
    totalProbeLatencyMs,
    usage: null,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the mechanical criteria for one isolation run. PURE: the same
 * probe history + world facts + oracle always yields the same
 * verdicts. The criteria prove the typed rejection (code per denied
 * probe), the ordered observation sequence, zero data disclosure (the
 * foreign markers never appear in the run's own records), zero
 * foreign rows, the foreign namespace's row-count invariants (before
 * vs after), journal-exactly-once-per-probe, the family vocabulary
 * (pre-probe platform rejection) and honest measured economics.
 */
export function deriveIsolationCriteria(input: {
  readonly groundTruth: IsolationOracle;
  readonly probes: readonly IsolationProbeRecord[];
  readonly journaledProbes: number;
  readonly baseline: IsolationWorldFacts;
  readonly finalFacts: IsolationWorldFacts;
  readonly totalProbeLatencyMs: number;
  readonly familyInVocabulary: boolean;
}): LabVerificationCriterion[] {
  const { groundTruth, probes } = input;
  const criteria: LabVerificationCriterion[] = [];
  const expected = groundTruth.expected;

  // 1. The family vocabulary: an out-of-vocabulary family is a
  //    platform-layer rejection BEFORE any probe (zero probes driven).
  const vocabularyOk = input.familyInVocabulary;
  criteria.push({
    criterionId: "probe-family-vocabulary",
    strategy: "deterministic",
    status: vocabularyOk ? "PASS" : "FAIL",
    evidence: [
      `family:${groundTruth.family}`,
      `familyInVocabulary:${String(vocabularyOk)}`,
      `probesDriven:${probes.length}`,
    ],
  });

  // 2. The typed rejection: every DENIED probe carries the typed
  //    rejection the oracle pins (the code-level boundary contract).
  const deniedProbes = probes.filter((record) => record.kind === "denied");
  const expectedDenials = expected.observations.filter((obs) => obs.kind === "denied");
  const rejectionOk =
    deniedProbes.length === expectedDenials.length &&
    deniedProbes.every(
      (record, index) => record.rejection === (expectedDenials[index]?.rejection ?? null),
    );
  criteria.push({
    criterionId: "typed-rejection",
    strategy: "deterministic",
    status: rejectionOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${expectedDenials.map((obs) => obs.rejection ?? "none").join("|") || "none"}`,
      `observed:${deniedProbes.map((record) => record.rejection ?? "none").join("|") || "none"}`,
    ],
  });

  // 3. The ordered observation sequence (kind + rejection, exact).
  const observedSequence = probes.map(
    (record) => `${record.kind}:${record.rejection ?? "none"}` as const,
  );
  const expectedSequence = expected.observations.map(
    (obs) => `${obs.kind}:${obs.rejection ?? "none"}` as const,
  );
  const sequenceOk =
    observedSequence.length === expectedSequence.length &&
    observedSequence.every((entry, index) => entry === expectedSequence[index]);
  criteria.push({
    criterionId: "observation-sequence",
    strategy: "deterministic",
    status: sequenceOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${expectedSequence.join(">") || "none"}`,
      `observed:${observedSequence.join(">") || "none"}`,
    ],
  });

  // 4. Zero data disclosure: no foreign-marker LABEL was ever found in
  //    any probe's observed text (the labels themselves are findings
  //    only — the content never enters evidence).
  const markerFindings = probes.flatMap((record) => record.foreignMarkerLabels);
  const disclosureOk = markerFindings.length === 0;
  criteria.push({
    criterionId: "zero-data-disclosure",
    strategy: "deterministic",
    status: disclosureOk ? "PASS" : "FAIL",
    evidence: [
      `foreignMarkersFound:${markerFindings.length === 0 ? "none" : markerFindings.join(",")}`,
      `journalRecords:${probes.length}`,
      `redactionPolicy:labels-only`,
    ],
  });

  // 5. Zero foreign rows: every FOREIGN-scoped query the row drives
  //    returned zero rows (miss observations carry the scoped query's
  //    row count; the granted control's rows are the probe's OWN
  //    namespace's rows — not foreign rows).
  const foreignScopedRowCounts = probes
    .filter((record) => record.kind === "miss" || record.kind === "disclosed")
    .map((record) => record.rowsReturned ?? 0);
  const foreignRowsOk =
    expected.zeroForeignRows && foreignScopedRowCounts.every((count) => count === 0);
  criteria.push({
    criterionId: "zero-foreign-rows",
    strategy: "deterministic",
    status: foreignRowsOk ? "PASS" : "FAIL",
    evidence: [
      `expectedZeroForeignRows:${String(expected.zeroForeignRows)}`,
      `foreignScopedQueryRows:${foreignScopedRowCounts.join("|") || "none"}`,
    ],
  });

  // 6. The row-count invariants: the foreign tenant's namespace is
  //    untouched (executions, events, artifacts counts and the foreign
  //    execution row itself — before vs after the probe battery).
  const invariantsHold =
    input.baseline.foreignExecutionCount === input.finalFacts.foreignExecutionCount &&
    input.baseline.foreignEventCount === input.finalFacts.foreignEventCount &&
    input.baseline.foreignArtifactCount === input.finalFacts.foreignArtifactCount &&
    input.baseline.foreignExecutionStatus === input.finalFacts.foreignExecutionStatus &&
    input.baseline.foreignExecutionLastEventSequence ===
      input.finalFacts.foreignExecutionLastEventSequence;
  criteria.push({
    criterionId: "foreign-namespace-invariants",
    strategy: "deterministic",
    status: invariantsHold ? "PASS" : "FAIL",
    evidence: [
      `executions:${input.baseline.foreignExecutionCount}->${input.finalFacts.foreignExecutionCount}`,
      `events:${input.baseline.foreignEventCount}->${input.finalFacts.foreignEventCount}`,
      `artifacts:${input.baseline.foreignArtifactCount}->${input.finalFacts.foreignArtifactCount}`,
      `foreignExecutionStatus:${input.baseline.foreignExecutionStatus}->${input.finalFacts.foreignExecutionStatus}`,
      `foreignExecutionSequence:${input.baseline.foreignExecutionLastEventSequence}->${input.finalFacts.foreignExecutionLastEventSequence}`,
    ],
  });

  // 7. Journal exactly-once per probe.
  const journalOk = input.journaledProbes === probes.length;
  criteria.push({
    criterionId: "journal-exactly-once-per-probe",
    strategy: "deterministic",
    status: journalOk ? "PASS" : "FAIL",
    evidence: [
      `journaled:${input.journaledProbes}`,
      `probes:${probes.length}`,
      `perProbeDigests:${probes.map((record) => record.targetDigest).join("|") || "none"}`,
    ],
  });

  // 8. The honest outcome contract: the derived terminal matches the
  //    oracle's terminal (a verified boundary COMPLETES; a disclosed
  //    or violated boundary FAILS — never fabricated either way).
  const derivedTerminal: "COMPLETED" | "FAILED" = probes.some(
    (record) => record.kind === "disclosed",
  )
    ? "FAILED"
    : "COMPLETED";
  const terminalOk = derivedTerminal === expected.terminal;
  criteria.push({
    criterionId: "outcome-contract",
    strategy: "deterministic",
    status: terminalOk ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `disclosedProbes:${probes.filter((record) => record.kind === "disclosed").length}`,
    ],
  });

  // 9. Honest economics: measured latency recorded; this slice
  //    dispatches no model (usage recorded honestly as none).
  criteria.push({
    criterionId: "economics-measured",
    strategy: "deterministic",
    status: "PASS",
    evidence: [
      "usage:none-reported (isolation probes are pre-dispatch — no model dispatch)",
      `latencyMs:${input.totalProbeLatencyMs}`,
      `probes:${probes.length}`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side isolation contract (PURE verification of SDK probes)
// ---------------------------------------------------------------------------

/**
 * One app-side (public SDK boundary) probe observation. The app
 * records what its own SDK call surfaced: the typed rejection (code +
 * HTTP status — the wire's 404 miss IS the typed denial the app
 * observes), the sanitized message, the foreign-marker LABELS found
 * in the observed response/error text (never the content) and — for
 * granted control probes — the data digest (never payload bytes).
 * `unexpected` is an honestly recorded non-wire failure (the boundary
 * could not be verified — the contract comparison fails it, never a
 * fabricated verdict either way).
 */
export interface AppProbeObservation {
  readonly probe: number;
  readonly operation: string;
  readonly kind: "denied" | "granted" | "disclosed" | "unexpected";
  readonly rejection: TypedRejection | null;
  readonly httpStatus: number | null;
  readonly message: string;
  readonly latencyMs: number;
  readonly targetDigest: string;
  readonly foreignMarkerLabels: readonly string[];
  readonly dataDigest: string | null;
}

/**
 * Judge the app-side probe observations against the corpus row's
 * declared app contract (PURE): every expected observation matched
 * (kind + typed rejection), zero foreign markers found, and no
 * unexpected observation. The criteria ride the app's assertion
 * verdict (the app NEVER passes a violated isolation contract).
 */
export function verifyIsolationContract(input: {
  readonly expected: readonly ExpectedObservation[];
  readonly observations: readonly AppProbeObservation[];
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];

  // 1. The ordered app-observation sequence (kind + rejection).
  const observedSequence = input.observations.map(
    (obs) => `${obs.kind}:${obs.rejection ?? "none"}` as const,
  );
  const expectedSequence = input.expected.map(
    (obs) => `${obs.kind}:${obs.rejection ?? "none"}` as const,
  );
  const sequenceOk =
    observedSequence.length === expectedSequence.length &&
    observedSequence.every((entry, index) => entry === expectedSequence[index]);
  criteria.push({
    criterionId: "app-observation-sequence",
    strategy: "deterministic",
    status: sequenceOk ? "PASS" : "FAIL",
    evidence: [
      `expected:${expectedSequence.join(">") || "none"}`,
      `observed:${observedSequence.join(">") || "none"}`,
    ],
  });

  // 2. Zero data disclosure on the app boundary: no foreign marker in
  //    any observed response or error text (labels only, never content).
  const markerFindings = input.observations.flatMap((obs) => obs.foreignMarkerLabels);
  const disclosureOk = markerFindings.length === 0;
  criteria.push({
    criterionId: "app-zero-data-disclosure",
    strategy: "deterministic",
    status: disclosureOk ? "PASS" : "FAIL",
    evidence: [
      `foreignMarkersFound:${markerFindings.length === 0 ? "none" : markerFindings.join(",")}`,
      `observations:${input.observations.length}`,
    ],
  });

  // 3. The miss-indistinguishability discipline: a scope-checked miss
  //    answers 404 (the SAME shape an unknown id produces) — never a
  //    tenant oracle, never data.
  const missObservations = input.observations.filter(
    (obs) => obs.rejection === "SCOPE_CHECKED_MISS",
  );
  const missShapeOk = missObservations.every((obs) => obs.httpStatus === 404);
  criteria.push({
    criterionId: "miss-indistinguishability",
    strategy: "deterministic",
    status: missShapeOk ? "PASS" : "FAIL",
    evidence: [
      `missObservations:${missObservations.length}`,
      `missStatuses:${missObservations.map((obs) => obs.httpStatus ?? "none").join("|") || "none"}`,
    ],
  });

  return criteria;
}
