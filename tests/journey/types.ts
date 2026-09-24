/**
 * PPR-003 — the public user-journey acceptance harness: shared types.
 *
 * The harness executes the 12 public user journeys (the PPR-003 work
 * order's set, in order) against a TARGET plane over real HTTP and
 * records, for every step, an honest pass | fail | not-run verdict with
 * evidence (URL, status, observed digest) — reusing the repository's
 * own assertion grammar (the deploy/ chain's identity attestation,
 * health semantics, honest-boundary route probes and boot-document
 * discipline). NO new authority: every verification decision delegates
 * to the repository's existing modules; a finding is the INPUT to the
 * next smallest-valid correction Work Order — the harness never fixes
 * anything itself.
 *
 * CREDENTIAL HONESTY (the recorded boundary): steps that require
 * transport credentials or provider rails this environment does not
 * carry are recorded NOT RUN with their reason and owner — never
 * fabricated, never assumed-pass.
 */

/** The honest step verdict vocabulary. */
export type StepStatus = "pass" | "fail" | "not-run";

/** The honest availability-state vocabulary (docs/developer/AVAILABILITY.md). */
export type AvailabilityClassification = "runnable" | "provider-gated";

/** Finding severity (the acceptance-gate hierarchy of the program plan). */
export type FindingSeverity = "blocker" | "major" | "minor";

/** The per-surface HTTP evidence every step records. */
export interface StepEvidence {
  readonly url: string;
  readonly method: string;
  readonly status: number | null;
  readonly contentType: string | null;
  /** Present only when the answer carries a Location header (PPR-011's manual-redirect disclosure). */
  readonly location?: string;
  readonly bodySha256: string | null;
  readonly durationMs: number;
  /** Present only when transport failed (the fail-closed reachability fact). */
  readonly transportError?: string;
}

/** One recorded step of one journey. */
export interface JourneyStepRecord {
  readonly id: string;
  readonly journey: string;
  readonly title: string;
  readonly surface: string;
  readonly status: StepStatus;
  readonly evidence: StepEvidence | null;
  readonly observed: string;
  readonly expected: string;
  readonly defectClass?: string;
  readonly notRun?: {
    readonly reason: string;
    readonly owner: string;
  };
  /** Cross-cutting dimension outcomes when an HTML surface was audited. */
  readonly dimensions?: readonly DimensionOutcome[];
}

/** One cross-cutting verification dimension's outcome for one surface. */
export interface DimensionOutcome {
  readonly dimension: string;
  readonly status: StepStatus;
  readonly observed: string;
  readonly defectClass?: string;
}

/** One journey's record (its steps, in execution order). */
export interface JourneyRecord {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly JourneyStepRecord[];
}

/**
 * A material finding — the PPR-003 findings contract (every field is
 * mandatory; the report writer enforces the shape and the unit test
 * pins it). A finding is the INPUT to the next smallest-valid
 * correction Work Order.
 */
export interface Finding {
  readonly journey: string;
  readonly step: string;
  readonly surface: string;
  readonly observed: string;
  readonly expected: string;
  readonly severity: FindingSeverity;
  readonly defectClass: string;
  readonly evidence: string;
  readonly viableSolutions: readonly string[];
  readonly recommendedSolution: string;
  readonly verificationRequirement: string;
}

/** A NOT RUN boundary of the harness's own environment, with its owner. */
export interface NotRunBoundary {
  readonly check: string;
  readonly reason: string;
  readonly owner: string;
}

/** The 22-family coverage matrix row (derived from the machine manifest). */
export interface CapabilityMatrixRow {
  readonly family: string;
  readonly classification: AvailabilityClassification;
  readonly gatedBy: string | null;
  readonly availability: string;
  readonly examplePath: string;
  readonly capabilityRequirements: readonly string[];
  readonly discoveryLocation: {
    readonly consoleRoute: string;
    readonly machineManifest: string;
  };
  readonly providerAccessExplanation: string;
  /**
   * Target-side probe outcome — the one mutable field: the runner
   * fills it as the capability journey probes each family's discovery
   * route, before the report is frozen.
   */
  targetProbe?: {
    readonly status: StepStatus;
    readonly observed: string;
    readonly defectClass?: string;
  };
}

/** The acceptance-gate verdict mapping (the program plan's gate list). */
export interface GateOutcome {
  readonly gate: string;
  readonly status: StepStatus;
  readonly evidence: string;
}

/** The fail-closed identity preflight outcome. */
export interface IdentityGateOutcome {
  readonly verified: boolean;
  readonly reason?: string;
  readonly planeUrl: string;
  readonly expectedRevision: string;
  readonly attested?: {
    readonly runtimeIdentityId: string;
    readonly gitRevision: string;
    readonly manifestDigest: string;
    readonly topologyDigest: string;
    readonly environment: string;
  };
}

/** The full harness report (the report writer's output document). */
export interface HarnessReport {
  readonly tool: string;
  readonly schemaVersion: 1;
  readonly mode: string;
  readonly targetUrl: string;
  readonly expectedRevision: string;
  readonly environment: string;
  readonly allowDegraded: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly identityGate: IdentityGateOutcome;
  readonly journeys: readonly JourneyRecord[];
  readonly capabilityMatrix: readonly CapabilityMatrixRow[];
  readonly findings: readonly Finding[];
  readonly notRun: readonly NotRunBoundary[];
  readonly gates: readonly GateOutcome[];
  readonly summary: {
    readonly journeys: number;
    readonly stepsTotal: number;
    readonly stepsPassed: number;
    readonly stepsFailed: number;
    readonly stepsNotRun: number;
    readonly findingsBySeverity: Readonly<Record<FindingSeverity, number>>;
    readonly familiesTotal: number;
    readonly familiesWithServedDisclosure: number;
    readonly familiesNotServed: number;
    readonly familiesDisclosureFailed: number;
  };
  readonly selfScan: {
    readonly checked: "the harness's own serialized report";
    readonly clean: boolean;
    readonly note: string;
  };
  readonly problems: readonly string[];
}

/** The harness run outcome (report + the exit-code decision inputs). */
export interface HarnessRunOutcome {
  readonly report: HarnessReport;
  readonly exitCode: number;
}
