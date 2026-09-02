/**
 * Media generation service (deployments module application; WORK-026,
 * MOD-011/MOD-012/MOD-013).
 *
 * THE governed lifecycle of provider-neutral asynchronous media
 * generation over the WORK-023 deployment fabric. A media job MAPS TO
 * a governed Execution (architecture invariant #1 — never a separate
 * job abstraction with independent authority) and a PINNED deployment
 * plan version; every operation is idempotent, audited and
 * concurrency-safe; submissions, paid dispatches, provider
 * observations (polls and callbacks), verification outcomes, artifact
 * adoptions, cancellations, retries, failures and completion are
 * preserved as EXECUTION provenance through the executions ledger
 * (the module's media ledger port — the single canonical event path;
 * the media store is job state + the observation idempotency ledger +
 * adoption evidence, never a second event authority).
 *
 * The frozen admission ordering (the models-gateway / IMPLEMENTATION.md
 * §7 discipline — MOD-013's budget-before-paid-dispatch and the
 * capability-before-provider invariant): TENANT scope resolution →
 * POLICY admission → CAPABILITY resolution → (execution identity) →
 * BUDGET reservation → SECRET mediation → THEN the PAID rail dispatch.
 * A denial at ANY stage happens BEFORE every paid side effect and is
 * durably recorded (journal-then-fail) on the durable operation row
 * and, once the execution identity exists, on the executions ledger.
 *
 * DURABLE, RECOVERABLE OPERATION STATE (the WORK-024 crash-safety
 * standard — the architect's review bar): every operation that can
 * perform an external side effect owns ONE durable operation row
 * (pending → completed | failed) plus STABLE rail-level idempotency
 * keys. The ordering rule: the durable operation claim is written
 * BEFORE the side effect, and the durable completion AFTER every
 * durable outcome — a crash in between leaves the row PENDING, and a
 * retry RESUMES it (the rail converges by key: exactly one upstream
 * paid dispatch, ever, per job) instead of mistaking the claim for
 * convergence. A stage checkpoint marks the point of no return:
 * resumption past it NEVER re-runs admission (the decision preceded
 * the side effect) and completes the durable tail from the
 * checkpointed facts.
 *
 * ```text
 * submitJob      → input validation → deployment facts (tenant-guarded,
 *                  active, media-generation modality) → version PIN →
 *                  source-input lineage root tenant check → OP
 *                  CLAIM(job-submission) → POLICY → CAPABILITY →
 *                  execution identity (idempotent) → BUDGET reservation
 *                  (media-reserve:<jobId>, BEFORE the paid dispatch) →
 *                  SECRET mediation → deterministic PREPROCESSING →
 *                  durable job row (submitted) →
 *                  CHECKPOINT(job-recorded) → provenance (job-submitted)
 *                  → OP COMPLETE → PAID-DISPATCH OP CLAIM →
 *                  submitted→dispatching (records the reservation) →
 *                  RAIL DISPATCH (STABLE KEY mediarail:dispatch:<jobId>)
 *                  → CHECKPOINT(dispatched) → dispatching→generating
 *                  (records the opaque providerJobRef exactly once) →
 *                  budget settle → provenance (job-dispatched) → OP
 *                  COMPLETE
 * pollJob /      → job resolution (tenant + provider-ref guards) →
 * applyCallback     [poll: rail read + state NORMALIZATION] /
 *                   [callback: correlation guard — the frame's
 *                   providerJobRef must equal the job's recorded
 *                   reference; foreign/stale frames are rejected] →
 *                   OBSERVATION-APPLY OP CLAIM → observation row
 *                   (append-only, UNIQUE per key — duplicate
 *                   polls/callbacks converge) → provenance
 *                   (observation) → OP COMPLETE → [provider-completed
 *                   → JOB-COMPLETION OP CLAIM → generating→verifying →
 *                   execution verify → deterministic POSTPROCESSING
 *                   (shape check — CAN REJECT) → ARTIFACT ADOPTION
 *                   (canonical authority, lineage parents, deployment
 *                   version linkage) → CHECKPOINT(artifact-adopted) →
 *                   [verificationMode required → VERIFICATION GATE
 *                   (the verification authority's PASS verdict — CAN
 *                   REJECT)] → verifying→completed (output digest) →
 *                   execution pass (BOUND to a PASS verification
 *                   result) → provenance (artifact + job-completed) →
 *                   OP COMPLETE]
 *                  [provider-failed → generating→failed, execution
 *                   fail, failure provenance]
 *                  [provider-cancelled → generating→cancelled,
 *                   execution cancel]
 * cancelJob      → job resolution (non-terminal, pre-verification) →
 *                  POLICY(job-cancel) → JOB-CANCELLATION OP CLAIM →
 *                  RAIL CANCEL (STABLE KEY mediarail:cancel:<jobId>;
 *                  an already-terminal provider state FAILS the
 *                  cancellation closed — the provider's outcome
 *                  converges through the observation path) →
 *                  CHECKPOINT(rail-issued) → status→cancelled (budget
 *                  release when reserved) → execution cancel →
 *                  provenance → OP COMPLETE
 * retryJob       → failed job resolution → POLICY(job-submit) →
 *                  idempotent RESUBMISSION under the retry key (the
 *                  caller's key; repeated retries converge on the
 *                  SAME retry job — one job, one execution, ONE paid
 *                  dispatch) with retryOfJobId linkage and the
 *                  deterministic preprocessing digest REQUIRED to
 *                  equal the failed job's (a divergent retry intent
 *                  fails closed)
 * deriveVariant  → completed job resolution → POLICY(variant-derive)
 *                  → VARIANT-ADOPTION OP CLAIM → lineage validation
 *                  (the source artifact must exist in the tenant
 *                  namespace) → deterministic variant descriptor →
 *                  ARTIFACT ADOPTION (parents = the source artifact
 *                  digest — the lineage link is identity-bearing) →
 *                  CHECKPOINT(variant-adopted) → adoption record +
 *                  provenance (artifact) → OP COMPLETE
 * ```
 *
 * Deployment version pinning: the job pins the plan version at
 * submission; promotion/rollback on the deployment moves the pointer
 * for NEW jobs only — live jobs keep their pin and their execution
 * identity (provenance never rewritten). Provider substitution is an
 * adapter-level change behind the neutral rail seam — invisible to
 * this service and to the core Execution abstraction (AC7).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type {
  DeriveMediaVariantInput,
  MediaCallbackInput,
  MediaJobRecord,
  MediaOperationCheckpoint,
  MediaOperationKind,
  MediaOperationRecord,
  MediaProviderObservation,
  MediaVerificationMode,
  SubmitMediaJobInput,
} from "../domain/media";
import {
  deterministicMediaObservationKey,
  isTerminalMediaJobStatus,
  mediaBudgetOperationId,
  mediaContainsRawSecretValue,
  mediaEvidenceKey,
  mediaJobCreationFingerprint,
  mediaOperationKey,
  mediaOutputArtifactKey,
  mediaRailCancelKey,
  mediaRailDispatchKey,
  mediaVariantArtifactKey,
  mediaVerificationKey,
  postprocessMediaOutput,
  preprocessMediaJobSpec,
  validateDeriveMediaVariantInput,
  validateMediaCallbackInput,
  validateSubmitMediaJobInput,
} from "../domain/media";
import type { DeploymentStore } from "../ports/deployment-store";
import type {
  MediaBudgetAdmission,
  MediaCapabilityAdmission,
  MediaPolicyAdmission,
  MediaSecretMediation,
} from "../ports/media-admission";
import type { MediaArtifactAuthority } from "../ports/media-artifact-authority";
import type {
  MediaExecutionLedger,
  MediaVerificationResult,
} from "../ports/media-execution-ledger";
import type { MediaRail } from "../ports/media-rail";
import type { MediaStore } from "../ports/media-store";
import type { MediaVerificationGate } from "../ports/media-verification";

/** The read-only deployment-facts surface this service consumes. */
export type MediaDeploymentFacts = Pick<
  DeploymentStore,
  "findDeployment" | "findPlan" | "findProfile"
>;

export interface MediaActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface MediaGenerationServiceDeps {
  readonly store: MediaStore;
  /** Read-only deployment facts through the WORK-023 fabric store. */
  readonly deployments: MediaDeploymentFacts;
  /** The provider-neutral upstream media rail (replaceable infrastructure). */
  readonly rail: MediaRail;
  /** REQUIRED policy admission (no default-allow exists). */
  readonly policy: MediaPolicyAdmission;
  /** REQUIRED capability admission (capability-before-provider). */
  readonly capabilities: MediaCapabilityAdmission;
  /** REQUIRED budget admission (reservation BEFORE the paid dispatch). */
  readonly budget: MediaBudgetAdmission;
  /** REQUIRED secret mediation (rail channel credentials, references only). */
  readonly secrets: MediaSecretMediation;
  /** REQUIRED execution provenance ledger (the executions public seam). */
  readonly ledger: MediaExecutionLedger;
  /** REQUIRED canonical artifact authority (the only media-bytes plane). */
  readonly artifacts: MediaArtifactAuthority;
  /** REQUIRED verification gate (consulted when verificationMode is required). */
  readonly verification: MediaVerificationGate;
  /**
   * The rail channel's neutral connection reference (the mediated
   * credential access target — a reference, never a value).
   */
  readonly railConnectionRef: string;
  readonly digest: (canonical: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface SubmitMediaJobOutcome {
  readonly jobId: string;
  readonly executionId: string;
  readonly deploymentId: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly generationKind: string;
  readonly status: string;
  readonly submissionKey: string;
  readonly providerJobRef: string | null;
  readonly reservationId: string | null;
  readonly retryOfJobId: string | null;
  readonly replayed: boolean;
}

export interface MediaObservationApplyOutcome {
  readonly jobId: string;
  readonly observationKey: string;
  readonly observation: string;
  /** The job status AFTER the application (the projection). */
  readonly status: string;
  /** The completion tail's output artifact digest when the job completed. */
  readonly outputArtifactDigest: string | null;
  readonly replayed: boolean;
}

export interface MediaJobCancelOutcome {
  readonly jobId: string;
  readonly status: string;
  readonly executionId: string;
  readonly replayed: boolean;
}

export interface MediaVariantOutcome {
  readonly jobId: string;
  readonly artifactKey: string;
  readonly artifactDigest: string;
  readonly parentDigests: readonly string[];
  readonly executionId: string;
  readonly pinnedPlanVersion: number;
  readonly replayed: boolean;
}

/** The retry resubmission input (the generation intent must match the failed job). */
export interface RetryMediaJobInput {
  /** The bounded generation prompt (must preprocess to the failed job's digest). */
  readonly prompt: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly inputArtifactDigest?: string;
}

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const CAUSE_MAX = 2000;
const MICRO_USD_PATTERN = /^\d{1,19}$/;

function requireKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "idempotencyKey must be a non-empty printable string (max 200 chars)",
    });
  }
  return idempotencyKey;
}

function requireCause(cause: string | undefined): string | null {
  if (cause === undefined || cause === null) {
    return null;
  }
  if (typeof cause !== "string" || cause.length > CAUSE_MAX) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: `cause must be at most ${CAUSE_MAX} characters`,
    });
  }
  if (mediaContainsRawSecretValue(cause)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "cause looks like it embeds a raw secret value",
    });
  }
  return cause;
}

function isRecordish(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The deterministic PASS/FAIL result of the postprocessing shape check. */
function postprocessingResult(
  status: "PASS" | "FAIL",
  evidence: readonly string[],
): MediaVerificationResult {
  return {
    criterionId: "media-postprocessing-shape",
    strategy: "deterministic-descriptor-shape",
    status,
    evidence: [...evidence],
    recordedBy: "deployments-media-fabric",
  };
}

/** The normalized generation spec + digest pair the dispatch carries. */
function normalizedSpecOf(input: {
  readonly generationKind: SubmitMediaJobInput["generationKind"];
  readonly prompt: string;
  readonly inputArtifactDigest: string | null;
  readonly parameters: Readonly<Record<string, unknown>> | null;
}): { readonly spec: Record<string, unknown>; readonly specDigest: string } {
  const spec = preprocessMediaJobSpec({
    generationKind: input.generationKind,
    prompt: input.prompt,
    inputArtifactDigest: input.inputArtifactDigest,
    parameters: input.parameters,
  });
  return { spec: { ...spec }, specDigest: JSON.stringify(spec) };
}

export function createMediaGenerationService(deps: MediaGenerationServiceDeps) {
  const {
    store,
    deployments,
    rail,
    policy,
    capabilities,
    budget,
    secrets,
    ledger,
    artifacts,
    verification,
    railConnectionRef,
    digest,
    generateId,
    now,
  } = deps;
  const iso = () => now().toISOString();

  // -------------------------------------------------------------------------
  // Shared resolution + journaling helpers.
  // -------------------------------------------------------------------------

  /** Tenant-guarded deployment resolution. */
  const resolveDeployment = async (
    applicationId: string,
    deploymentId: string,
    tenantId: string,
  ) => {
    if (!isUuid(applicationId) || !isUuid(deploymentId)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "applicationId/deploymentId must be UUIDs",
      });
    }
    const deployment = await deployments.findDeployment(applicationId, deploymentId);
    if (deployment === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deployment ${deploymentId} not found in this application`,
      });
    }
    if (deployment.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "deployment belongs to another tenant",
      });
    }
    return deployment;
  };

  /** The pinned plan + profile facts (read-only, application-scoped). */
  const resolvePinnedPlan = async (applicationId: string, planId: string, planVersion: number) => {
    const plan = await deployments.findPlan(applicationId, planId, planVersion);
    if (plan === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `plan ${planId}@${planVersion} is not published; a media job cannot pin an unknown plan version`,
      });
    }
    const profile = await deployments.findProfile(
      applicationId,
      plan.profileRef.profileId,
      plan.profileRef.version,
    );
    if (profile === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message:
          "the pinned plan's profile is not published (deployment fabric invariant violated)",
      });
    }
    return { plan, profile };
  };

  /** Resolve a job with the tenant guard. */
  const resolveJob = async (actor: MediaActor, jobId: string) => {
    if (!isUuid(jobId)) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "jobId must be a UUID" });
    }
    const job = await store.findJob(actor.applicationId, jobId);
    if (job === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${jobId} not found in this application`,
      });
    }
    if (job.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "media job belongs to another tenant",
      });
    }
    return job;
  };

  /**
   * Journal-then-fail: durably record a denial on the operation row
   * AND (once the execution identity exists) the executions ledger.
   */
  const recordDenial = async (context: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly actorId: string;
    readonly operationKey: string | null;
    readonly jobId: string | null;
    readonly deploymentId: string;
    readonly executionId: string | null;
    readonly action: string;
    readonly code: string;
    readonly reason: string;
  }) => {
    if (context.operationKey !== null) {
      await store
        .failMediaOperation(
          context.applicationId,
          context.operationKey,
          `${context.action} denied (${context.code}): ${context.reason.slice(0, 400)}`,
          iso(),
        )
        .catch(() => undefined);
    }
    if (context.executionId !== null) {
      await ledger
        .recordEvidence(
          {
            applicationId: context.applicationId,
            tenantId: context.tenantId,
            actorId: context.actorId,
            executionId: context.executionId,
            evidenceClass: "significant-action",
            cause: `${context.action} denied (${context.code})`,
            reference: {
              jobId: context.jobId,
              deploymentId: context.deploymentId,
              deniedAction: context.action,
            },
            payload: {
              outcome: "denied",
              action: context.action,
              code: context.code,
              reason: context.reason.slice(0, 512),
            },
          },
          context.jobId === null
            ? `media:denial:${context.action}:${context.executionId}`
            : `media:${context.jobId}:denial:${context.action}`,
        )
        .catch(() => undefined);
    }
  };

  /**
   * Claim (or re-claim) the durable, recoverable operation row — the
   * crash-safety discriminator. Written BEFORE the side effect;
   * completed after every durable outcome. A crash between leaves it
   * PENDING and the retry resumes from `beginOperation`'s record.
   */
  const beginOperation = (
    kind: MediaOperationKind,
    discriminator: string,
    refs: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly jobId: string | null;
      readonly deploymentId: string;
      readonly executionId: string | null;
    },
  ) =>
    store.beginMediaOperation({
      operationId: generateId(),
      ...refs,
      operationKind: kind,
      operationKey: mediaOperationKey(kind, discriminator),
      createdAt: iso(),
    });

  /**
   * RACE-TOLERANT checkpoint write: a CONCURRENT invocation of the same
   * logical operation may complete (or durably fail) it between our
   * state check and this write — the winner owns the outcome, and our
   * durable tail converges through the stable keys (rail, executions
   * ledger, media store); a still-pending row means the write genuinely
   * failed and the error stands.
   */
  const checkpointOperation = async (
    applicationId: string,
    operationKey: string,
    checkpoint: MediaOperationCheckpoint,
  ): Promise<MediaOperationRecord | null> => {
    try {
      return await store.recordMediaOperationCheckpoint(
        applicationId,
        operationKey,
        checkpoint,
        iso(),
      );
    } catch (error) {
      if (error instanceof PlatformError && error.code === "INVALID_STATE_TRANSITION") {
        const reread = await store.findMediaOperation(applicationId, operationKey);
        if (reread !== null && reread.status !== "pending") {
          return reread;
        }
      }
      throw error;
    }
  };

  /**
   * RECOVERY-COMPLETENESS RECONCILIATION (the WORK-024 crash-safety
   * standard): a crash after a GUARDED job move but before the
   * operation row's completion leaves the row PENDING while the job
   * row already PROVES the outcome (the moves are guarded and record
   * their facts). This reconciles such rows — the job row's status +
   * the recorded rail reference are the durable proof:
   *
   *   - paid-dispatch: a job at generating or beyond (or terminal with
   *     a recorded provider reference — the generating move records
   *     the rail's reference EXACTLY ONCE, guarded) proves the paid
   *     dispatch durably happened → COMPLETED; a job that left
   *     dispatching without a provider reference (rail refusal, early
   *     cancellation) → FAILED with the recorded cause;
   *   - job-completion: a completed job → COMPLETED; a failed job →
   *     FAILED with the job's cause;
   *   - job-cancellation: a cancelled job → COMPLETED.
   *
   * Reconciliation is idempotent (terminal operation rows raise and
   * are swallowed) and never touches non-pending rows. It runs on the
   * recovery paths: the submission replay, the terminal observation
   * early-return, and the cancelled-cancellation replay.
   */
  const reconcileOperations = async (job: MediaJobRecord, actor: MediaActor): Promise<void> => {
    if (job.status === "submitted" || job.status === "dispatching") {
      return;
    }
    const dispatchKey = mediaOperationKey("paid-dispatch", job.id);
    const dispatchOp = await store
      .findMediaOperation(actor.applicationId, dispatchKey)
      .catch(() => null);
    if (dispatchOp !== null && dispatchOp.status === "pending") {
      if (job.providerJobRef !== null) {
        await store
          .completeMediaOperation(actor.applicationId, dispatchKey, iso())
          .catch(() => undefined);
      } else {
        await store
          .failMediaOperation(
            actor.applicationId,
            dispatchKey,
            job.failureCause ?? "recovered: the job left dispatching without a rail reference",
            iso(),
          )
          .catch(() => undefined);
      }
    }
    if (job.status === "completed" || job.status === "failed") {
      const completionKey = mediaOperationKey("job-completion", job.id);
      const completionOp = await store
        .findMediaOperation(actor.applicationId, completionKey)
        .catch(() => null);
      if (completionOp !== null && completionOp.status === "pending") {
        if (job.status === "completed") {
          await store
            .completeMediaOperation(actor.applicationId, completionKey, iso())
            .catch(() => undefined);
        } else {
          await store
            .failMediaOperation(
              actor.applicationId,
              completionKey,
              job.failureCause ?? "recovered: the job row reached failed",
              iso(),
            )
            .catch(() => undefined);
        }
      }
    }
    if (job.status === "cancelled") {
      const cancelKey = mediaOperationKey("job-cancellation", job.id);
      const cancelOp = await store
        .findMediaOperation(actor.applicationId, cancelKey)
        .catch(() => null);
      if (cancelOp !== null && cancelOp.status === "pending") {
        await store
          .completeMediaOperation(actor.applicationId, cancelKey, iso())
          .catch(() => undefined);
      }
    }
  };

  /** The deterministic PREPROCESSING digest over the normalized spec. */
  const preprocessingDigestOf = (input: {
    readonly generationKind: SubmitMediaJobInput["generationKind"];
    readonly prompt: string;
    readonly inputArtifactDigest: string | null;
    readonly parameters: Readonly<Record<string, unknown>> | null;
  }): string => {
    const { specDigest } = normalizedSpecOf(input);
    return digest(specDigest);
  };

  /** The rail's declared per-kind cost (the budget amount source — never a caller assertion). */
  const railCostMicroUsd = (generationKind: string): string => {
    const declared = rail.descriptor.generationCostMicroUsd[generationKind];
    if (declared === undefined || !MICRO_USD_PATTERN.test(declared)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `the rail declares no micro-USD cost for generation kind ${generationKind} (an unpriced paid dispatch is unrepresentable)`,
      });
    }
    return declared;
  };

  // -------------------------------------------------------------------------
  // The PAID DISPATCH tail (the paid-dispatch durable operation).
  // -------------------------------------------------------------------------

  /**
   * Drive (or resume) the paid dispatch of a durably-submitted job.
   * Budget admission BEFORE the paid rail dispatch (MOD-013's core);
   * the rail converges by the STABLE dispatch key — exactly one
   * upstream paid dispatch, ever, per job. The normalized generation
   * spec is supplied by the caller's (fingerprint-arbitrated) input —
   * identical across original runs and crash-resumes.
   */
  const ensureDispatched = async (
    job: MediaJobRecord,
    actor: MediaActor,
    normalized: { readonly spec: Record<string, unknown>; readonly specDigest: string },
  ) => {
    const operationKey = mediaOperationKey("paid-dispatch", job.id);
    const begun = await beginOperation("paid-dispatch", job.id, {
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      jobId: job.id,
      deploymentId: job.deploymentId,
      executionId: job.executionId,
    });
    let current = job;
    if (begun.status === "existing" && begun.record.status === "completed") {
      // A concurrent/earlier invocation completed the dispatch: the job
      // row MUST be generating or beyond (completion follows the
      // generating move).
      const converged = await store.findJob(actor.applicationId, job.id);
      if (
        converged === null ||
        converged.status === "submitted" ||
        converged.status === "dispatching"
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "media paid-dispatch operation is completed but the job row never reached generating (invariant violation)",
        });
      }
      return converged;
    }
    if (begun.status === "existing" && begun.record.status === "failed") {
      // A durably recorded dispatch failure: the job is failed (the
      // failure path moved it) — replay the recorded outcome.
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${job.id} dispatch durably failed: ${begun.record.failureReason ?? "unknown reason"}`,
      });
    }
    let providerJobRef: string | null;
    let providerStateLabel: string | null;
    let reservationId: string | null;
    let dispatchAmount: string | null = null;
    const checkpoint = begun.record.checkpoint;
    if (
      begun.status === "existing" &&
      begun.record.status === "pending" &&
      checkpoint?.stage === "dispatched"
    ) {
      // CRASH RECOVERY from the checkpoint: the rail accepted the paid
      // dispatch under the STABLE key — resume the durable tail WITHOUT
      // a second paid dispatch, WITHOUT re-running budget admission
      // (the reservation converged by operation id).
      providerJobRef = checkpoint.providerJobRef ?? null;
      providerStateLabel = checkpoint.providerStateLabel ?? null;
      reservationId = checkpoint.reservationId ?? job.reservationId;
      dispatchAmount = reservationId === null ? null : railCostMicroUsd(job.generationKind);
    } else {
      // Fresh (or un-checkpointed crash-resume — no paid side effect has
      // been acknowledged, so admission re-runs safely and every
      // converge-by-key seam re-converges) dispatch.
      // 1. BUDGET admission — the reservation BEFORE the paid dispatch
      //    (converges by operation id on resumes/concurrent duplicates).
      const amountMicroUsd = railCostMicroUsd(job.generationKind);
      const reservation = await budget.reserve({
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        executionId: job.executionId,
        operationId: mediaBudgetOperationId(job.id),
        amountMicroUsd,
        reason: `media generation paid dispatch (job ${job.id}, kind ${job.generationKind})`,
      });
      reservationId = reservation.reservationId;
      dispatchAmount = amountMicroUsd;
      // 2. The guarded dispatching move (records the reservation on the
      //    job row; first writer wins, duplicates converge; a job left
      //    in dispatching by a prior partial run skips it).
      if (current.status === "submitted") {
        const dispatching = await store.applyGuardedJobMutation({
          applicationId: actor.applicationId,
          jobId: job.id,
          expectedStatus: "submitted",
          toStatus: "dispatching",
          reservationId: reservation.reservationId,
          updatedAt: iso(),
        });
        current = dispatching.job;
      }
      // 3. THE PAID RAIL DISPATCH under the STABLE key (the only
      //    external paid side effect; idempotent by key — a crash-resume
      //    re-issue converges on the ORIGINAL acknowledgment).
      const dispatched = await rail.submitJob({
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        executionId: job.executionId,
        generationKind: job.generationKind,
        idempotencyKey: mediaRailDispatchKey(job.id),
        spec: normalized.spec,
        specDigest: digest(normalized.specDigest),
        inputArtifactDigest: job.inputArtifactDigest,
        sessionPolicy: {
          maxSessionDurationMs: 3_600_000,
          maxConcurrentSessions: 1,
        },
      });
      if (!dispatched.dispatched) {
        // The rail refused: release the reservation (best-effort — the
        // budgets authority converges by operation id), fail the job
        // (dispatching → failed), fail the execution, journal the
        // failure, durably fail the operation.
        await budget
          .release({
            actorId: actor.actorId,
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            operationId: mediaBudgetOperationId(job.id),
          })
          .catch(() => undefined);
        const cause = `rail dispatch refused: ${dispatched.reason.slice(0, 400)}`;
        await store.applyGuardedJobMutation({
          applicationId: actor.applicationId,
          jobId: job.id,
          expectedStatus: "dispatching",
          toStatus: "failed",
          failureCause: cause,
          completedAt: iso(),
          updatedAt: iso(),
        });
        await ledger
          .failExecution(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: job.executionId,
              reason: cause,
            },
            mediaEvidenceKey(job.id, "failure"),
          )
          .catch(() => undefined);
        await ledger
          .recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: job.executionId,
              evidenceClass: "failure",
              cause,
              reference: {
                jobId: job.id,
                deploymentId: job.deploymentId,
                railCapabilityId: rail.descriptor.railCapabilityId,
              },
              payload: { outcome: "dispatch-refused", reason: dispatched.reason.slice(0, 512) },
            },
            mediaEvidenceKey(job.id, "failure"),
          )
          .catch(() => undefined);
        await store
          .failMediaOperation(actor.applicationId, operationKey, cause.slice(0, 512), iso())
          .catch(() => undefined);
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the media rail refused the paid dispatch",
          details: { jobId: job.id, reason: dispatched.reason },
        });
      }
      providerJobRef = dispatched.providerJobRef;
      providerStateLabel = dispatched.providerStateLabel;
      // 4. CHECKPOINT the past-no-return facts (a crash from here on
      //    resumes the durable tail WITHOUT re-admission and without a
      //    second paid dispatch).
      await checkpointOperation(actor.applicationId, operationKey, {
        stage: "dispatched",
        jobId: job.id,
        executionId: job.executionId,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        generationKind: job.generationKind,
        providerJobRef,
        providerStateLabel,
        reservationId,
      });
    }
    // 5. The guarded generating move (records the opaque provider job
    //    reference EXACTLY once; duplicates converge on the committed
    //    row).
    const generating = await store.applyGuardedJobMutation({
      applicationId: actor.applicationId,
      jobId: job.id,
      expectedStatus: "dispatching",
      toStatus: "generating",
      providerJobRef,
      providerStateLabel,
      updatedAt: iso(),
    });
    current = generating.job;
    // 6. Budget settle (the dispatch durably succeeded — the billable
    //    operation; best-effort, converges by settle key).
    if (reservationId !== null && dispatchAmount !== null) {
      await budget
        .settle({
          actorId: actor.actorId,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          operationId: mediaBudgetOperationId(job.id),
          actualAmountMicroUsd: dispatchAmount,
        })
        .catch(() => undefined);
    }
    // 7. Provenance: the paid dispatch rides the executions ledger
    //    (REPLAY-STABLE evidence — identical for the original run and
    //    any crash-resume; the executions idempotency arbitrates by key).
    await ledger
      .recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: job.executionId,
          evidenceClass: "job-dispatched",
          cause: "media generation job paid dispatch accepted by the rail",
          reference: {
            jobId: job.id,
            deploymentId: job.deploymentId,
            pinnedPlanId: job.pinnedPlanId,
            pinnedPlanVersion: job.pinnedPlanVersion,
            generationKind: job.generationKind,
            providerJobRef,
            reservationId,
            railCapabilityId: rail.descriptor.railCapabilityId,
          },
          payload: {
            preprocessingDigest: job.preprocessingDigest,
            inputArtifactDigest: job.inputArtifactDigest,
            providerStateLabel,
          },
        },
        mediaEvidenceKey(job.id, "job-dispatched"),
      )
      .catch(() => undefined);
    // 8. The durable operation completion (a crash before this leaves
    //    the row PENDING; the retry resumes from the checkpoint).
    await store.completeMediaOperation(actor.applicationId, operationKey, iso());
    return current;
  };

  // -------------------------------------------------------------------------
  // The COMPLETION tail (the job-completion durable operation).
  // -------------------------------------------------------------------------

  /**
   * Drive (or resume) the completion boundary of a job whose provider
   * reported completion: generating → verifying → deterministic
   * postprocessing (CAN REJECT) → artifact adoption (lineage +
   * deployment version) → verification gate (when required — CAN
   * REJECT) → completed. Provider success is an OBSERVATION; the
   * completion requires the deterministic shape PASS and, when
   * configured, the verification authority's PASS verdict
   * (verification-before-completion, MOD-013/AC5).
   */
  const completeJob = async (job: MediaJobRecord, actor: MediaActor) => {
    const operationKey = mediaOperationKey("job-completion", job.id);
    const begun = await beginOperation("job-completion", job.id, {
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      jobId: job.id,
      deploymentId: job.deploymentId,
      executionId: job.executionId,
    });
    let current = job;
    if (begun.status === "existing" && begun.record.status === "completed") {
      const converged = await store.findJob(actor.applicationId, job.id);
      if (converged === null || !isTerminalMediaJobStatus(converged.status)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "media job-completion operation is completed but the job row is not terminal (invariant violation)",
        });
      }
      return converged;
    }
    if (begun.status === "existing" && begun.record.status === "failed") {
      const converged = await store.findJob(actor.applicationId, job.id);
      if (converged !== null && converged.status === "failed") {
        return converged;
      }
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${job.id} completion durably failed: ${begun.record.failureReason ?? "unknown reason"}`,
      });
    }
    // 1. The guarded verifying move + the governed execution verify
    //    transition (RUNNING → VERIFYING — the boundary is a governed
    //    step, auditable on the ledger).
    if (current.status === "generating") {
      const verifying = await store.applyGuardedJobMutation({
        applicationId: actor.applicationId,
        jobId: job.id,
        expectedStatus: "generating",
        toStatus: "verifying",
        updatedAt: iso(),
      });
      current = verifying.job;
      await ledger
        .enterVerification(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            reason: "media generation provider completion observed — the verification boundary",
          },
          mediaEvidenceKey(job.id, "verify"),
        )
        .catch(() => undefined);
    }
    // 2. The deterministic POSTPROCESSING shape check over the
    //    provider's normalized output descriptor (the latest completion
    //    observation's descriptor; the checkpoint may carry the digest).
    const checkpoint = begun.record.checkpoint;
    let descriptor: Record<string, unknown> | null = null;
    let descriptorDigest: string | null = null;
    let outputArtifactDigest: string | null = current.outputArtifactDigest;
    const completionObservations = await store.listObservations(actor.applicationId, job.id);
    const completion = completionObservations.find(
      (observation) => observation.observation === "provider-completed",
    );
    const providerOutput = completion?.outputDescriptor ?? null;
    if (providerOutput !== null) {
      try {
        const postprocessed = postprocessMediaOutput({
          generationKind: job.generationKind,
          providerOutput,
        });
        descriptor = { ...postprocessed.descriptor };
        descriptorDigest = digest(JSON.stringify(postprocessed.descriptor));
        outputArtifactDigest = String(postprocessed.descriptor.contentDigest);
      } catch (error) {
        // DETERMINISTIC REJECTION: the shape check failed — the job
        // NEVER completes with an invalid output (AC5's deterministic
        // half; the executions ledger records the FAIL verdict).
        const cause =
          error instanceof Error
            ? error.message
            : "deterministic postprocessing rejected the output";
        await store.applyGuardedJobMutation({
          applicationId: actor.applicationId,
          jobId: job.id,
          expectedStatus: current.status === "verifying" ? "verifying" : "generating",
          toStatus: "failed",
          failureCause: cause.slice(0, 2000),
          completedAt: iso(),
          updatedAt: iso(),
        });
        await ledger
          .failExecution(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: job.executionId,
              reason: cause.slice(0, 2000),
              verificationResults: [postprocessingResult("FAIL", [`job:${job.id}`])],
            },
            mediaEvidenceKey(job.id, "failure"),
          )
          .catch(() => undefined);
        await ledger
          .recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: job.executionId,
              evidenceClass: "failure",
              cause: cause.slice(0, 2000),
              reference: { jobId: job.id, observationKey: completion?.observationKey ?? null },
              payload: { outcome: "postprocessing-rejected" },
            },
            mediaEvidenceKey(job.id, "failure"),
          )
          .catch(() => undefined);
        await store
          .failMediaOperation(actor.applicationId, operationKey, cause.slice(0, 512), iso())
          .catch(() => undefined);
        throw new PlatformError({
          code: "VERIFICATION_FAILED",
          message: `media generation output rejected by deterministic postprocessing: ${cause.slice(0, 400)}`,
          details: { jobId: job.id },
        });
      }
    }
    if (outputArtifactDigest === null && checkpoint?.outputArtifactDigest === undefined) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job ${job.id} reported completion without an output descriptor`,
      });
    }
    if (outputArtifactDigest === null && checkpoint?.outputArtifactDigest != null) {
      outputArtifactDigest = checkpoint.outputArtifactDigest;
    }
    // 3. The ARTIFACT ADOPTION (the canonical authority — put-if-absent,
    //    lineage-bearing, tenant-isolated; converges on identical
    //    inputs — the crash-resume adoption converges by content).
    let artifactKey: string | null =
      current.status === "completed" || checkpoint?.artifactKey != null
        ? (checkpoint?.artifactKey ?? mediaOutputArtifactKey(job.id))
        : null;
    if (current.status === "verifying" && descriptor !== null && descriptorDigest !== null) {
      const adoption = await artifacts.adoptArtifact({
        tenantId: actor.tenantId,
        applicationId: actor.applicationId,
        role: "generated-output",
        descriptor,
        parents: job.inputArtifactDigest === null ? [] : [job.inputArtifactDigest],
        sourceRefs: [
          { kind: "source", id: job.executionId, locator: `execution:${job.executionId}` },
          {
            kind: "source",
            id: job.deploymentId,
            locator: `deployment:${job.deploymentId}@${job.pinnedPlanVersion}`,
          },
          { kind: "source", id: job.id, locator: `media-job:${job.id}` },
        ],
      });
      outputArtifactDigest = adoption.digest;
      artifactKey = mediaOutputArtifactKey(job.id);
      // CHECKPOINT the past-no-return facts (a crash from here resumes
      // the verification + terminal tail WITHOUT re-adoption — the
      // adoption converges by content identity anyway).
      await checkpointOperation(actor.applicationId, operationKey, {
        stage: "artifact-adopted",
        jobId: job.id,
        executionId: job.executionId,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        generationKind: job.generationKind,
        outputArtifactDigest: adoption.digest,
        artifactKey,
        parentDigests: job.inputArtifactDigest === null ? [] : [job.inputArtifactDigest],
      });
      // The adoption record (write-once; converges on the physical key).
      await store.insertArtifact({
        artifactRowId: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        executionId: job.executionId,
        role: "generated-output",
        artifactKey,
        artifactDigest: adoption.digest,
        parentDigests: job.inputArtifactDigest === null ? [] : [job.inputArtifactDigest],
        descriptorDigest,
        ledgerSequence: null,
        createdBy: actor.actorId,
        createdAt: iso(),
      });
    }
    // 4. The VERIFICATION GATE (mode required ONLY — the verification
    //    authority's PASS verdict controls completion; provider success
    //    is an observation, never a verdict; INCONCLUSIVE is never
    //    acceptance).
    const verificationResults: MediaVerificationResult[] = [];
    let verificationEvaluationId: string | null = null;
    if (job.verificationMode === "required") {
      if (outputArtifactDigest === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `media job ${job.id} cannot enter the verification gate without an adopted output artifact`,
        });
      }
      const verdict = await verification.verify(
        {
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          actorId: actor.actorId,
          executionId: job.executionId,
          jobId: job.id,
          outputArtifactDigest,
          criteria: job.verificationCriteria,
          facts: {
            generationKind: job.generationKind,
            postprocessingDigest: job.postprocessingDigest ?? descriptorDigest,
            outputArtifactDigest,
            descriptor,
          },
          evidenceRefs: [
            `artifact:${outputArtifactDigest}`,
            artifactKey === null ? `job:${job.id}` : `artifact-record:${artifactKey}`,
          ],
        },
        mediaVerificationKey(job.id),
      );
      verificationEvaluationId = verdict.evaluationId;
      if (!verdict.criteriaMet) {
        // VERIFICATION REJECTION: the output is never marked complete.
        const cause = `verification rejected by the verification authority (evaluation ${verdict.evaluationId})`;
        await store.applyGuardedJobMutation({
          applicationId: actor.applicationId,
          jobId: job.id,
          expectedStatus: current.status === "completed" ? "completed" : "verifying",
          toStatus: "failed",
          failureCause: cause,
          completedAt: iso(),
          updatedAt: iso(),
        });
        await ledger
          .failExecution(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: job.executionId,
              reason: cause,
              verificationResults: job.verificationCriteria.map((ref) => ({
                criterionId: ref.criterionId,
                strategy: "verification-authority",
                status: "FAIL" as const,
                evidence: [
                  `evaluation:${verdict.evaluationId}`,
                  `artifact:${outputArtifactDigest}`,
                ],
                recordedBy: "verification-authority",
              })),
            },
            mediaEvidenceKey(job.id, "failure"),
          )
          .catch(() => undefined);
        await ledger
          .recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: job.executionId,
              evidenceClass: "verification",
              cause,
              reference: {
                jobId: job.id,
                evaluationId: verdict.evaluationId,
                outputArtifactDigest,
              },
              payload: { outcome: "rejected", criteriaMet: false },
            },
            mediaEvidenceKey(job.id, "verification"),
          )
          .catch(() => undefined);
        await store
          .failMediaOperation(actor.applicationId, operationKey, cause.slice(0, 512), iso())
          .catch(() => undefined);
        throw new PlatformError({
          code: "VERIFICATION_FAILED",
          message: "media generation output rejected by the verification authority",
          details: { jobId: job.id, evaluationId: verdict.evaluationId },
        });
      }
      verificationResults.push(
        ...job.verificationCriteria.map((ref) => ({
          criterionId: ref.criterionId,
          strategy: "verification-authority",
          status: "PASS" as const,
          evidence: [`evaluation:${verdict.evaluationId}`, `artifact:${outputArtifactDigest}`],
          recordedBy: "verification-authority",
        })),
      );
    } else {
      // Mode none: the deterministic postprocessing shape check is the
      // controlling boundary — its PASS result satisfies the executions
      // completion binding (no provider-success shortcut exists).
      verificationResults.push(
        postprocessingResult("PASS", [
          `postprocessing:${descriptorDigest ?? job.postprocessingDigest ?? job.id}`,
          `artifact:${outputArtifactDigest ?? job.id}`,
        ]),
      );
    }
    // 5. The guarded COMPLETION move (verifying → completed; records the
    //    output artifact digest — the migration's projection guard
    //    allows output digests ONLY on completed rows: the
    //    verification-before-completion projection).
    if (current.status === "verifying") {
      const completed = await store.applyGuardedJobMutation({
        applicationId: actor.applicationId,
        jobId: job.id,
        expectedStatus: "verifying",
        toStatus: "completed",
        postprocessingDigest: descriptorDigest ?? job.postprocessingDigest,
        outputArtifactDigest,
        completedAt: iso(),
        updatedAt: iso(),
      });
      current = completed.job;
    }
    // 6. The execution completion (public `pass` transition — BOUND to
    //    the PASS verification results; idempotent by the stable key).
    await ledger
      .completeExecution(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: job.executionId,
          reason: "media generation job completed through the verification boundary",
          verificationResults,
        },
        mediaEvidenceKey(job.id, "job-completed"),
      )
      .catch(() => undefined);
    // 7. Provenance: the artifact adoption + the completion.
    if (artifactKey !== null && outputArtifactDigest !== null) {
      await ledger
        .recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            evidenceClass: "artifact",
            cause: "generated media output adopted as a lineage artifact",
            reference: {
              jobId: job.id,
              deploymentId: job.deploymentId,
              pinnedPlanId: job.pinnedPlanId,
              pinnedPlanVersion: job.pinnedPlanVersion,
              artifactKey,
              artifactDigest: outputArtifactDigest,
              parentDigests: job.inputArtifactDigest === null ? [] : [job.inputArtifactDigest],
            },
            payload: { role: "generated-output", descriptorDigest: descriptorDigest ?? null },
          },
          mediaEvidenceKey(job.id, "artifact"),
        )
        .catch(() => undefined);
    }
    await ledger
      .recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: job.executionId,
          evidenceClass: "job-completed",
          cause: "media generation job completed",
          reference: {
            jobId: job.id,
            deploymentId: job.deploymentId,
            outputArtifactDigest,
            verificationMode: job.verificationMode,
            ...(verificationEvaluationId === null ? {} : { verificationEvaluationId }),
          },
          payload: {
            generationKind: job.generationKind,
            postprocessingDigest: job.postprocessingDigest,
            verifiedByAuthority: job.verificationMode === "required",
          },
        },
        mediaEvidenceKey(job.id, "job-completed"),
      )
      .catch(() => undefined);
    // 8. The durable operation completion.
    await store.completeMediaOperation(actor.applicationId, operationKey, iso());
    return current;
  };

  // -------------------------------------------------------------------------
  // The OBSERVATION application (the observation-apply durable operation).
  // -------------------------------------------------------------------------

  /**
   * Apply one normalized provider observation (poll or callback) to a
   * job: append the deduplicated evidence row, project the lifecycle
   * (provider-failed → failed; provider-cancelled → cancelled;
   * provider-completed → the completion boundary) and record the
   * provenance. Duplicate observations converge on the physical
   * observation key — exactly one application, ever, per key.
   */
  const applyObservation = async (
    job: MediaJobRecord,
    frame: {
      readonly source: "poll" | "callback";
      readonly observationKey: string;
      readonly observation: MediaProviderObservation;
      readonly providerJobRef: string | null;
      readonly providerStateLabel: string | null;
      readonly progress: number | null;
      readonly outputDescriptor: Readonly<Record<string, unknown>> | null;
    },
    actor: MediaActor,
  ): Promise<MediaObservationApplyOutcome> => {
    const operationKey = mediaOperationKey(
      "observation-apply",
      `${job.id}:${frame.observationKey}`,
    );
    const begun = await beginOperation("observation-apply", `${job.id}:${frame.observationKey}`, {
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      jobId: job.id,
      deploymentId: job.deploymentId,
      executionId: job.executionId,
    });
    if (begun.status === "existing" && begun.record.status === "completed") {
      // A completed application: the observation row + evidence exist.
      // CRASH RECOVERY of the projection tail: a crash after the
      // observation-apply completion but before the completion
      // boundary's terminal move leaves the job at `generating` or
      // `verifying` with a durable provider-completed observation —
      // the completion tail (its OWN durable operation) resumes HERE
      // (the observation row is the durable fact; no second admission
      // is possible). A TERMINAL converged job instead reconciles any
      // operation row a crash left PENDING after the guarded terminal
      // move (the job row already proves the outcome).
      const convergedJob = await store.findJob(actor.applicationId, job.id);
      if (
        convergedJob !== null &&
        (convergedJob.status === "generating" || convergedJob.status === "verifying") &&
        frame.observation === "provider-completed"
      ) {
        const completed = await completeJob(convergedJob, actor);
        return {
          jobId: job.id,
          observationKey: frame.observationKey,
          observation: frame.observation,
          status: completed.status,
          outputArtifactDigest: completed.outputArtifactDigest,
          replayed: true,
        };
      }
      if (convergedJob !== null && isTerminalMediaJobStatus(convergedJob.status)) {
        await reconcileOperations(convergedJob, actor);
      }
      return {
        jobId: job.id,
        observationKey: frame.observationKey,
        observation: frame.observation,
        status: convergedJob?.status ?? job.status,
        outputArtifactDigest: convergedJob?.outputArtifactDigest ?? null,
        replayed: true,
      };
    }
    // 1. The append-only, deduplicated observation EVIDENCE row (the
    //    observation idempotency ledger: the physical UNIQUE per
    //    (application, job, observation key) arbitrates duplicates; a
    //    same-key/different-body replay fails closed).
    const appended = await store.appendObservation({
      observationId: generateId(),
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      jobId: job.id,
      deploymentId: job.deploymentId,
      observationKey: frame.observationKey,
      source: frame.source,
      observation: frame.observation,
      providerJobRef: frame.providerJobRef,
      providerStateLabel: frame.providerStateLabel,
      progress: frame.progress,
      outputDescriptor: frame.outputDescriptor,
      executionId: job.executionId,
      ledgerSequence: null,
      actorId: actor.actorId,
      createdAt: iso(),
    });
    const replayed = appended.status === "converged";
    // 2. Provenance: the observation rides the executions ledger.
    await ledger
      .recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: job.executionId,
          evidenceClass: "observation",
          cause: `media provider observation (${frame.source}): ${frame.observation}`,
          reference: {
            jobId: job.id,
            deploymentId: job.deploymentId,
            observationKey: frame.observationKey,
            providerJobRef: frame.providerJobRef,
          },
          payload: {
            observation: frame.observation,
            source: frame.source,
            providerStateLabel: frame.providerStateLabel,
            progress: frame.progress,
            outputDescriptor: frame.outputDescriptor,
          },
        },
        mediaEvidenceKey(job.id, `observation:${frame.observationKey}`),
      )
      .catch(() => undefined);
    await store.completeMediaOperation(actor.applicationId, operationKey, iso());
    // 3. The lifecycle projection (guarded; terminal jobs only record
    //    the evidence — late observations never drive state).
    const afterAppend = await store.findJob(actor.applicationId, job.id);
    const current = afterAppend ?? job;
    if (isTerminalMediaJobStatus(current.status)) {
      // Recover any operation rows a crash left PENDING after the job
      // row already reached its terminal outcome.
      await reconcileOperations(current, actor);
      return {
        jobId: job.id,
        observationKey: frame.observationKey,
        observation: frame.observation,
        status: current.status,
        outputArtifactDigest: current.outputArtifactDigest,
        replayed,
      };
    }
    if (frame.observation === "provider-failed") {
      const cause = `provider failure observed: ${frame.providerStateLabel ?? "provider-failed"}`;
      const failed = await store.applyGuardedJobMutation({
        applicationId: actor.applicationId,
        jobId: job.id,
        expectedStatus: current.status,
        toStatus: "failed",
        failureCause: cause,
        providerStateLabel: frame.providerStateLabel,
        completedAt: iso(),
        updatedAt: iso(),
      });
      await ledger
        .failExecution(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            reason: cause,
          },
          mediaEvidenceKey(job.id, "failure"),
        )
        .catch(() => undefined);
      await ledger
        .recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            evidenceClass: "failure",
            cause,
            reference: {
              jobId: job.id,
              observationKey: frame.observationKey,
              providerJobRef: frame.providerJobRef,
            },
            payload: { outcome: "provider-failed", observationKey: frame.observationKey },
          },
          mediaEvidenceKey(job.id, "failure"),
        )
        .catch(() => undefined);
      // Recover any operation rows a crash left PENDING (the job row's
      // terminal outcome is the durable proof).
      await reconcileOperations(failed.job, actor);
      return {
        jobId: job.id,
        observationKey: frame.observationKey,
        observation: frame.observation,
        status: failed.job.status,
        outputArtifactDigest: null,
        replayed,
      };
    }
    if (frame.observation === "provider-cancelled") {
      const cause = `provider cancellation observed: ${frame.providerStateLabel ?? "provider-cancelled"}`;
      const cancelled = await store.applyGuardedJobMutation({
        applicationId: actor.applicationId,
        jobId: job.id,
        expectedStatus: current.status,
        toStatus: "cancelled",
        providerStateLabel: frame.providerStateLabel,
        completedAt: iso(),
        updatedAt: iso(),
      });
      await ledger
        .cancelExecution(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            reason: cause,
          },
          mediaEvidenceKey(job.id, "cancellation"),
        )
        .catch(() => undefined);
      // Recover any operation rows a crash left PENDING (the job row's
      // terminal outcome is the durable proof).
      await reconcileOperations(cancelled.job, actor);
      return {
        jobId: job.id,
        observationKey: frame.observationKey,
        observation: frame.observation,
        status: cancelled.job.status,
        outputArtifactDigest: null,
        replayed,
      };
    }
    if (frame.observation === "provider-completed") {
      const completed = await completeJob(current, actor);
      return {
        jobId: job.id,
        observationKey: frame.observationKey,
        observation: frame.observation,
        status: completed.status,
        outputArtifactDigest: completed.outputArtifactDigest,
        replayed,
      };
    }
    // accepted / progressed: evidence only (the job stays generating).
    // Recover any operation row a crash left PENDING after its guarded
    // job move already proved the outcome (e.g. the paid-dispatch row
    // after a crash between the guarded generating move and the
    // operation completion — the job row at generating with its rail
    // reference is the durable proof).
    await reconcileOperations(current, actor);
    return {
      jobId: job.id,
      observationKey: frame.observationKey,
      observation: frame.observation,
      status: current.status,
      outputArtifactDigest: null,
      replayed,
    };
  };

  // -------------------------------------------------------------------------
  // The submission core (shared by submitJob and retryJob).
  // -------------------------------------------------------------------------

  const submitJobInternal = async (
    input: SubmitMediaJobInput,
    idempotencyKey: string,
    actor: MediaActor,
    retryOfJobId: string | null,
  ): Promise<SubmitMediaJobOutcome> => {
    requireKey(idempotencyKey);
    const check = validateSubmitMediaJobInput(input);
    if (!check.valid) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
    }
    const operationKey = mediaOperationKey("job-submission", idempotencyKey);
    // The normalized generation spec (the deterministic preprocessing
    // output — identical across original runs and crash-resumes; the
    // creation fingerprint arbitrates the replay).
    const normalized = normalizedSpecOf({
      generationKind: input.generationKind,
      prompt: input.prompt,
      inputArtifactDigest: input.inputArtifactDigest ?? null,
      parameters: input.parameters ?? null,
    });
    // The idempotent-replay fast path: a retried submission converges
    // on the SAME job + execution identity, WITH creation-fingerprint
    // arbitration (the same key with a DIFFERENT body fails closed).
    const replayed = await store.findJobBySubmissionKey(actor.applicationId, idempotencyKey);
    if (replayed !== null) {
      const expectedFingerprint = mediaJobCreationFingerprint(
        actor.applicationId,
        input,
        replayed.executionId,
      );
      if (replayed.creationFingerprint !== expectedFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "media job submission key already exists with a different creation fingerprint",
          details: { jobId: replayed.id },
        });
      }
      if (retryOfJobId !== null && replayed.retryOfJobId !== retryOfJobId) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "media retry key already exists against a different failed job",
          details: { retryJobId: replayed.id },
        });
      }
      // CRASH RECOVERY: the job row exists but a durable tail may be
      // incomplete (the dispatch, the completion) — resume it instead
      // of returning the gap.
      let job = replayed;
      if (job.status === "submitted" || job.status === "dispatching") {
        job = await ensureDispatched(job, actor, normalized);
      }
      if (job.status === "verifying") {
        job = await completeJob(job, actor);
      }
      // Recover any operation rows a crash left PENDING after their
      // guarded job move already proved the outcome.
      await reconcileOperations(job, actor);
      const op = await store.findMediaOperation(actor.applicationId, operationKey);
      if (op !== null && op.status === "pending") {
        // The submission operation itself was left pending (a crash
        // between the checkpoint and the completion): complete the
        // tail — the provenance already converged by key.
        await store.completeMediaOperation(actor.applicationId, operationKey, iso());
      }
      return {
        jobId: job.id,
        executionId: job.executionId,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        generationKind: job.generationKind,
        status: job.status,
        submissionKey: job.submissionKey,
        providerJobRef: job.providerJobRef,
        reservationId: job.reservationId,
        retryOfJobId: job.retryOfJobId,
        replayed: true,
      };
    }
    // 0. The durable operation claim — BEFORE every side effect (a
    //    crash anywhere below leaves this row PENDING; the retry
    //    resumes from its checkpoint).
    const jobId = generateId();
    const begun = await beginOperation("job-submission", idempotencyKey, {
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      jobId,
      deploymentId: input.deploymentId,
      executionId: null,
    });
    if (begun.status === "existing" && begun.record.status === "completed") {
      // A concurrent invocation completed this submission: its job row
      // MUST exist (completion follows the durable insert).
      const converged = await store.findJobBySubmissionKey(actor.applicationId, idempotencyKey);
      if (converged === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "media job submission operation is completed but its job row is absent (invariant violation)",
        });
      }
      return {
        jobId: converged.id,
        executionId: converged.executionId,
        deploymentId: converged.deploymentId,
        pinnedPlanId: converged.pinnedPlanId,
        pinnedPlanVersion: converged.pinnedPlanVersion,
        generationKind: converged.generationKind,
        status: converged.status,
        submissionKey: converged.submissionKey,
        providerJobRef: converged.providerJobRef,
        reservationId: converged.reservationId,
        retryOfJobId: converged.retryOfJobId,
        replayed: true,
      };
    }
    if (begun.status === "existing" && begun.record.status === "failed") {
      // A durably recorded submission failure (an admission denial):
      // replay the recorded outcome — idempotent denial, no duplicate
      // side effects, no stuck job row.
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `media job submission durably failed: ${begun.record.failureReason ?? "unknown reason"}`,
      });
    }
    const checkpoint = begun.record.checkpoint;
    if (
      begun.status === "existing" &&
      begun.record.status === "pending" &&
      checkpoint?.stage === "job-recorded"
    ) {
      // CRASH RECOVERY from the checkpoint: the durable job row exists
      // — resume the provenance tail + the dispatch WITHOUT re-running
      // admission (the decision preceded the side effects).
      const recovered = await store.findJob(actor.applicationId, checkpoint.jobId ?? "");
      if (recovered === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "media job submission checkpointed a job row that is absent (invariant violation)",
        });
      }
      await store.completeMediaOperation(actor.applicationId, operationKey, iso());
      const dispatched = await ensureDispatched(recovered, actor, normalized);
      return {
        jobId: dispatched.id,
        executionId: dispatched.executionId,
        deploymentId: dispatched.deploymentId,
        pinnedPlanId: dispatched.pinnedPlanId,
        pinnedPlanVersion: dispatched.pinnedPlanVersion,
        generationKind: dispatched.generationKind,
        status: dispatched.status,
        submissionKey: dispatched.submissionKey,
        providerJobRef: dispatched.providerJobRef,
        reservationId: dispatched.reservationId,
        retryOfJobId: dispatched.retryOfJobId,
        replayed: true,
      };
    }
    // 1. TENANT — server-derived scope + deployment facts (the
    //    media-generation modality gate).
    const deployment = await resolveDeployment(
      actor.applicationId,
      input.deploymentId,
      actor.tenantId,
    );
    if (deployment.status !== "active") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `deployment ${deployment.slug} is ${deployment.status}; media jobs submit only on active deployments`,
      });
    }
    // 2. Version PIN: the deployment's CURRENT plan version at
    //    submission (promotion/rollback moves the pointer for NEW jobs
    //    only — AC7).
    const pinned = await resolvePinnedPlan(
      actor.applicationId,
      deployment.currentPlanId,
      deployment.currentPlanVersion,
    );
    const { plan, profile } = pinned;
    if (profile.modality !== "media-generation") {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deployment profile modality is ${profile.modality}; media generation jobs require the media-generation modality`,
      });
    }
    // 3. The source-input artifact lineage root must exist in the
    //    CALLER's tenant namespace (tenant isolation for inputs).
    if (input.inputArtifactDigest !== undefined) {
      const inputExists = await artifacts.artifactExists(
        { tenantId: actor.tenantId },
        input.inputArtifactDigest,
      );
      if (!inputExists) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message:
            "the source-input artifact is absent from this tenant namespace (media jobs transform tenant-visible artifacts only)",
        });
      }
    }
    // 4. POLICY — the job-submit admission (BEFORE every side effect).
    const decision = await policy.admit({
      tenantId: actor.tenantId,
      applicationId: actor.applicationId,
      jobId: null,
      deploymentId: deployment.id,
      action: "job-submit",
      generationKind: input.generationKind,
      railCapabilityId: rail.descriptor.railCapabilityId,
      secretRef: railConnectionRef,
    });
    if (!decision.allowed) {
      await recordDenial({
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        operationKey,
        jobId: null,
        deploymentId: deployment.id,
        executionId: null,
        action: "job-submit",
        code: "POLICY_DENIED",
        reason: decision.reason,
      });
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "media job submission denied by admission policy",
        details: { deploymentId: deployment.id, reason: decision.reason },
      });
    }
    // 5. CAPABILITY — the pinned plan's capabilities + the rail's
    //    adapter capability + the generation-kind atom (capability
    //    BEFORE provider — the rail is dispatched only after this).
    const capabilityDecision = await capabilities.resolve({
      tenantId: actor.tenantId,
      applicationId: actor.applicationId,
      jobId: null,
      requiredCapabilities: profile.requiredCapabilities,
      railCapabilityId: rail.descriptor.railCapabilityId,
      generationKind: input.generationKind,
    });
    if (!capabilityDecision.satisfied) {
      await recordDenial({
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        operationKey,
        jobId: null,
        deploymentId: deployment.id,
        executionId: null,
        action: "job-submit",
        code: "CAPABILITY_UNAVAILABLE",
        reason: `unmet capabilities: ${capabilityDecision.unmet.join(", ")}`,
      });
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "media job submission denied: unmet capabilities",
        details: { unmet: capabilityDecision.unmet },
      });
    }
    // 6. Execution identity (idempotent by key — the single birth path;
    //    a retried submission converges on the SAME execution; a second
    //    authoritative execution is unrepresentable).
    const execution = await ledger.openExecution(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        environmentId: deployment.environmentId,
        task: {
          kind: "media-generation-job",
          deploymentId: deployment.id,
          planId: plan.planId,
          planVersion: plan.version,
          generationKind: input.generationKind,
        },
        ...(input.inputArtifactDigest === undefined
          ? {}
          : { inputArtifactRefs: [input.inputArtifactDigest] }),
      },
      `${idempotencyKey}:execution`,
    );
    // 7. BUDGET — the reservation BEFORE the paid dispatch (the amount
    //    is the RAIL's declared per-kind cost, never a caller
    //    assertion). A denial fails the submission closed: the execution
    //    is failed, the reservation is never made, the operation row
    //    records the denial — zero paid dispatches (MOD-013's core).
    let reservationId: string | null = null;
    let reservedAmount: string | null = null;
    try {
      const reservation = await budget.reserve({
        actorId: actor.actorId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        executionId: execution.executionId,
        operationId: mediaBudgetOperationId(jobId),
        amountMicroUsd: railCostMicroUsd(input.generationKind),
        reason: `media generation paid dispatch (job ${jobId}, kind ${input.generationKind})`,
      });
      reservationId = reservation.reservationId;
      reservedAmount = reservation.amountMicroUsd;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "budget admission failed";
      await ledger
        .failExecution(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: execution.executionId,
            reason: `media job submission denied: ${reason.slice(0, 400)}`,
          },
          mediaEvidenceKey(jobId, "failure"),
        )
        .catch(() => undefined);
      await recordDenial({
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        operationKey,
        jobId: null,
        deploymentId: deployment.id,
        executionId: execution.executionId,
        action: "job-submit",
        code: "BUDGET_EXCEEDED",
        reason,
      });
      throw error;
    }
    // 8. SECRET — mediated access for the rail channel's credential
    //    (references only; a missing/inactive credential fails closed).
    const mediation = await secrets.mediate({
      tenantId: actor.tenantId,
      applicationId: actor.applicationId,
      jobId: null,
      connectionRef: railConnectionRef,
    });
    if (!mediation.mediated) {
      await ledger
        .failExecution(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: execution.executionId,
            reason: `media job submission denied: ${mediation.reason.slice(0, 400)}`,
          },
          mediaEvidenceKey(jobId, "failure"),
        )
        .catch(() => undefined);
      await budget
        .release({
          actorId: actor.actorId,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          operationId: mediaBudgetOperationId(jobId),
        })
        .catch(() => undefined);
      await recordDenial({
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        operationKey,
        jobId: null,
        deploymentId: deployment.id,
        executionId: execution.executionId,
        action: "job-submit",
        code: "PROVIDER_ERROR",
        reason: mediation.reason,
      });
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "media job submission denied: the rail channel credential is unavailable",
        details: { reason: mediation.reason },
      });
    }
    // 9. The durable job row (submitted — the admission chain passed;
    //    the paid dispatch follows as its OWN durable operation). The
    //    preprocessing digest is the normalized spec's digest.
    const preprocessingDigest = digest(normalized.specDigest);
    const verificationMode: MediaVerificationMode =
      input.verification === undefined ? "none" : "required";
    const fingerprint = mediaJobCreationFingerprint(
      actor.applicationId,
      input,
      execution.executionId,
    );
    const durableJobId = begun.record.jobId ?? jobId;
    const insert = await store.insertJob({
      jobId: durableJobId,
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      deploymentId: deployment.id,
      pinnedPlanId: plan.planId,
      pinnedPlanVersion: plan.version,
      executionId: execution.executionId,
      generationKind: input.generationKind,
      submissionKey: idempotencyKey,
      creationFingerprint: fingerprint,
      verificationMode,
      verificationCriteria:
        input.verification === undefined ? [] : [...input.verification.criteria],
      preprocessingDigest,
      inputArtifactDigest: input.inputArtifactDigest ?? null,
      retryOfJobId,
      createdBy: actor.actorId,
      createdAt: iso(),
    });
    // 10. CHECKPOINT the past-no-return facts (a crash from here
    //     resumes the provenance + dispatch tail WITHOUT re-admission).
    await checkpointOperation(actor.applicationId, operationKey, {
      stage: "job-recorded",
      jobId: durableJobId,
      executionId: execution.executionId,
      deploymentId: deployment.id,
      pinnedPlanId: plan.planId,
      pinnedPlanVersion: plan.version,
      generationKind: input.generationKind,
      verificationMode,
    });
    // 11. Provenance: the submission rides the executions ledger.
    await ledger
      .recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: execution.executionId,
          evidenceClass: "job-submitted",
          cause:
            retryOfJobId === null
              ? "media generation job submitted on the deployment fabric"
              : `media generation job submitted as an idempotent retry of job ${retryOfJobId}`,
          reference: {
            jobId: durableJobId,
            deploymentId: deployment.id,
            pinnedPlanId: plan.planId,
            pinnedPlanVersion: plan.version,
            generationKind: input.generationKind,
            submissionKey: idempotencyKey,
            ...(retryOfJobId === null ? {} : { retryOfJobId }),
          },
          payload: {
            verificationMode,
            preprocessingDigest,
            inputArtifactDigest: input.inputArtifactDigest ?? null,
            railCapabilityId: rail.descriptor.railCapabilityId,
            policySet: decision.evidence?.policySetId ?? null,
            ...(reservationId === null ? {} : { reservationId, reservedAmount }),
          },
        },
        mediaEvidenceKey(durableJobId, "job-submitted"),
      )
      .catch(() => undefined);
    // 12. The job-submission operation completes (the dispatch is its
    //     OWN durable operation below).
    await store.completeMediaOperation(actor.applicationId, operationKey, iso());
    // 13. The PAID DISPATCH (its own durable operation + stable rail
    //     key — exactly one upstream paid dispatch, ever).
    const jobRow = await store.findJob(actor.applicationId, durableJobId);
    const dispatchTarget = jobRow ?? insert.job;
    const dispatched = await ensureDispatched(dispatchTarget, actor, normalized);
    return {
      jobId: dispatched.id,
      executionId: dispatched.executionId,
      deploymentId: dispatched.deploymentId,
      pinnedPlanId: dispatched.pinnedPlanId,
      pinnedPlanVersion: dispatched.pinnedPlanVersion,
      generationKind: dispatched.generationKind,
      status: dispatched.status,
      submissionKey: dispatched.submissionKey,
      providerJobRef: dispatched.providerJobRef,
      reservationId: dispatched.reservationId,
      retryOfJobId: dispatched.retryOfJobId,
      replayed: execution.replayed || insert.status === "converged" || begun.status === "existing",
    };
  };

  // -------------------------------------------------------------------------
  // The public service surface.
  // -------------------------------------------------------------------------

  return {
    /**
     * Submit (or idempotently replay) one media generation job on a
     * deployment: the full admission chain, the durable job row and
     * the PAID dispatch (exactly one upstream dispatch, ever, per
     * job — the stable rail key converges crashes and concurrent
     * duplicates).
     */
    async submitJob(
      input: SubmitMediaJobInput,
      idempotencyKey: string,
      actor: MediaActor,
    ): Promise<SubmitMediaJobOutcome> {
      return submitJobInternal(input, idempotencyKey, actor, null);
    },

    /**
     * POLL the upstream job state (a READ) and apply the NORMALIZED
     * observation (the adapter normalized the provider's raw state —
     * only the closed observation vocabulary crosses the seam).
     */
    async pollJob(jobId: string, actor: MediaActor): Promise<MediaObservationApplyOutcome> {
      const job = await resolveJob(actor, jobId);
      if (job.providerJobRef === null) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `media job ${jobId} has no rail reference yet (status ${job.status}); polling requires a dispatched job`,
        });
      }
      const poll = await rail.pollJob({
        applicationId: actor.applicationId,
        jobId: job.id,
        providerJobRef: job.providerJobRef,
      });
      const observationKey = deterministicMediaObservationKey({
        jobId: job.id,
        observation: poll.observation,
        progress: poll.progress,
      });
      return applyObservation(
        job,
        {
          source: "poll",
          observationKey,
          observation: poll.observation,
          providerJobRef: job.providerJobRef,
          providerStateLabel: poll.providerStateLabel,
          progress: poll.progress,
          outputDescriptor: poll.outputDescriptor,
        },
        actor,
      );
    },

    /**
     * Apply one inbound provider CALLBACK frame (webhook/transport):
     * the correlation guard binds the frame to the job's recorded
     * provider reference + tenant + deployment identity — foreign or
     * stale callbacks are REJECTED before any mutation.
     */
    async applyCallback(
      input: MediaCallbackInput,
      actor: MediaActor,
    ): Promise<MediaObservationApplyOutcome> {
      const check = validateMediaCallbackInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      const job = await resolveJob(actor, input.jobId);
      if (job.providerJobRef === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `media job ${job.id} has no rail reference; a callback cannot precede the dispatch`,
        });
      }
      if (job.providerJobRef !== input.providerJobRef) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "media callback correlation rejected: the frame's provider reference does not match the job's recorded rail reference (foreign or stale callback)",
          details: { jobId: job.id, expectedRef: job.providerJobRef, gotRef: input.providerJobRef },
        });
      }
      const observationKey =
        input.callbackKey ??
        deterministicMediaObservationKey({
          jobId: job.id,
          observation: input.observation,
          progress: input.progress ?? null,
        });
      return applyObservation(
        job,
        {
          source: "callback",
          observationKey,
          observation: input.observation,
          providerJobRef: input.providerJobRef,
          providerStateLabel: input.providerStateLabel ?? null,
          progress: input.progress ?? null,
          outputDescriptor: input.outputDescriptor ?? null,
        },
        actor,
      );
    },

    /** Cancel one media job (governed cancellation semantics). */
    async cancelJob(
      jobId: string,
      cause: string | undefined,
      actor: MediaActor,
    ): Promise<MediaJobCancelOutcome> {
      const boundedCause = requireCause(cause);
      const job = await resolveJob(actor, jobId);
      if (job.status === "cancelled") {
        // Idempotent convergence: the cancellation already happened —
        // the repeated call replays the terminal outcome (and
        // reconciles any operation row a crash left pending).
        await reconcileOperations(job, actor);
        return {
          jobId: job.id,
          status: job.status,
          executionId: job.executionId,
          replayed: true,
        };
      }
      if (isTerminalMediaJobStatus(job.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `media job ${jobId} is ${job.status}; terminal jobs cannot be cancelled`,
        });
      }
      if (job.status === "verifying") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message:
            "media job is at the verification boundary; a verification decision (completion or rejection) is already in flight",
        });
      }
      // POLICY — the job-cancel admission (BEFORE the rail side effect).
      const decision = await policy.admit({
        tenantId: actor.tenantId,
        applicationId: actor.applicationId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        action: "job-cancel",
        generationKind: job.generationKind,
        railCapabilityId: rail.descriptor.railCapabilityId,
        secretRef: railConnectionRef,
      });
      const operationKey = mediaOperationKey("job-cancellation", job.id);
      if (!decision.allowed) {
        await recordDenial({
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          operationKey,
          jobId: job.id,
          deploymentId: job.deploymentId,
          executionId: job.executionId,
          action: "job-cancel",
          code: "POLICY_DENIED",
          reason: decision.reason,
        });
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "media job cancellation denied by admission policy",
          details: { jobId: job.id, reason: decision.reason },
        });
      }
      const begun = await beginOperation("job-cancellation", job.id, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        executionId: job.executionId,
      });
      if (begun.status === "existing" && begun.record.status === "completed") {
        const converged = await store.findJob(actor.applicationId, job.id);
        return {
          jobId: job.id,
          status: converged?.status ?? job.status,
          executionId: job.executionId,
          replayed: true,
        };
      }
      if (
        begun.status === "existing" &&
        begun.record.status === "pending" &&
        begun.record.checkpoint?.stage === "rail-issued"
      ) {
        // CRASH RECOVERY from the checkpoint: the rail cancel was
        // issued under the STABLE key — complete the durable tail.
        const converged = await store.findJob(actor.applicationId, job.id);
        if (converged !== null && converged.status === "cancelled") {
          await store.completeMediaOperation(actor.applicationId, operationKey, iso());
          return {
            jobId: job.id,
            status: converged.status,
            executionId: job.executionId,
            replayed: true,
          };
        }
      }
      // The rail cancellation (idempotent by the STABLE cancel key).
      const cancelled = await rail.cancelJob({
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        jobId: job.id,
        providerJobRef: job.providerJobRef,
        idempotencyKey: mediaRailCancelKey(job.id),
        cause: boundedCause,
      });
      if (
        cancelled.cancelled &&
        "alreadyTerminal" in cancelled &&
        cancelled.alreadyTerminal === true
      ) {
        // The provider already reached a terminal state: the
        // cancellation FAILS CLOSED — the job's outcome is the
        // provider's terminal state, applied through the observation
        // path (the fabric converges on the provider's truth).
        await store
          .failMediaOperation(
            actor.applicationId,
            operationKey,
            "cancellation refused: the provider job already reached a terminal state",
            iso(),
          )
          .catch(() => undefined);
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message:
            "media job cancellation refused: the provider job already reached a terminal state (the job converges on the provider's outcome)",
        });
      }
      if (!cancelled.cancelled) {
        await store
          .failMediaOperation(
            actor.applicationId,
            operationKey,
            `rail cancellation refused: ${cancelled.reason.slice(0, 400)}`,
            iso(),
          )
          .catch(() => undefined);
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the media rail refused the cancellation",
          details: { jobId: job.id, reason: cancelled.reason },
        });
      }
      // CHECKPOINT the past-no-return facts.
      await checkpointOperation(actor.applicationId, operationKey, {
        stage: "rail-issued",
        jobId: job.id,
        executionId: job.executionId,
        deploymentId: job.deploymentId,
        providerJobRef: job.providerJobRef,
      });
      // The guarded terminal move (from the CURRENT status — a
      // concurrent observation may have moved the job).
      const current = await store.findJob(actor.applicationId, job.id);
      const target = current ?? job;
      if (target.status === "verifying") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message:
            "media job reached the verification boundary during cancellation; the verification decision owns the outcome",
        });
      }
      if (!isTerminalMediaJobStatus(target.status)) {
        await store.applyGuardedJobMutation({
          applicationId: actor.applicationId,
          jobId: job.id,
          expectedStatus: target.status,
          toStatus: "cancelled",
          completedAt: iso(),
          updatedAt: iso(),
        });
      }
      // The budget release when a reservation exists (best-effort;
      // converges by operation id).
      if (target.reservationId !== null) {
        await budget
          .release({
            actorId: actor.actorId,
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            operationId: mediaBudgetOperationId(job.id),
          })
          .catch(() => undefined);
      }
      // The execution cancellation + provenance.
      await ledger
        .cancelExecution(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            reason: boundedCause ?? "media job cancelled",
          },
          mediaEvidenceKey(job.id, "cancellation"),
        )
        .catch(() => undefined);
      await ledger
        .recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            evidenceClass: "cancellation",
            cause: boundedCause ?? "media job cancelled",
            reference: {
              jobId: job.id,
              deploymentId: job.deploymentId,
              providerJobRef: job.providerJobRef,
              railCapabilityId: rail.descriptor.railCapabilityId,
            },
            payload: { outcome: "cancelled", replayedRailCancel: cancelled.replayed },
          },
          mediaEvidenceKey(job.id, "cancellation"),
        )
        .catch(() => undefined);
      await store.completeMediaOperation(actor.applicationId, operationKey, iso());
      const final = await store.findJob(actor.applicationId, job.id);
      return {
        jobId: job.id,
        status: final?.status ?? "cancelled",
        executionId: job.executionId,
        replayed: cancelled.replayed || begun.status === "existing",
      };
    },

    /**
     * Retry a FAILED job as an idempotent RESUBMISSION: a NEW job row
     * under the retry key referencing the failed job — one job, one
     * execution, ONE paid dispatch (structurally unique); a repeated
     * retry call under the SAME key converges on the SAME retry job
     * (MOD-013: no uncontrolled paid duplicates). The generation
     * intent MUST preprocess to the failed job's digest (a divergent
     * retry is a different job — submit it as one). The verification
     * policy is INHERITED from the failed job.
     */
    async retryJob(
      jobId: string,
      input: RetryMediaJobInput,
      idempotencyKey: string,
      actor: MediaActor,
    ): Promise<SubmitMediaJobOutcome> {
      requireKey(idempotencyKey);
      if (!isRecordish(input)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "media retry input must be an object",
        });
      }
      if (typeof input.prompt !== "string" || input.prompt.length < 1) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "retry prompt must be a non-empty string",
        });
      }
      const failed = await resolveJob(actor, jobId);
      if (failed.status !== "failed") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `media job ${jobId} is ${failed.status}; only failed jobs can be retried (submit a new job for a fresh intent)`,
        });
      }
      // The retry intent MUST match the failed job's deterministic
      // preprocessing digest (retry preserves the intent).
      const retryDigest = preprocessingDigestOf({
        generationKind: failed.generationKind,
        prompt: input.prompt,
        inputArtifactDigest: input.inputArtifactDigest ?? failed.inputArtifactDigest,
        parameters: input.parameters ?? null,
      });
      if (retryDigest !== failed.preprocessingDigest) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "media retry intent diverges from the failed job's normalized generation spec (retry preserves the intent; submit a new job for a different one)",
          details: { jobId: failed.id, expected: failed.preprocessingDigest, got: retryDigest },
        });
      }
      // The resubmission input (the failed job's coordinates + the
      // caller's bounded intent, verification policy INHERITED).
      const submitInput: SubmitMediaJobInput = {
        deploymentId: failed.deploymentId,
        generationKind: failed.generationKind,
        prompt: input.prompt,
        ...(input.inputArtifactDigest === undefined
          ? {}
          : { inputArtifactDigest: input.inputArtifactDigest }),
        ...(input.parameters === undefined ? {} : { parameters: input.parameters }),
        ...(failed.verificationMode === "required"
          ? { verification: { criteria: [...failed.verificationCriteria] } }
          : {}),
      };
      return submitJobInternal(submitInput, idempotencyKey, actor, failed.id);
    },

    /**
     * Derive one VARIANT of a completed job's generated output
     * (MOD-012): the deterministic transform descriptor is adopted
     * through the canonical artifact authority with the SOURCE
     * artifact digest as the lineage parent — the lineage link is
     * identity-bearing (a variant that dropped it is a different
     * digest); the adoption record links the job's pinned deployment
     * version + execution provenance.
     */
    async deriveVariant(
      input: DeriveMediaVariantInput,
      idempotencyKey: string,
      actor: MediaActor,
    ): Promise<MediaVariantOutcome> {
      requireKey(idempotencyKey);
      const check = validateDeriveMediaVariantInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      const job = await resolveJob(actor, input.jobId);
      if (job.status !== "completed" || job.outputArtifactDigest === null) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `media job ${input.jobId} is ${job.status}; variants derive from completed jobs with an adopted output artifact`,
        });
      }
      const sourceDigest = job.outputArtifactDigest;
      // POLICY — the variant-derive admission (BEFORE the adoption).
      const decision = await policy.admit({
        tenantId: actor.tenantId,
        applicationId: actor.applicationId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        action: "variant-derive",
        generationKind: job.generationKind,
        railCapabilityId: rail.descriptor.railCapabilityId,
        secretRef: null,
      });
      const operationKey = mediaOperationKey("variant-adoption", `${job.id}:${idempotencyKey}`);
      if (!decision.allowed) {
        await recordDenial({
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          operationKey,
          jobId: job.id,
          deploymentId: job.deploymentId,
          executionId: job.executionId,
          action: "variant-derive",
          code: "POLICY_DENIED",
          reason: decision.reason,
        });
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: "media variant derivation denied by admission policy",
          details: { jobId: job.id, reason: decision.reason },
        });
      }
      const begun = await beginOperation("variant-adoption", `${job.id}:${idempotencyKey}`, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        executionId: job.executionId,
      });
      if (begun.status === "existing" && begun.record.status === "completed") {
        const existing = await store.findArtifact(
          actor.applicationId,
          mediaVariantArtifactKey(idempotencyKey),
        );
        if (existing !== null) {
          return {
            jobId: job.id,
            artifactKey: existing.artifactKey,
            artifactDigest: existing.artifactDigest,
            parentDigests: [...existing.parentDigests],
            executionId: job.executionId,
            pinnedPlanVersion: existing.pinnedPlanVersion,
            replayed: true,
          };
        }
      }
      // The source artifact must exist in the CALLER's tenant namespace
      // (lineage validation — tenant isolation on adoption).
      const sourceExists = await artifacts.artifactExists(
        { tenantId: actor.tenantId },
        sourceDigest,
      );
      if (!sourceExists) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message:
            "the source artifact is absent from this tenant namespace (variants derive from tenant-visible artifacts only)",
        });
      }
      // The deterministic variant descriptor (the normalized transform
      // intent + the source linkage — bounded, canonicalizable).
      const variantDescriptor: Record<string, unknown> = {
        variantKind: "derived-variant",
        sourceDigest,
        variant: normalizeVariantRecord(input.variant),
      };
      const adoption = await artifacts.adoptArtifact({
        tenantId: actor.tenantId,
        applicationId: actor.applicationId,
        role: "derived-variant",
        descriptor: variantDescriptor,
        parents: [sourceDigest],
        sourceRefs: [
          { kind: "artifact", id: sourceDigest, locator: `artifact:${sourceDigest}` },
          { kind: "source", id: job.executionId, locator: `execution:${job.executionId}` },
          {
            kind: "source",
            id: job.deploymentId,
            locator: `deployment:${job.deploymentId}@${job.pinnedPlanVersion}`,
          },
          { kind: "source", id: job.id, locator: `media-job:${job.id}` },
        ],
      });
      const artifactKey = mediaVariantArtifactKey(idempotencyKey);
      const descriptorDigest = digest(JSON.stringify(variantDescriptor));
      // CHECKPOINT the past-no-return facts.
      await checkpointOperation(actor.applicationId, operationKey, {
        stage: "variant-adopted",
        jobId: job.id,
        executionId: job.executionId,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        generationKind: job.generationKind,
        outputArtifactDigest: sourceDigest,
        artifactKey,
        parentDigests: [sourceDigest],
      });
      // The adoption record (write-once; converges on the physical key).
      await store.insertArtifact({
        artifactRowId: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        jobId: job.id,
        deploymentId: job.deploymentId,
        pinnedPlanId: job.pinnedPlanId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        executionId: job.executionId,
        role: "derived-variant",
        artifactKey,
        artifactDigest: adoption.digest,
        parentDigests: [sourceDigest],
        descriptorDigest,
        ledgerSequence: null,
        createdBy: actor.actorId,
        createdAt: iso(),
      });
      // Provenance: the variant adoption rides the executions ledger.
      await ledger
        .recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: job.executionId,
            evidenceClass: "artifact",
            cause: "derived media variant adopted as a lineage artifact",
            reference: {
              jobId: job.id,
              deploymentId: job.deploymentId,
              pinnedPlanId: job.pinnedPlanId,
              pinnedPlanVersion: job.pinnedPlanVersion,
              artifactKey,
              artifactDigest: adoption.digest,
              parentDigests: [sourceDigest],
            },
            payload: { role: "derived-variant", descriptorDigest },
          },
          mediaEvidenceKey(job.id, `variant:${idempotencyKey}`),
        )
        .catch(() => undefined);
      await store.completeMediaOperation(actor.applicationId, operationKey, iso());
      return {
        jobId: job.id,
        artifactKey,
        artifactDigest: adoption.digest,
        parentDigests: [sourceDigest],
        executionId: job.executionId,
        pinnedPlanVersion: job.pinnedPlanVersion,
        replayed: adoption.converged || begun.status === "existing",
      };
    },

    /** Get one media job (read-only, tenant-guarded) with its evidence. */
    async getJob(
      jobId: string,
      actor: MediaActor,
    ): Promise<{
      readonly job: MediaJobRecord;
      readonly observations: readonly unknown[];
      readonly artifacts: readonly unknown[];
    }> {
      const job = await resolveJob(actor, jobId);
      const [observations, adoptionRecords] = await Promise.all([
        store.listObservations(actor.applicationId, job.id),
        store.listArtifacts(actor.applicationId, job.id),
      ]);
      return { job, observations, artifacts: adoptionRecords };
    },
  };
}

/** The order-stable canonical form of a variant descriptor record. */
function normalizeVariantRecord(
  variant: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(variant).sort()) {
    sorted[key] = variant[key];
  }
  return sorted;
}

export type MediaGenerationService = ReturnType<typeof createMediaGenerationService>;
