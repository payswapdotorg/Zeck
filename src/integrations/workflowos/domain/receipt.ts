/**
 * WorkflowOS receipt domain (WORK-016 / WOS-003).
 *
 * WHAT WORKFLOWOS RECEIVES — the architecture §20 application-boundary
 * result package, surfaced through PUBLIC contracts only:
 *
 * ```text
 * WorkflowOS request → Zeck execution → result → verification →
 * artifact/evidence → WorkflowOS-facing receipt
 * ```
 *
 * The receipts are PURE PROJECTIONS over the executions authority's
 * public reads (`getExecution` / `listEvents` /
 * `listVerificationResults`) — the builder functions below are pure and
 * total: no store, no service, no internal database structures, and NO
 * WRITE PATH AT ALL. WorkflowOS decides what the evidence means for its
 * own workflow state (WOS-002: WorkflowOS remains authoritative for
 * WorkflowOS workflow state transitions — this module never transitions
 * it, never mutates it, and holds no WorkflowOS-state surface of any
 * kind).
 */

import type {
  EventEnvelope,
  ExecutionRecord,
  ExecutionStatus,
  VerificationResultRecord,
} from "../../../modules/executions/public";

/** The submission acknowledgment WorkflowOS receives synchronously. */
export interface WorkflowOsSubmissionReceipt {
  /** The Zeck execution identity (the durable anchor of the delegated work). */
  readonly executionId: string;
  readonly applicationId: string;
  readonly status: ExecutionStatus;
  /** The echoed external reference — provenance back to the WorkflowOS work. */
  readonly workRef: string;
  readonly createdAt: string;
  /** True when the authority replayed a previous identical request's outcome. */
  readonly replayed: boolean;
  /** The last durable ledger sequence (a stable event reference). */
  readonly lastEventSequence: number;
}

/** Neutral verification evidence for one execution (public contract shapes). */
export interface WorkflowOsVerificationEvidence {
  readonly criterionId: string;
  readonly strategy: string;
  readonly status: string;
  readonly recordedBy: string;
  readonly evidence: readonly string[];
  readonly recordedAt: string;
}

/** Neutral artifact reference (from settled durable ledger facts). */
export interface WorkflowOsArtifactReference {
  readonly id: string;
  readonly digest: string | null;
  readonly createdAt: string;
}

/** Durable event reference — (sequence, type) identities, not payloads. */
export interface WorkflowOsEventReference {
  readonly sequence: number;
  readonly type: string;
}

/**
 * The evidence receipt WorkflowOS pulls (or receives): identity, status,
 * verification evidence, artifact references, durable event references
 * and honest warnings — the §20 package over public reads.
 */
export interface WorkflowOsEvidenceReceipt {
  readonly executionId: string;
  readonly applicationId: string;
  readonly status: ExecutionStatus;
  readonly terminalAt: string | null;
  /** The echoed external reference (null when not submitted from WorkflowOS). */
  readonly workRef: string | null;
  readonly verification: readonly WorkflowOsVerificationEvidence[];
  readonly artifacts: readonly WorkflowOsArtifactReference[];
  readonly events: readonly WorkflowOsEventReference[];
  readonly warnings: readonly string[];
}

/** Build the submission receipt (pure) from the authority's receipt. */
export function buildSubmissionReceipt(
  execution: {
    readonly executionId: string;
    readonly applicationId: string;
    readonly status: ExecutionStatus;
    readonly lastEventSequence: number;
    readonly createdAt: string;
    readonly replayed: boolean;
  },
  workRef: string,
): WorkflowOsSubmissionReceipt {
  return {
    executionId: execution.executionId,
    applicationId: execution.applicationId,
    status: execution.status,
    workRef,
    createdAt: execution.createdAt,
    replayed: execution.replayed,
    lastEventSequence: execution.lastEventSequence,
  };
}

/** Extract the echoed WorkflowOS provenance from an execution's metadata. */
export function workflowosWorkRefOf(execution: Pick<ExecutionRecord, "metadata">): string | null {
  const metadata = execution.metadata as Readonly<Record<string, unknown>> | null | undefined;
  const provenance = metadata?.workflowos as { readonly workRef?: unknown } | null | undefined;
  if (
    provenance === null ||
    provenance === undefined ||
    typeof provenance !== "object" ||
    typeof provenance.workRef !== "string"
  ) {
    return null;
  }
  return provenance.workRef;
}

const verificationEvidenceOf = (
  results: readonly VerificationResultRecord[],
): readonly WorkflowOsVerificationEvidence[] =>
  results.map((result) => ({
    criterionId: result.criterionId,
    strategy: result.strategy,
    status: result.status,
    recordedBy: result.recordedBy,
    evidence: result.evidence === undefined ? [] : [...result.evidence],
    recordedAt: result.recordedAt,
  }));

const artifactReferencesOf = (
  events: readonly EventEnvelope[],
): readonly WorkflowOsArtifactReference[] => {
  // Artifact references surface only from the settled completion facts on
  // the durable ledger (the WORK-015 result-package projection rule); a
  // missing completion reports NO artifacts — never fabricated ones.
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
};

const warningsOf = (
  execution: Pick<ExecutionRecord, "status">,
  verification: readonly WorkflowOsVerificationEvidence[],
): readonly string[] => {
  const warnings: string[] = [];
  const inconclusive = verification.filter((result) => result.status === "INCONCLUSIVE").length;
  if (inconclusive > 0) {
    warnings.push(`${inconclusive} verification result(s) were INCONCLUSIVE`);
  }
  if (execution.status === "FAILED") {
    warnings.push("execution failed (see the durable event ledger for the failure envelope)");
  }
  return warnings;
};

/**
 * Build the WorkflowOS-facing evidence receipt (pure) from the
 * authority's public reads. No internal structures cross this boundary.
 */
export function buildEvidenceReceipt(
  execution: ExecutionRecord,
  events: readonly EventEnvelope[],
  verification: readonly VerificationResultRecord[],
): WorkflowOsEvidenceReceipt {
  const evidence = verificationEvidenceOf(verification);
  return {
    executionId: execution.id,
    applicationId: execution.applicationId,
    status: execution.status,
    terminalAt: execution.terminalAt,
    workRef: workflowosWorkRefOf(execution),
    verification: evidence,
    artifacts: artifactReferencesOf(events),
    events: events.map((event) => ({ sequence: event.sequence, type: event.type })),
    warnings: warningsOf(execution, evidence),
  };
}
