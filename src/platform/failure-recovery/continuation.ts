/**
 * Continuation packages (platform failure-recovery plane; WORK-055 /
 * E1.1 — "continuation packages for long-running work ... resume
 * without unnecessary reconstruction").
 *
 * THE CONTINUATION PACKAGE IS DATA, NEVER AN ENGINE (architecture
 * invariant 3): a typed, content-addressed resume payload the
 * EXISTING execution layer consumes. Applying it is a PURE function
 * that validates integrity and environment applicability and returns
 * a typed resume directive — there is NO second execution state
 * machine, NO durable store, NO lifecycle anywhere in this plane (the
 * sole durable surface remains the WORK-049 decision-record store;
 * architecture-test proven).
 *
 * The contract, fail-closed and total:
 *
 *  - CONSTRUCTION validates everything: the governed work identity
 *    (planId/irId — the package never re-derives or re-interprets the
 *    plan), the bounded step-progress set (closed status vocabulary:
 *    completed/skipped — DATA markers, never a state machine), the
 *    environment fingerprint the work ran under, and the explicit
 *    createdAt instant (an INPUT, never ambient time);
 *  - the package is CONTENT-ADDRESSED: `packageId` is the digest of
 *    the canonical form (everything except the derived identity and
 *    the volatile timestamp), so the same inputs always produce the
 *    same package identity (idempotent construction, drift-visible
 *    content) and `packageDigest` covers the full form for consumer
 *    integrity;
 *  - APPLICATION (`applyContinuationPackage`) is idempotent: the same
 *    package + the same (matching) environment always produce the
 *    byte-identical resume directive — applying it twice is a bounded
 *    no-op (a pure value; the execution layer's existing idempotency
 *    semantics own any durable convergence);
 *  - ENVIRONMENT DRIFT IS FAIL-CLOSED (invariant 4): the resumed
 *    environment's fingerprint must MATCH the package's fingerprint
 *    exactly; any typed drift rejects the application (a changed
 *    environment invalidates a continuation rather than silently
 *    applying it — discrimination-tested);
 *  - READ-TIME validation is total: a deserialized package re-derives
 *    both digests — tampered or foreign values are rejected, never
 *    served.
 *
 * The resume directive carries exactly what reconstruction would
 * otherwise waste: the governed identities, the completed/skipped
 * step ids and the environment identity — data the EXISTING
 * execution layer consumes at its own seam.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import type { FailureAttribution } from "./attribution";
import { validateFailureAttribution } from "./attribution";
import { boundedDetail, MAX_CONTINUATION_STEPS, reject, SHA256_HEX_PATTERN } from "./catalog";
import type { EnvironmentFingerprint, FingerprintComparison } from "./fingerprint";
import { compareFingerprints, validateEnvironmentFingerprint } from "./fingerprint";

// ---------------------------------------------------------------------------
// The step-progress vocabulary (data markers — never a state machine)
// ---------------------------------------------------------------------------

/**
 * The closed step-status vocabulary of a continuation package: DATA
 * markers the execution layer reads to avoid re-running completed
 * work. Deliberately NOT an execution-state vocabulary — the
 * execution lifecycle authority stays with the executions module.
 */
export const CONTINUATION_STEP_STATUSES = ["completed", "skipped"] as const;
export type ContinuationStepStatus = (typeof CONTINUATION_STEP_STATUSES)[number];

/** One step's progress marker (data — bounded, unique per step). */
export interface StepProgress {
  readonly stepId: string;
  readonly status: ContinuationStepStatus;
}

const STEP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// The continuation package
// ---------------------------------------------------------------------------

/**
 * The typed, content-addressed resume payload for long-running work.
 * DATA ONLY: consumed by the existing execution layer, never an
 * engine, never a durable state machine.
 */
export interface ContinuationPackage {
  /** Content-derived identity: sha256 over the canonical package form. */
  readonly packageId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The execution the package resumes, when bound. */
  readonly executionId?: string;
  /** The GOVERNED plan identity (carried verbatim, never re-derived). */
  readonly planId: string;
  /** The derived Execution IR identity (carried verbatim). */
  readonly irId: string;
  /** The bounded step-progress markers (completed/skipped — data). */
  readonly steps: readonly StepProgress[];
  /** The environment the work ran under (drift-validated on apply). */
  readonly environment: EnvironmentFingerprint;
  /** The attribution that triggered the continuation, when failure-triggered. */
  readonly attribution?: FailureAttribution;
  /** The explicit created-at instant (an INPUT, never ambient). */
  readonly createdAt: string;
  /** sha256 over the canonical FULL package form (consumer integrity). */
  readonly packageDigest: string;
}

/** The package form excluding the derived identity/integrity fields. */
type ContinuationForm = Omit<ContinuationPackage, "packageId" | "packageDigest">;

/** Canonical package form — the exact bytes the packageId covers. */
export function canonicalContinuationForm(form: ContinuationForm): string {
  if (!isCanonicalizable(form)) {
    throw new TypeError("continuation form is not canonicalizable");
  }
  return canonicalJson(form);
}

// ---------------------------------------------------------------------------
// Construction (content-addressed, total validation)
// ---------------------------------------------------------------------------

/** The continuation-construction input. */
export interface ContinuationInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The governed plan's content-addressed identity (sha256 hex). */
  readonly planId: string;
  /** The derived IR's content-addressed identity (sha256 hex). */
  readonly irId: string;
  /** The bounded step-progress markers (unique step ids). */
  readonly steps: readonly StepProgress[];
  /** The environment the work ran under (validated). */
  readonly environment: EnvironmentFingerprint;
  /** The attribution that triggered the continuation, when failure-triggered. */
  readonly attribution?: FailureAttribution;
  /** The explicit created-at instant. */
  readonly createdAt: string;
  readonly digest: IrDigestPort;
}

/**
 * Build the continuation package: total validation (identities,
 * step bounds/uniqueness, fingerprint, attribution) then the
 * content-addressed identity. The same inputs always produce the
 * byte-identical package (idempotent construction).
 */
export function buildContinuationPackage(input: ContinuationInput): ContinuationPackage {
  if (!UUID_PATTERN.test(input.applicationId)) {
    reject("continuation-shape", "applicationId must be a UUID");
  }
  if (!UUID_PATTERN.test(input.tenantId)) {
    reject("continuation-shape", "tenantId must be a UUID");
  }
  if (input.executionId !== undefined && !UUID_PATTERN.test(input.executionId)) {
    reject("continuation-shape", "executionId must be a UUID when present");
  }
  if (typeof input.planId !== "string" || !SHA256_HEX_PATTERN.test(input.planId)) {
    reject("continuation-shape", "planId must be a sha256 hex digest", {
      got: boundedDetail(String(input.planId)),
    });
  }
  if (typeof input.irId !== "string" || !SHA256_HEX_PATTERN.test(input.irId)) {
    reject("continuation-shape", "irId must be a sha256 hex digest", {
      got: boundedDetail(String(input.irId)),
    });
  }
  if (typeof input.createdAt !== "string" || input.createdAt.length === 0) {
    reject("continuation-shape", "createdAt must be a non-empty string");
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    reject("continuation-shape", "a continuation must carry at least one step-progress marker");
  }
  if (input.steps.length > MAX_CONTINUATION_STEPS) {
    reject(
      "continuation-shape",
      `continuation steps exceed the bound of ${MAX_CONTINUATION_STEPS}`,
      {
        got: input.steps.length,
      },
    );
  }
  const seen = new Set<string>();
  const steps: StepProgress[] = [];
  for (const step of input.steps) {
    if (
      typeof step?.stepId !== "string" ||
      !STEP_ID_PATTERN.test(step.stepId) ||
      !(CONTINUATION_STEP_STATUSES as readonly string[]).includes(step.status)
    ) {
      reject("continuation-shape", "step progress must carry a bounded id and the closed status", {
        got: boundedDetail(JSON.stringify(step)),
      });
    }
    if (seen.has(step.stepId)) {
      reject("continuation-shape", "step ids must be unique within a continuation", {
        stepId: step.stepId,
      });
    }
    seen.add(step.stepId);
    steps.push({ stepId: step.stepId, status: step.status });
  }
  const environment = validateEnvironmentFingerprint(input.environment, input.digest);
  const attribution =
    input.attribution === undefined
      ? undefined
      : validateFailureAttribution(input.attribution, input.digest);

  const form: ContinuationForm = {
    applicationId: input.applicationId,
    tenantId: input.tenantId,
    ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    planId: input.planId,
    irId: input.irId,
    steps,
    environment,
    ...(attribution === undefined ? {} : { attribution }),
    createdAt: input.createdAt,
  };
  if (!isCanonicalizable(form)) {
    reject("continuation-shape", "continuation form is not canonicalizable");
  }
  const packageId = input.digest.sha256Hex(canonicalJson(form));
  const packageDigest = input.digest.sha256Hex(
    canonicalJson({ ...form, packageId, createdAt: form.createdAt }),
  );
  return { ...form, packageId, packageDigest };
}

// ---------------------------------------------------------------------------
// The resume directive (the data the existing execution layer consumes)
// ---------------------------------------------------------------------------

/**
 * The typed resume directive — DATA the existing execution layer
 * consumes at its own seam to resume without reconstructing completed
 * work. Never an engine: no state, no lifecycle, no store.
 */
export interface ResumeDirective {
  /** The continuation package identity this directive was derived from. */
  readonly packageId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId?: string;
  /** The governed plan identity (verbatim). */
  readonly planId: string;
  /** The derived IR identity (verbatim). */
  readonly irId: string;
  /** The step ids whose work is already complete (never re-run). */
  readonly completedStepIds: readonly string[];
  /** The step ids whose work was skipped (recorded, never re-run). */
  readonly skippedStepIds: readonly string[];
  /** The environment identity the work must resume under (drift-checked). */
  readonly environmentFingerprintId: string;
}

// ---------------------------------------------------------------------------
// Application (pure, idempotent, fail-closed on drift)
// ---------------------------------------------------------------------------

/**
 * Apply a continuation package: validate the package (shape + BOTH
 * digests — tamper detection), validate the CURRENT environment
 * fingerprint, and FAIL CLOSED on any drift (a changed environment
 * invalidates the continuation — typed rejection carrying the drift
 * report, never a silent application).
 *
 * On match, returns the typed resume directive. PURE and IDEMPOTENT:
 * the same package + environment always produce the byte-identical
 * directive — applying twice is a bounded no-op (the execution
 * layer's own idempotency semantics own durable convergence; this
 * plane holds no state).
 */
export function applyContinuationPackage(
  pkg: ContinuationPackage,
  currentEnvironment: EnvironmentFingerprint,
  digest: IrDigestPort,
): ResumeDirective {
  const validated = validateContinuationPackage(pkg, digest);
  const environment = validateEnvironmentFingerprint(currentEnvironment, digest);
  const comparison: FingerprintComparison = compareFingerprints(validated.environment, environment);
  if (comparison.status !== "match") {
    // Fail-closed drift (architecture invariant 4): the changed
    // environment invalidates the continuation — never silently
    // applied. The typed drift report is the evidence.
    reject("continuation-drift", "the resumed environment drifted from the continuation package", {
      driftedEntries: comparison.drifted.length,
      firstDrift: comparison.drifted[0]?.entryKey ?? "unknown",
      driftKind: comparison.drifted[0]?.kind ?? "unknown",
    });
  }
  const completedStepIds = validated.steps
    .filter((step) => step.status === "completed")
    .map((step) => step.stepId);
  const skippedStepIds = validated.steps
    .filter((step) => step.status === "skipped")
    .map((step) => step.stepId);
  return {
    packageId: validated.packageId,
    applicationId: validated.applicationId,
    tenantId: validated.tenantId,
    ...(validated.executionId === undefined ? {} : { executionId: validated.executionId }),
    planId: validated.planId,
    irId: validated.irId,
    completedStepIds,
    skippedStepIds,
    environmentFingerprintId: environment.fingerprintId,
  };
}

// ---------------------------------------------------------------------------
// Total validation of a (deserialized) package
// ---------------------------------------------------------------------------

/**
 * Total, deterministic validation of a continuation-package value
 * (e.g. after a durable round-trip): full shape/bounds validation AND
 * both digest re-derivations — tampered or foreign values are
 * rejected at read time, never served.
 */
export function validateContinuationPackage(
  value: unknown,
  digest: IrDigestPort,
): ContinuationPackage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("continuation-shape", "continuation package must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.packageId !== "string" || !SHA256_HEX_PATTERN.test(record.packageId)) {
    reject("continuation-shape", "packageId must be a sha256 hex digest", {
      got: boundedDetail(String(record.packageId)),
    });
  }
  if (typeof record.packageDigest !== "string" || !SHA256_HEX_PATTERN.test(record.packageDigest)) {
    reject("continuation-shape", "packageDigest must be a sha256 hex digest");
  }
  // Re-derive both identities from the form (tamper detection).
  const form: Record<string, unknown> = {
    applicationId: record.applicationId,
    tenantId: record.tenantId,
    ...(record.executionId === undefined ? {} : { executionId: record.executionId }),
    planId: record.planId,
    irId: record.irId,
    steps: record.steps,
    environment: record.environment,
    ...(record.attribution === undefined ? {} : { attribution: record.attribution }),
    createdAt: record.createdAt,
  };
  if (!isCanonicalizable(form)) {
    reject("continuation-shape", "continuation form is not canonicalizable");
  }
  const computedPackageId = digest.sha256Hex(canonicalJson(form));
  if (computedPackageId !== record.packageId) {
    reject("continuation-shape", "package content does not digest to the claimed packageId", {
      claimed: record.packageId,
      computed: computedPackageId,
    });
  }
  const computedDigest = digest.sha256Hex(
    canonicalJson({ ...form, packageId: record.packageId, createdAt: record.createdAt }),
  );
  if (computedDigest !== record.packageDigest) {
    reject("continuation-shape", "package content does not digest to the claimed packageDigest", {
      claimed: record.packageDigest,
      computed: computedDigest,
    });
  }
  // Full structural validation through the builder's own discipline.
  return buildContinuationPackage({
    applicationId: record.applicationId as string,
    tenantId: record.tenantId as string,
    ...(record.executionId === undefined ? {} : { executionId: record.executionId as string }),
    planId: record.planId as string,
    irId: record.irId as string,
    steps: record.steps as readonly StepProgress[],
    environment: record.environment as EnvironmentFingerprint,
    ...(record.attribution === undefined
      ? {}
      : { attribution: record.attribution as FailureAttribution }),
    createdAt: record.createdAt as string,
    digest,
  });
}
