/**
 * Synthesized-program store port (tools module outbound; WORK-018).
 *
 * The durable-state seam for synthesized programs (migration 0011).
 * Contract discipline mirrors the sandbox/tool-invocation stores:
 *
 *   - submission is idempotent: the same idempotency key + the same
 *     submission fingerprint converges on the SAME durable row; a
 *     different fingerprint under a reused key fails
 *     `IDEMPOTENCY_KEY_REUSED`;
 *   - the identity core (id, toolId, version, language, source,
 *     sourceDigest, contract, expiresAt, submittedBy, idempotency
 *     key) is WRITE-ONCE — physically immutable in PostgreSQL;
 *   - status advances are GUARDED transitions: the store takes the
 *     expected `from` status and fails `INVALID_STATE_TRANSITION` on
 *     disagreement (concurrent/late replays converge on the committed
 *     row); each advance carries its evidence exactly once — the
 *     physical transition trigger makes evidence overwrites and
 *     regressions unrepresentable;
 *   - every read is scope-filtered (application + tenant);
 *     cross-tenant rows are unreachable.
 */

import type {
  SynthesisRejection,
  SynthesisRuntimeTests,
  SynthesisStaticValidation,
  SynthesizedProgramRecord,
  SynthesizedProgramStatus,
} from "../domain/synthesis";

export interface SynthesisInsertInput {
  readonly program: SynthesizedProgramRecord;
  /** The submission fingerprint (idempotency discriminator). */
  readonly submissionFingerprint: string;
}

/** Insert outcome: new durable row, or convergence on the replayed one. */
export type SynthesisInsertOutcome =
  | { readonly status: "inserted"; readonly program: SynthesizedProgramRecord }
  | { readonly status: "converged"; readonly program: SynthesizedProgramRecord };

export interface SynthesisTransitionInput {
  readonly applicationId: string;
  readonly programId: string;
  /** The caller's expected current status (guarded transition). */
  readonly from: SynthesizedProgramStatus;
  readonly to: SynthesizedProgramStatus;
  /** Static-validation evidence (required on the draft→validated advance). */
  readonly staticValidation?: SynthesisStaticValidation;
  /** Runtime-test evidence (required on the validated→usable advance). */
  readonly runtimeTests?: SynthesisRuntimeTests;
  /** Rejection evidence (required on any →rejected advance). */
  readonly rejection?: SynthesisRejection;
}

export interface SynthesisStore {
  /**
   * Insert the draft row. Converges when (application, idempotency key)
   * already holds the SAME fingerprint; fails `IDEMPOTENCY_KEY_REUSED`
   * on a different fingerprint.
   */
  insert(input: SynthesisInsertInput): Promise<SynthesisInsertOutcome>;
  /**
   * Apply one guarded lifecycle transition. Returns the committed row.
   * `INVALID_STATE_TRANSITION` on status disagreement (replay
   * convergence is the caller's re-read).
   */
  transition(input: SynthesisTransitionInput): Promise<SynthesizedProgramRecord>;
  /** Scope-filtered read (application + tenant derived from the row). */
  get(applicationId: string, programId: string): Promise<SynthesizedProgramRecord | null>;
  /** All programs of one application (bounded listing). */
  listByApplication(applicationId: string): Promise<readonly SynthesizedProgramRecord[]>;
  /** Programs usable and not yet expired as of `asOf` (the bindable set). */
  listUsable(applicationId: string, asOf: Date): Promise<readonly SynthesizedProgramRecord[]>;
}
