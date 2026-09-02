/**
 * Media generation execution-ledger port (deployments module outbound;
 * WORK-026, MOD-011 — the executions EventEnvelope is the SINGLE
 * canonical provenance path).
 *
 * The tie-in to the executions module's EventEnvelope ledger — the
 * same discipline as the messaging (WORK-025) and realtime (WORK-024)
 * ledger ports: media job provenance (job submission with identity
 * context, paid dispatch, provider observations, verification
 * outcomes, artifact adoptions, cancellations, retries, failures,
 * significant actions, completion) rides the executions ledger as
 * STEP EVENTS through the executions public `recordStepEvent` seam
 * using the executions-owned agent-session vocabulary
 * ("agent-session-started" / "agent-action-recorded" /
 * "agent-session-completed"). The semantic detail (kind=dispatch/
 * observation/verification/artifact/cancellation/failure, generation
 * kind, artifact digests, provider refs) rides the payload and
 * reference fields.
 *
 * A media job IS an Execution (architecture invariant #1 of the Work
 * Order): a bounded governed run, not a separate job abstraction
 * with independent authority. The executions lifecycle therefore
 * drives the job's execution: RUNNING while generating; the public
 * `verify` transition (RUNNING → VERIFYING) at the verification
 * boundary; `pass` (VERIFYING → COMPLETED) on completion; `fail`
 * (RUNNING/VERIFYING → FAILED) on failure/verification rejection;
 * `cancel` on cancellation. The deployments module NEVER writes the
 * executions tables directly (a second event authority is
 * unrepresentable): this port is REQUIRED at runtime construction,
 * execution identity is established through the executions public
 * create seam (idempotent by key), and status moves happen ONLY
 * through the public transition-command surface.
 */

export interface MediaLedgerIdentity {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
}

/**
 * One verification result bound to a media completion/failure edge —
 * the executions module's `VerificationResultInput` shape (the
 * deployments module carries it; the executions authority owns the
 * PASS-binding discipline: a completion without at least one PASS
 * result never writes).
 */
export interface MediaVerificationResult {
  readonly criterionId: string;
  readonly strategy: string;
  readonly status: "PASS" | "FAIL" | "INCONCLUSIVE";
  /** Recorded evidence links (artifact digests, observation refs, references). */
  readonly evidence?: readonly string[];
  /** Who/what produced the result (verifier identity — the verification authority seam). */
  readonly recordedBy: string;
}

/** The provenance evidence classes the media fabric records. */
export type MediaEvidenceClass =
  | "job-submitted"
  | "job-dispatched"
  | "observation"
  | "verification"
  | "artifact"
  | "cancellation"
  | "failure"
  | "significant-action"
  | "job-completed";

export interface MediaEvidenceInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly evidenceClass: MediaEvidenceClass;
  /** Bounded provenance cause. */
  readonly cause?: string;
  /**
   * Durable facts the evidence is bound to (job id, deployment
   * coordinates, artifact digests, provider refs, admission
   * provenance). ARTIFACT REFERENCES ONLY — large media never embeds
   * in EventEnvelope payloads (the work order's implementation
   * requirement).
   */
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MediaEvidenceOutcome {
  readonly sequence: number;
  readonly type: string;
  readonly replayed: boolean;
}

export interface MediaExecutionOpenInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly environmentId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs?: readonly string[];
  readonly constraints?: Readonly<Record<string, unknown>>;
  readonly userId?: string;
}

export interface MediaExecutionOpenOutcome {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly status: string;
}

export interface MediaExecutionLedger {
  /**
   * Establish the governed Execution a media job maps to — the
   * executions public create seam, idempotent by the supplied key (a
   * retried job submission converges on the SAME execution identity;
   * a second authoritative execution is unrepresentable).
   */
  openExecution(
    input: MediaExecutionOpenInput,
    idempotencyKey: string,
  ): Promise<MediaExecutionOpenOutcome>;

  /**
   * Append ONE media provenance record on the canonical executions
   * ledger (idempotent per the supplied key; executions owns
   * sequencing, gaplessness, append-only enforcement and status
   * preservation).
   */
  recordEvidence(input: MediaEvidenceInput, idempotencyKey: string): Promise<MediaEvidenceOutcome>;

  /** Tenant-guarded execution facts read. */
  readExecution(
    applicationId: string,
    executionId: string,
  ): Promise<{
    readonly id: string;
    readonly tenantId: string;
    readonly status: string;
  } | null>;

  /**
   * Move the job's execution into the verification state (the public
   * `verify` transition — the ONLY way the media fabric touches
   * execution status; auditable on the ledger; the verification
   * boundary is a GOVERNED execution step).
   */
  enterVerification(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;

  /** Complete the execution after the verification verdict (public `pass` transition). */
  completeExecution(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
      /**
       * The verification results bound to the completion edge (the
       * executions module's PHYSICAL discipline: a `pass` without at
       * least one PASS result never writes — "no provider-success
       * shortcut to completion"). The media fabric supplies the
       * deterministic postprocessing-shape PASS (mode none) or the
       * verification authority's PASS verdict (mode required).
       */
      readonly verificationResults: readonly MediaVerificationResult[];
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;

  /** Fail the execution (public `fail` transition — provider failure or verification rejection). */
  failExecution(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
      /** Optional verification observations recorded with the failure (e.g. a FAIL verdict). */
      readonly verificationResults?: readonly MediaVerificationResult[];
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;

  /** Cancel the execution (public `cancel` transition — job cancellation). */
  cancelExecution(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly actorId: string;
      readonly executionId: string;
      readonly reason: string;
    },
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }>;
}
