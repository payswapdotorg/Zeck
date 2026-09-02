/**
 * Realtime session service (deployments module application; WORK-024,
 * MOD-005/MOD-006/MOD-007).
 *
 * THE governed lifecycle of realtime voice sessions/calls over the
 * WORK-023 deployment fabric. A realtime session MAPS TO a governed
 * Execution and a pinned deployment plan version; every operation is
 * idempotent, audited and concurrency-safe; turns, interruptions,
 * transfers, failures and significant actions are preserved as
 * EXECUTION provenance through the executions ledger (the module's
 * realtime ledger port — the single canonical event path; the channel
 * journal is session state + the inbound idempotency ledger, never a
 * second event authority).
 *
 * The frozen admission ordering (the models-gateway / IMPLEMENTATION.md
 * §7 discipline — MOD-006 criterion 5): TENANT scope resolution →
 * POLICY admission → CAPABILITY resolution → BUDGET reservation (paid
 * routes only — MOD-007) → SECRET mediation → THEN the governed side
 * effects (rail delivery / paid inference). A denial at ANY stage
 * happens BEFORE every side effect and is durably recorded
 * (journal-then-fail) on the channel journal AND the execution ledger.
 *
 * DURABLE, RECOVERABLE OPERATION STATE (the architect's crash-safety
 * correction for PR #46): every operation that can perform an external
 * side effect owns ONE durable operation row (pending → completed |
 * failed) plus a STABLE rail-level idempotency key. The ordering rule:
 * the durable operation claim is written BEFORE the rail side effect,
 * and the durable completion AFTER every durable outcome — a crash in
 * between leaves the row PENDING, and a retry RESUMES it (the rail
 * converges by key: exactly one upstream side effect, ever) instead
 * of mistaking the claim for convergence. A stage checkpoint marks
 * the point of no return: resumption past it NEVER re-runs admission
 * (the decision preceded the side effect) and completes the durable
 * tail from the checkpointed facts.
 *
 * ```text
 * startSession      → deployment facts (tenant-guarded, active status)
 *                     → version PIN (the deployment's current plan)
 *                     → policy admission → execution identity (idempotent)
 *                     → OP CLAIM → rail session open (STABLE KEY)
 *                     → CHECKPOINT(session-opened) → durable session row
 *                     → provenance (agent-session-started) → OP COMPLETE
 * ingestEvent       → session resolution (tenant + stale-callback guard)
 *                     → inbound claim (idempotency ledger — duplicates
 *                       converge, no second side effect)
 *                     → OP STATE check (completed → pure replay; failed →
 *                       recorded failure; pending/absent → RESUME)
 *                     → [user-turn] planner route (deterministic/hybrid/
 *                       generative) → policy → capability → budget (paid
 *                       routes) → secret mediation → responder →
 *                       CHECKPOINT(responded) → RAIL DELIVERY (STABLE KEY)
 *                       → budget settle → provenance → OP COMPLETE
 *                     → [interruption] provenance (no dispatch, no op —
 *                       the evidence keys converge on replay)
 *                     → [caller-hangup] close op + provenance → terminal
 * transferToHuman   → policy-designated escalation (deny → no side
 *                     effect) → OP CLAIM → execution wait-human
 *                     (auditable) → rail transfer (STABLE KEY) →
 *                     CHECKPOINT(rail-issued) → provenance → session
 *                     transferred (terminal) → OP COMPLETE
 * reattachSession   → guarded channel-coordinate move (epoch+1) — the
 *                     execution identity NEVER changes (no second
 *                     authoritative execution; no rail side effect)
 * closeSession      → OP CLAIM → provenance → rail close (STABLE KEY,
 *                     best-effort) → terminal → OP COMPLETE
 * failSession       → failure provenance → rail close (STABLE KEY) →
 *                     terminal → OP COMPLETE
 * ```
 *
 * Deployment version pinning + rollback (AC7): the session pins the
 * plan version at start; promotion/rollback on the deployment moves
 * the pointer for NEW sessions only — live sessions keep their pin and
 * their execution identity (provenance never rewritten).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type {
  RealtimeEventKind,
  RealtimeInboundEventInput,
  RealtimeOperationCheckpoint,
  RealtimeOperationRecord,
  RealtimeRouteClass,
  RealtimeSessionRecord,
  StartRealtimeSessionInput,
} from "../domain/realtime";
import {
  deterministicRealtimeEventKey,
  isTerminalRealtimeSessionStatus,
  realtimeContainsRawSecretValue,
  realtimeEventBodyDigestBase,
  realtimeOperationKey,
  realtimeRailCloseKey,
  realtimeRailDeliverKey,
  realtimeRailOpenKey,
  realtimeRailTransferKey,
  realtimeSessionCreationFingerprint,
  validateRealtimeInboundEvent,
  validateStartRealtimeSessionInput,
} from "../domain/realtime";
import type { DeploymentStore } from "../ports/deployment-store";
import type {
  RealtimeBudgetAdmission,
  RealtimeCapabilityAdmission,
  RealtimePolicyAdmission,
  RealtimeSecretMediation,
} from "../ports/realtime-admission";
import type { RealtimeExecutionLedger } from "../ports/realtime-execution-ledger";
import type { RealtimeRail } from "../ports/realtime-rail";
import type { RealtimeStore } from "../ports/realtime-store";
import type { RealtimeSubtaskRouter, RealtimeTurnRoute } from "../ports/realtime-subtask-router";
import type { RealtimeTurnResponder } from "../ports/realtime-turn-responder";

/** The read-only deployment-facts surface this service consumes. */
export type RealtimeDeploymentFacts = Pick<
  DeploymentStore,
  "findDeployment" | "findPlan" | "findProfile"
>;

export interface RealtimeActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface RealtimeSessionServiceDeps {
  readonly store: RealtimeStore;
  /** Read-only deployment facts through the WORK-023 fabric store. */
  readonly deployments: RealtimeDeploymentFacts;
  /** The provider-neutral upstream rail (replaceable infrastructure). */
  readonly rail: RealtimeRail;
  /** REQUIRED policy admission (no default-allow exists). */
  readonly policy: RealtimePolicyAdmission;
  /** REQUIRED capability admission. */
  readonly capabilities: RealtimeCapabilityAdmission;
  /** REQUIRED budget admission (paid routes). */
  readonly budget: RealtimeBudgetAdmission;
  /** REQUIRED secret mediation (rail channel credentials, references only). */
  readonly secrets: RealtimeSecretMediation;
  /** REQUIRED planner-decided subtask routing (MOD-007). */
  readonly router: RealtimeSubtaskRouter;
  /** REQUIRED turn responder (the deployed agent's turn handling seam). */
  readonly responder: RealtimeTurnResponder;
  /** REQUIRED execution provenance ledger (the executions public seam). */
  readonly ledger: RealtimeExecutionLedger;
  /**
   * The rail channel's neutral connection reference (the mediated
   * credential access target — a reference, never a value).
   */
  readonly railConnectionRef: string;
  readonly digest: (canonical: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface StartRealtimeSessionOutcome {
  readonly sessionId: string;
  readonly executionId: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly replayed: boolean;
}

export interface RealtimeIngestOutcome {
  readonly eventKey: string;
  readonly kind: "user-turn" | "interruption" | "caller-hangup";
  /** Turn outcomes only (null for interruption/hangup). */
  readonly routeClass: string | null;
  readonly responsePreview: string | null;
  readonly responseRef: string | null;
  readonly ledgerSequence: number;
  readonly replayed: boolean;
}

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const CAUSE_MAX = 2000;

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
  if (realtimeContainsRawSecretValue(cause)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "cause looks like it embeds a raw secret value",
    });
  }
  return cause;
}

const MICRO_USD_PATTERN = /^\d{1,19}$/;

export function createRealtimeSessionService(deps: RealtimeSessionServiceDeps) {
  const {
    store,
    deployments,
    rail,
    policy,
    capabilities,
    budget,
    secrets,
    router,
    responder,
    ledger,
    railConnectionRef,
    digest,
    generateId,
    now,
  } = deps;
  const iso = () => now().toISOString();

  /** Tenant-guarded deployment resolution + the active-status gate. */
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
        message: `plan ${planId}@${planVersion} is not published; a realtime session cannot pin an unknown plan version`,
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

  /** Journal-then-fail: durably record a denial on BOTH ledgers. */
  const recordDenial = async (context: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly actorId: string;
    readonly sessionId: string | null;
    readonly deploymentId: string;
    readonly executionId: string | null;
    readonly channelSessionRef: string | null;
    readonly channelEpoch: number | null;
    readonly action: string;
    readonly code: string;
    readonly reason: string;
    readonly eventKey: string;
  }) => {
    if (context.executionId !== null && context.sessionId !== null) {
      // The denial evidence rides the canonical executions ledger.
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
              sessionId: context.sessionId,
              deploymentId: context.deploymentId,
              eventKey: context.eventKey,
              deniedAction: context.action,
            },
            payload: {
              outcome: "denied",
              action: context.action,
              code: context.code,
              reason: context.reason,
            },
          },
          `realtime:denial:${context.eventKey}`,
        )
        .catch(() => undefined);
    }
    if (context.sessionId !== null && context.channelSessionRef !== null) {
      // The channel journal row (bounded, append-only).
      await store
        .appendChannelEvent({
          eventId: generateId(),
          applicationId: context.applicationId,
          tenantId: context.tenantId,
          sessionId: context.sessionId,
          deploymentId: context.deploymentId,
          kind: "failure-recorded",
          direction: "internal",
          eventKey: `denial:${context.eventKey}`,
          channelSessionRef: context.channelSessionRef,
          channelEpoch: context.channelEpoch ?? 1,
          executionId: context.executionId,
          ledgerSequence: null,
          routeClass: null,
          cause: `${context.action} denied (${context.code}): ${context.reason.slice(0, 400)}`,
          payloadRef: null,
          payloadPreview: null,
          actorId: context.actorId,
          bodyDigest: digest(
            realtimeEventBodyDigestBase({
              sessionId: context.sessionId,
              kind: "failure-recorded",
              direction: "internal",
              eventKey: `denial:${context.eventKey}`,
              payloadRef: null,
              payloadPreview: null,
            }),
          ),
          createdAt: iso(),
        })
        .catch(() => undefined);
    }
  };

  /** Resolve a session with tenant + terminal + stale-callback guards. */
  const resolveSession = async (
    actor: RealtimeActor,
    sessionId: string,
    channel?: { readonly channelSessionRef: string; readonly channelEpoch: number },
  ) => {
    if (!isUuid(sessionId)) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "sessionId must be a UUID" });
    }
    const session = await store.findSession(actor.applicationId, sessionId);
    if (session === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `realtime session ${sessionId} not found in this application`,
      });
    }
    if (session.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "realtime session belongs to another tenant",
      });
    }
    if (channel !== undefined) {
      // The stale-callback guard: the callback's channel coordinates
      // must match the session's CURRENT coordinates (an epoch bump
      // permanently supersedes the old ones).
      if (
        channel.channelSessionRef !== session.channelSessionRef ||
        channel.channelEpoch !== session.channelEpoch
      ) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `stale realtime callback rejected: event on channel ${channel.channelSessionRef} epoch ${channel.channelEpoch} but session ${sessionId} currently holds channel ${session.channelSessionRef} epoch ${session.channelEpoch}`,
        });
      }
    }
    return session;
  };

  const sessionEvent = async (input: {
    readonly session: RealtimeSessionRecord;
    readonly kind: RealtimeEventKind;
    readonly direction: "inbound" | "outbound" | "internal";
    readonly eventKey: string;
    readonly cause: string | null;
    readonly payloadRef: string | null;
    readonly payloadPreview: string | null;
    readonly ledgerSequence: number | null;
    readonly routeClass: RealtimeRouteClass | null;
    readonly actorId: string;
  }) => {
    return store.appendChannelEvent({
      eventId: generateId(),
      applicationId: input.session.applicationId,
      tenantId: input.session.tenantId,
      sessionId: input.session.id,
      deploymentId: input.session.deploymentId,
      kind: input.kind,
      direction: input.direction,
      eventKey: input.eventKey,
      channelSessionRef: input.session.channelSessionRef,
      channelEpoch: input.session.channelEpoch,
      executionId: input.session.executionId,
      ledgerSequence: input.ledgerSequence,
      routeClass: input.routeClass,
      cause: input.cause,
      payloadRef: input.payloadRef,
      payloadPreview: input.payloadPreview,
      actorId: input.actorId,
      bodyDigest: digest(
        realtimeEventBodyDigestBase({
          sessionId: input.session.id,
          kind: input.kind,
          direction: input.direction,
          eventKey: input.eventKey,
          payloadRef: input.payloadRef,
          payloadPreview: input.payloadPreview,
        }),
      ),
      createdAt: iso(),
    });
  };

  /**
   * Claim (or re-claim) the durable, recoverable operation row — the
   * crash-safety discriminator. Written BEFORE the rail side effect;
   * completed after every durable outcome. A crash between leaves it
   * PENDING and the retry resumes from `beginOperation`'s record.
   */
  const beginOperation = (
    kind: "session-start" | "turn-delivery" | "human-transfer" | "session-close",
    discriminator: string,
    refs: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly sessionId: string | null;
      readonly deploymentId: string;
      readonly executionId: string | null;
    },
  ) =>
    store.beginRealtimeOperation({
      operationId: generateId(),
      ...refs,
      operationKind: kind,
      operationKey: realtimeOperationKey(kind, discriminator),
      createdAt: iso(),
    });

  /**
   * RACE-TOLERANT checkpoint write: a CONCURRENT invocation of the same
   * logical operation may complete (or durably fail) it between our
   * state check and this write — the winner owns the outcome, and our
   * durable tail converges through the stable keys (rail, executions
   * ledger, journal); a still-pending row means the write genuinely
   * failed and the error stands.
   */
  const checkpointOperation = async (
    applicationId: string,
    operationKey: string,
    checkpoint: RealtimeOperationCheckpoint,
  ): Promise<RealtimeOperationRecord | null> => {
    try {
      return await store.recordRealtimeOperationCheckpoint(
        applicationId,
        operationKey,
        checkpoint,
        iso(),
      );
    } catch (error) {
      if (error instanceof PlatformError && error.code === "INVALID_STATE_TRANSITION") {
        const reread = await store.findRealtimeOperation(applicationId, operationKey);
        if (reread !== null && reread.status !== "pending") {
          // The concurrent winner completed/failed the operation — our
          // tail converges from here.
          return reread;
        }
      }
      throw error;
    }
  };

  return {
    /** Start (or idempotently replay) one realtime session on a deployment. */
    async startSession(
      input: StartRealtimeSessionInput,
      idempotencyKey: string,
      actor: RealtimeActor,
    ): Promise<StartRealtimeSessionOutcome> {
      requireKey(idempotencyKey);
      const check = validateStartRealtimeSessionInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      // The durable session-start OPERATION key (the recovery
      // discriminator — the same retry derives the same key).
      const operationKey = realtimeOperationKey("session-start", idempotencyKey);
      // Idempotent replay fast path (a reconnect/retry converges on the
      // SAME session + execution identity — never a second one), WITH
      // creation-fingerprint arbitration (the WORK-023 createDeployment
      // discipline): the same key with a DIFFERENT body is key reuse and
      // fails closed instead of silently converging.
      const replayed = await store.findSessionByStartKey(actor.applicationId, idempotencyKey);
      if (replayed !== null) {
        const expectedFingerprint = realtimeSessionCreationFingerprint(
          actor.applicationId,
          input,
          replayed.executionId,
        );
        if (replayed.creationFingerprint !== expectedFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "realtime session idempotency key already exists with a different creation fingerprint",
            details: { sessionId: replayed.id },
          });
        }
        // CRASH RECOVERY: the session row exists but the start operation
        // may still be PENDING (a crash between the durable insert and
        // the operation completion lost the provenance tail) — complete
        // it instead of returning the gap.
        const op = await store.findRealtimeOperation(actor.applicationId, operationKey);
        if (op !== null && op.status === "pending") {
          const session = replayed;
          const startEvidence = await ledger.recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: session.executionId,
              evidenceClass: "session-started",
              // REPLAY-STABLE cause: identical for the original start and
              // the recovered provenance tail (the executions idempotency
              // arbitrates by key + fingerprint).
              cause: "realtime session started on the deployment fabric",
              reference: {
                sessionId: session.id,
                deploymentId: session.deploymentId,
                pinnedPlanId: session.pinnedPlanId,
                pinnedPlanVersion: session.pinnedPlanVersion,
                channelKind: session.channelKind,
                channelSessionRef: session.channelSessionRef,
                channelEpoch: session.channelEpoch,
                policySet: op.checkpoint?.policySetId ?? null,
              },
              payload: {
                callerRef: session.callerRef,
                railCapabilityId: rail.descriptor.railCapabilityId,
              },
            },
            `${idempotencyKey}:session-started`,
          );
          await sessionEvent({
            session,
            kind: "session-started",
            direction: "internal",
            eventKey: `${idempotencyKey}:session-started`,
            cause: null,
            payloadRef: input.initialPayloadRef ?? null,
            payloadPreview: null,
            ledgerSequence: startEvidence.sequence,
            routeClass: null,
            actorId: actor.actorId,
          });
          await store.completeRealtimeOperation(actor.applicationId, operationKey, iso());
        }
        return {
          sessionId: replayed.id,
          executionId: replayed.executionId,
          channelSessionRef: replayed.channelSessionRef,
          channelEpoch: replayed.channelEpoch,
          pinnedPlanId: replayed.pinnedPlanId,
          pinnedPlanVersion: replayed.pinnedPlanVersion,
          replayed: true,
        };
      }
      // 0. The durable operation claim — BEFORE the rail side effect (a
      // crash between the rail open and the durable session row leaves
      // this row PENDING; the retry resumes from its checkpoint).
      const sessionId = generateId();
      const begun = await beginOperation("session-start", idempotencyKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        sessionId,
        deploymentId: input.deploymentId,
        executionId: null,
      });
      let deployment: Awaited<ReturnType<typeof resolveDeployment>> | null = null;
      let plan: Awaited<ReturnType<typeof resolvePinnedPlan>>["plan"] | null = null;
      let execution: Awaited<ReturnType<typeof ledger.openExecution>> | null = null;
      let decisionEvidence: { readonly policySetId: string | null } | null = null;
      let railSession: Awaited<ReturnType<typeof rail.openSession>> | null = null;
      if (begun.status === "existing" && begun.record.status === "completed") {
        // A concurrent invocation completed this operation: its session
        // row MUST exist (completion follows the durable insert).
        const converged = await store.findSessionByStartKey(actor.applicationId, idempotencyKey);
        if (converged === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "realtime session start operation is completed but its session row is absent (invariant violation)",
          });
        }
        return {
          sessionId: converged.id,
          executionId: converged.executionId,
          channelSessionRef: converged.channelSessionRef,
          channelEpoch: converged.channelEpoch,
          pinnedPlanId: converged.pinnedPlanId,
          pinnedPlanVersion: converged.pinnedPlanVersion,
          replayed: true,
        };
      }
      if (
        begun.status === "existing" &&
        begun.record.status === "pending" &&
        begun.record.checkpoint?.stage === "session-opened"
      ) {
        // CRASH RECOVERY from the checkpoint: the rail opened the channel
        // under the STABLE key — resume the durable tail (insert +
        // provenance + completion) WITHOUT re-running admission (the
        // decision preceded the side effect) and WITHOUT a second rail
        // open (the rail converges by key even if re-issued).
        const checkpoint = begun.record.checkpoint;
        execution = {
          executionId: checkpoint.executionId ?? "",
          replayed: true,
          status: "running",
        };
        railSession = {
          channelSessionRef: checkpoint.channelSessionRef ?? "",
          channelEpoch: checkpoint.channelEpoch ?? 1,
          railMetadata: {},
          replayed: true,
        };
        decisionEvidence = { policySetId: checkpoint.policySetId ?? null };
        // The pinned plan facts are re-read for the (already-decided)
        // insert: the pin was fixed at the original admission.
        const pinned = await resolvePinnedPlan(
          actor.applicationId,
          checkpoint.pinnedPlanId ?? "",
          checkpoint.pinnedPlanVersion ?? 0,
        );
        plan = pinned.plan;
        deployment = await resolveDeployment(
          actor.applicationId,
          checkpoint.deploymentId ?? "",
          actor.tenantId,
        );
      } else {
        // 1. TENANT — server-derived scope + deployment facts.
        deployment = await resolveDeployment(
          actor.applicationId,
          input.deploymentId,
          actor.tenantId,
        );
        if (deployment.status !== "active") {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `deployment ${deployment.slug} is ${deployment.status}; realtime sessions start only on active deployments`,
          });
        }
        // 2. Version PIN: the deployment's CURRENT plan version at start.
        const pinned = await resolvePinnedPlan(
          actor.applicationId,
          deployment.currentPlanId,
          deployment.currentPlanVersion,
        );
        plan = pinned.plan;
        // 3. POLICY — the session-start admission (BEFORE any side effect).
        const decision = await policy.admit({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: null,
          deploymentId: deployment.id,
          action: "session-start",
          channelKind: input.channelKind,
          railCapabilityId: rail.descriptor.railCapabilityId,
          routeClass: null,
          secretRef: railConnectionRef,
        });
        if (!decision.allowed) {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "realtime session start denied by admission policy",
            details: { deploymentId: deployment.id, reason: decision.reason },
          });
        }
        decisionEvidence = { policySetId: decision.evidence?.policySetId ?? null };
        // 4. Execution identity (idempotent by key — the single birth path).
        execution = await ledger.openExecution(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            environmentId: deployment.environmentId,
            task: {
              kind: "realtime-session",
              deploymentId: deployment.id,
              planId: plan.planId,
              planVersion: plan.version,
              channelKind: input.channelKind,
            },
            ...(input.initialPayloadRef === undefined
              ? {}
              : { inputArtifactRefs: [input.initialPayloadRef] }),
          },
          `${idempotencyKey}:execution`,
        );
        // 5. The rail session open (the upstream binding; neutral refs) —
        // under the STABLE rail-level idempotency key: a retry or crash
        // resume re-opens under the SAME key and the rail converges on
        // the SAME channel coordinates (exactly one upstream channel).
        railSession = await rail.openSession({
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          deploymentId: deployment.id,
          pinnedPlanId: plan.planId,
          pinnedPlanVersion: plan.version,
          executionId: execution.executionId,
          channelKind: input.channelKind,
          idempotencyKey: realtimeRailOpenKey(idempotencyKey),
          channelSessionRef: input.channelSessionRef,
          callerRef: input.callerRef ?? null,
          sessionPolicy: plan.sessionPolicy,
        });
        // 6. CHECKPOINT the past-no-return facts (a crash from here on
        // resumes the durable tail WITHOUT re-admission and without a
        // second rail open; a concurrent winner's completion converges).
        await checkpointOperation(actor.applicationId, operationKey, {
          stage: "session-opened",
          sessionId,
          executionId: execution.executionId,
          deploymentId: deployment.id,
          pinnedPlanId: plan.planId,
          pinnedPlanVersion: plan.version,
          channelSessionRef: railSession.channelSessionRef,
          channelEpoch: railSession.channelEpoch,
          policySetId: decisionEvidence.policySetId,
        });
      }
      // 7. The durable session row (idempotent convergence). The
      // session identity is the one pinned by the durable operation row
      // (a crash-resume converges on the SAME identity, never a second
      // one).
      const durableSessionId = begun.record.sessionId ?? sessionId;
      const fingerprint = realtimeSessionCreationFingerprint(
        actor.applicationId,
        input,
        execution.executionId,
      );
      const insert = await store.insertSession({
        sessionId: durableSessionId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        deploymentId: deployment.id,
        pinnedPlanId: plan.planId,
        pinnedPlanVersion: plan.version,
        executionId: execution.executionId,
        channelKind: input.channelKind,
        channelSessionRef: railSession.channelSessionRef,
        channelEpoch: railSession.channelEpoch,
        callerRef: input.callerRef ?? null,
        creationFingerprint: fingerprint,
        createdBy: actor.actorId,
        idempotencyKey,
        createdAt: iso(),
      });
      const session = await store.findSession(actor.applicationId, insert.sessionId);
      if (session === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "realtime session row disappeared after insert",
        });
      }
      // 8. Provenance: the session start rides the executions ledger.
      const startEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: execution.executionId,
          evidenceClass: "session-started",
          cause: "realtime session started on the deployment fabric",
          reference: {
            sessionId: session.id,
            deploymentId: deployment.id,
            pinnedPlanId: session.pinnedPlanId,
            pinnedPlanVersion: session.pinnedPlanVersion,
            channelKind: session.channelKind,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            policySet: decisionEvidence.policySetId,
          },
          payload: {
            callerRef: session.callerRef,
            railCapabilityId: rail.descriptor.railCapabilityId,
          },
        },
        `${idempotencyKey}:session-started`,
      );
      await sessionEvent({
        session,
        kind: "session-started",
        direction: "internal",
        eventKey: `${idempotencyKey}:session-started`,
        cause: null,
        payloadRef: input.initialPayloadRef ?? null,
        payloadPreview: null,
        ledgerSequence: startEvidence.sequence,
        routeClass: null,
        actorId: actor.actorId,
      });
      // 9. The durable operation completion (a crash before this leaves
      // the row PENDING; the retry completes the tail via the fast path).
      await store.completeRealtimeOperation(actor.applicationId, operationKey, iso());
      return {
        sessionId: session.id,
        executionId: session.executionId,
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        pinnedPlanId: session.pinnedPlanId,
        pinnedPlanVersion: session.pinnedPlanVersion,
        replayed: execution.replayed || insert.status === "converged" || railSession.replayed,
      };
    },

    /** Ingest one inbound realtime event (turn / interruption / hangup). */
    async ingestInboundEvent(
      input: RealtimeInboundEventInput,
      actor: RealtimeActor,
    ): Promise<RealtimeIngestOutcome> {
      const check = validateRealtimeInboundEvent(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      // 1. Session resolution: tenant scope. The stale-callback and
      // terminal guards apply to NEW events below — a REPLAY of an
      // already-claimed event converges regardless of a later terminal
      // move (our own processing may have closed the session: a
      // caller-hangup retry after a crash-in-the-close-window must
      // recover, not be rejected).
      const session = await resolveSession(actor, input.sessionId);
      // 2. The idempotency discriminator: the upstream-supplied event id
      // or the deterministic substitute (session coordinates + kind +
      // occurrence ordinal).
      const priorEvents = await store.listEvents(actor.applicationId, session.id);
      const eventKey =
        input.eventKey ??
        deterministicRealtimeEventKey({
          sessionId: session.id,
          channelEpoch: input.channelEpoch,
          kind: input.kind,
          occurrenceOrdinal:
            input.occurrenceOrdinal ??
            priorEvents.filter((event) => event.direction === "inbound").length + 1,
        });
      const priorInbound = priorEvents.find(
        (event) => event.direction === "inbound" && event.eventKey === eventKey,
      );
      // 2b. The SESSION-SCOPED event discriminator: event keys are unique
      // per (application, SESSION) — two concurrent calls may legitimately
      // reuse an upstream event id — so EVERY application-scoped key
      // derived from an inbound event (the turn-delivery operation key,
      // the stable rail deliver key, the responder turn key, the budget
      // operation id and the executions-ledger evidence keys) is scoped
      // by the session identity: a same-key turn on ANOTHER session is a
      // DIFFERENT logical operation, never a collision.
      const scopedKey = `${session.id}:${eventKey}`;
      if (priorInbound === undefined) {
        // A NEW event: apply the freshness guards BEFORE the claim.
        if (isTerminalRealtimeSessionStatus(session.status)) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `realtime session ${session.id} is terminal (${session.status}); inbound events are rejected`,
          });
        }
        if (
          input.channelSessionRef !== session.channelSessionRef ||
          input.channelEpoch !== session.channelEpoch
        ) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `stale realtime callback rejected: event on channel ${input.channelSessionRef} epoch ${input.channelEpoch} but session ${session.id} currently holds channel ${session.channelSessionRef} epoch ${session.channelEpoch}`,
          });
        }
      }
      // 3. The INBOUND CLAIM (the idempotency ledger): a duplicate
      // converges on the committed row — no second side effect, ever.
      // A prior claim is NOT re-appended (the physical freshness guards
      // are new-event guards; a replay's row already exists) — but the
      // BODY-DIGEST ARBITRATION still runs: a same-key/different-body
      // replay fails closed (the poisoned-replay discipline, unchanged).
      const claimKind: RealtimeEventKind =
        input.kind === "user-turn"
          ? "turn-recorded"
          : input.kind === "interruption"
            ? "interruption-recorded"
            : "session-completed";
      if (priorInbound !== undefined) {
        const replayDigest = digest(
          realtimeEventBodyDigestBase({
            sessionId: session.id,
            kind: claimKind,
            direction: "inbound",
            eventKey,
            payloadRef: input.payloadRef ?? null,
            payloadPreview: input.payloadPreview ?? null,
          }),
        );
        if (priorInbound.bodyDigest !== replayDigest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "realtime event key already exists with a different body",
            details: { eventKey },
          });
        }
      }
      const claim =
        priorInbound !== undefined
          ? ({ status: "converged", event: priorInbound } as const)
          : await sessionEvent({
              session,
              kind: claimKind,
              direction: "inbound",
              eventKey,
              cause: null,
              payloadRef: input.payloadRef ?? null,
              payloadPreview: input.payloadPreview ?? null,
              ledgerSequence: null,
              routeClass: null,
              actorId: actor.actorId,
            });
      // 3b. THE DURABLE OPERATION STATE check — the crash-safety
      // discriminator (the architect's correction): a converged claim
      // alone proves NOTHING about the side effect. A COMPLETED
      // operation replays its recorded outcome; a FAILED operation
      // replays its recorded failure; a PENDING or ABSENT operation row
      // means the claim was committed but the durable outcome was not —
      // the pipeline RESUMES below (the rail converges by the stable
      // key: exactly one delivery, ever).
      const turnOperationKey = realtimeOperationKey("turn-delivery", scopedKey);
      if (claim.status === "converged" && input.kind === "user-turn") {
        const operation = await store.findRealtimeOperation(actor.applicationId, turnOperationKey);
        if (operation !== null && operation.status !== "pending") {
          // Fully completed (or durably failed): the winner's processing
          // is the truth. The turn outcome row (outbound) carries the
          // ledger linkage; replays return it.
          const outbound = priorEvents.find(
            (event) => event.direction === "outbound" && event.eventKey === `${eventKey}:turn`,
          );
          return {
            eventKey,
            kind: input.kind,
            routeClass: outbound?.routeClass ?? null,
            responsePreview: outbound?.payloadPreview ?? null,
            responseRef: outbound?.payloadRef ?? null,
            ledgerSequence: outbound?.ledgerSequence ?? claim.event.eventSeq,
            replayed: true,
          };
        }
        // PENDING or ABSENT: fall through and RESUME the turn pipeline.
      }
      if (claim.status === "converged" && input.kind !== "user-turn") {
        // Interruptions carry no external side effect — the provenance
        // keys converge on replay (the dispatch below re-records them).
        // Caller-hangups close through their own durable operation.
      }

      // 4. Interruptions: provenance only — no dispatch, no admission
      // (an interruption is caller input; recording it cannot be a side
      // effect).
      if (input.kind === "interruption") {
        const interruption = await ledger.recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: session.executionId,
            evidenceClass: "interruption",
            cause: "caller interrupted the in-flight turn (barge-in)",
            reference: {
              sessionId: session.id,
              eventKey,
              channelSessionRef: session.channelSessionRef,
              channelEpoch: session.channelEpoch,
              inboundEventSeq: claim.event.eventSeq,
            },
            payload: {
              preview: input.payloadPreview ?? null,
              payloadRef: input.payloadRef ?? null,
            },
          },
          `realtime:interruption:${scopedKey}`,
        );
        await sessionEvent({
          session,
          kind: "interruption-recorded",
          direction: "internal",
          eventKey: `${eventKey}:evidence`,
          cause: null,
          payloadRef: input.payloadRef ?? null,
          payloadPreview: input.payloadPreview ?? null,
          ledgerSequence: interruption.sequence,
          routeClass: null,
          actorId: actor.actorId,
        });
        return {
          eventKey,
          kind: "interruption",
          routeClass: null,
          responsePreview: null,
          responseRef: null,
          ledgerSequence: interruption.sequence,
          replayed: claim.status === "converged" && interruption.replayed,
        };
      }

      // 5. Caller hangup: close the session (terminal) + provenance
      // (through the durable session-close operation).
      if (input.kind === "caller-hangup") {
        return closeFromInbound(
          session,
          actor,
          eventKey,
          claim.event.eventSeq,
          "caller-hangup",
          claim.status === "converged",
        );
      }

      // 6. The durable turn-delivery OPERATION (claim or crash-RESUME —
      // the architect's correction): claimed before the responder and
      // the rail delivery; completed after every durable outcome. A
      // crash in between leaves it PENDING and this invocation RESUMES.
      const begunTurn = await beginOperation("turn-delivery", scopedKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        sessionId: session.id,
        deploymentId: session.deploymentId,
        executionId: session.executionId,
      });
      const respondedCheckpoint =
        begunTurn.status === "existing" &&
        begunTurn.record.status === "pending" &&
        begunTurn.record.checkpoint?.stage === "responded"
          ? begunTurn.record.checkpoint
          : null;
      let route: RealtimeTurnRoute;
      let response: Awaited<ReturnType<typeof responder.respond>>;
      let reservationId: string | null = null;
      let reservedAmountMicroUsd: string | null = null;
      let policySetId: string | null = null;
      let recoveredDelivery = false;
      if (respondedCheckpoint !== null) {
        // CRASH RECOVERY from the responded checkpoint: the admitted
        // responder ALREADY produced the response frame — the delivery
        // resumes with THESE facts. The paid-inference seam is NOT
        // re-invoked; admission is NOT re-run (the decisions preceded
        // the side effect); the rail delivery converges by the stable
        // key (exactly one delivery, ever).
        recoveredDelivery = true;
        reservationId = respondedCheckpoint.reservationId ?? null;
        response = {
          responseRef: respondedCheckpoint.responseRef ?? null,
          responsePreview: respondedCheckpoint.responsePreview ?? "",
          actualCostMicroUsd: respondedCheckpoint.actualCostMicroUsd ?? "0",
        };
        route = {
          routeClass: respondedCheckpoint.routeClass ?? "generative",
          decisionOutcome: respondedCheckpoint.plannerOutcome ?? "uncertain",
          reasonCodes: respondedCheckpoint.reasonCodes ?? [],
          rationale: respondedCheckpoint.deliveryCause ?? "crash-recovered turn",
          estimatedCostMicroUsd: null,
        };
        policySetId = respondedCheckpoint.policySetId ?? null;
      } else {
        // 6a. USER TURN — the planner route (MOD-007: the existing planner
        // decision establishes whether generative inference is needed).
        const { profile } = await resolvePinnedPlan(
          actor.applicationId,
          session.pinnedPlanId,
          session.pinnedPlanVersion,
        );
        route = await router.routeTurn({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: session.id,
          deploymentId: session.deploymentId,
          pinnedPlanId: session.pinnedPlanId,
          pinnedPlanVersion: session.pinnedPlanVersion,
          channelKind: session.channelKind,
          subtaskKind: input.subtaskKind ?? "mixed",
          requiredCapabilities: profile.requiredCapabilities,
          turnPreview: input.payloadPreview ?? null,
          turnPayloadRef: input.payloadRef ?? null,
        });

        // 7. ADMISSION CHAIN — before EVERY governed side effect.
        // 7a. POLICY (turn dispatch).
        const policyDecision = await policy.admit({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: session.id,
          deploymentId: session.deploymentId,
          action: "turn-dispatch",
          channelKind: session.channelKind,
          railCapabilityId: rail.descriptor.railCapabilityId,
          routeClass: route.routeClass,
          secretRef: railConnectionRef,
        });
        policySetId = policyDecision.evidence?.policySetId ?? null;
        if (!policyDecision.allowed) {
          await recordDenial({
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            sessionId: session.id,
            deploymentId: session.deploymentId,
            executionId: session.executionId,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            action: "turn-dispatch",
            code: "POLICY_DENIED",
            reason: policyDecision.reason,
            eventKey: scopedKey,
          });
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "realtime turn dispatch denied by admission policy",
            details: { sessionId: session.id, eventKey, reason: policyDecision.reason },
          });
        }
        // 7b. CAPABILITY (the pinned plan's declaration + the rail).
        const capabilityDecision = await capabilities.resolve({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: session.id,
          requiredCapabilities: profile.requiredCapabilities,
          railCapabilityId: rail.descriptor.railCapabilityId,
        });
        if (!capabilityDecision.satisfied) {
          await recordDenial({
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            sessionId: session.id,
            deploymentId: session.deploymentId,
            executionId: session.executionId,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            action: "turn-dispatch",
            code: "CAPABILITY_UNAVAILABLE",
            reason: `unmet capabilities: ${capabilityDecision.unmet.join(", ")}`,
            eventKey: scopedKey,
          });
          throw new PlatformError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "realtime turn dispatch cannot proceed: required capabilities are unmet",
            details: { sessionId: session.id, unmet: capabilityDecision.unmet },
          });
        }
        // 7c. BUDGET — paid routes only (deterministic routes never
        // reserve: MOD-007's "generative inference is unnecessary").
        if (route.routeClass !== "deterministic" && route.estimatedCostMicroUsd !== null) {
          if (!MICRO_USD_PATTERN.test(route.estimatedCostMicroUsd)) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "the router's paid estimate must be an integer micro-USD string",
            });
          }
          try {
            const reservation = await budget.reserve({
              actorId: actor.actorId,
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              executionId: session.executionId,
              operationId: `realtime-turn:${scopedKey}`,
              amountMicroUsd: route.estimatedCostMicroUsd,
              reason: `realtime turn ${scopedKey} on deployment ${session.deploymentId} (route ${route.routeClass})`,
            });
            reservationId = reservation.reservationId;
            reservedAmountMicroUsd = reservation.amountMicroUsd;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await recordDenial({
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              sessionId: session.id,
              deploymentId: session.deploymentId,
              executionId: session.executionId,
              channelSessionRef: session.channelSessionRef,
              channelEpoch: session.channelEpoch,
              action: "turn-dispatch",
              code: "BUDGET_EXCEEDED",
              reason,
              eventKey: scopedKey,
            });
            throw error;
          }
        }
        // 7d. SECRET — mediated rail-channel credential access
        // (references only; before the rail delivery).
        const mediation = await secrets.mediate({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: session.id,
          connectionRef: railConnectionRef,
        });
        if (!mediation.mediated) {
          await recordDenial({
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            sessionId: session.id,
            deploymentId: session.deploymentId,
            executionId: session.executionId,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            action: "turn-dispatch",
            code: "AUTHORIZATION_DENIED",
            reason: mediation.reason,
            eventKey: scopedKey,
          });
          if (reservationId !== null) {
            await budget
              .release({
                actorId: actor.actorId,
                applicationId: actor.applicationId,
                tenantId: actor.tenantId,
                operationId: `realtime-turn:${scopedKey}`,
              })
              .catch(() => undefined);
          }
          throw new PlatformError({
            code: "AUTHORIZATION_DENIED",
            message: "mediated rail-channel credential access was refused",
            details: { sessionId: session.id, reason: mediation.reason },
          });
        }

        // 8. The responder (the deployed agent's turn handling seam —
        // deterministic content or admitted paid inference). The request
        // carries the turn's STABLE key so a production responder can
        // converge paid inference across crashes/retries.
        response = await responder.respond({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: session.id,
          deploymentId: session.deploymentId,
          pinnedPlanId: session.pinnedPlanId,
          pinnedPlanVersion: session.pinnedPlanVersion,
          channelKind: session.channelKind,
          turnKey: scopedKey,
          routeClass: route.routeClass,
          turnPreview: input.payloadPreview ?? null,
          turnPayloadRef: input.payloadRef ?? null,
          reservationId,
          channelGrantRef: mediation.grantRef,
        });
        // 8b. CHECKPOINT the responded facts BEFORE the rail delivery —
        // the point of no return for the paid-inference seam: a crash from
        // here on resumes the DELIVERY with these facts and never
        // re-invokes admission or the responder (a concurrent winner's
        // completion converges).
        await checkpointOperation(actor.applicationId, turnOperationKey, {
          stage: "responded",
          routeClass: route.routeClass,
          plannerOutcome: route.decisionOutcome,
          reasonCodes: route.reasonCodes.slice(0, 8).map((code) => code.slice(0, 64)),
          responseRef: response.responseRef,
          responsePreview: response.responsePreview.slice(0, 512),
          reservationId,
          actualCostMicroUsd: MICRO_USD_PATTERN.test(response.actualCostMicroUsd)
            ? response.actualCostMicroUsd
            : "0",
          deliveryCause: route.rationale.slice(0, 400),
          policySetId,
        });
      } // end of the full turn pipeline (the non-resumed path)

      // 9. THE RAIL DELIVERY (the governed external side effect) — under
      // the STABLE rail-level idempotency key: a retry or crash-resume
      // re-delivers under the SAME key and the rail converges (exactly
      // one upstream delivery, ever).
      const delivery = await rail.deliverTurn({
        applicationId: actor.applicationId,
        sessionId: session.id,
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        routeClass: route.routeClass,
        idempotencyKey: realtimeRailDeliverKey(scopedKey),
        responseRef: response.responseRef,
        responsePreview: response.responsePreview,
        cause: route.rationale.slice(0, 400),
      });
      if (!delivery.delivered) {
        // Failure provenance: the turn failed on the rail (normalized,
        // rail detail retained as evidence — never domain control flow).
        const failure = await ledger.recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: session.executionId,
            evidenceClass: "failure",
            cause: "realtime turn delivery failed on the upstream rail",
            reference: {
              sessionId: session.id,
              eventKey,
              channelSessionRef: session.channelSessionRef,
              channelEpoch: session.channelEpoch,
            },
            payload: { reason: delivery.reason, routeClass: route.routeClass },
          },
          `realtime:failure:${scopedKey}`,
        );
        await sessionEvent({
          session,
          kind: "failure-recorded",
          direction: "outbound",
          eventKey: `${eventKey}:turn`,
          cause: `rail delivery failed: ${delivery.reason.slice(0, 400)}`,
          payloadRef: response.responseRef,
          payloadPreview: response.responsePreview.slice(0, 512),
          ledgerSequence: failure.sequence,
          routeClass: route.routeClass,
          actorId: actor.actorId,
        });
        if (reservationId !== null) {
          await budget
            .release({
              actorId: actor.actorId,
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              operationId: `realtime-turn:${scopedKey}`,
            })
            .catch(() => undefined);
        }
        // The operation's terminal FAILURE outcome: durably recorded on
        // both ledgers — a later retry under the same key REPLAYS this
        // recorded failure (no duplicate side effect, no turn loss).
        await store
          .failRealtimeOperation(
            actor.applicationId,
            turnOperationKey,
            `rail delivery refused: ${delivery.reason.slice(0, 400)}`,
            iso(),
          )
          .catch(() => undefined);
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the realtime rail refused the turn delivery",
          details: { sessionId: session.id, reason: delivery.reason },
        });
      }

      // 10. Budget settle (actual usage; unused remainder releases).
      if (reservationId !== null) {
        await budget
          .settle({
            actorId: actor.actorId,
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            operationId: `realtime-turn:${scopedKey}`,
            actualAmountMicroUsd: MICRO_USD_PATTERN.test(response.actualCostMicroUsd)
              ? response.actualCostMicroUsd
              : (reservedAmountMicroUsd ?? "0"),
          })
          .catch(() => undefined);
      }

      // 11. Turn provenance (the executions ledger — the canonical path).
      const turnEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: session.executionId,
          evidenceClass: "turn",
          // REPLAY-STABLE evidence: the cause/reference/payload are
          // IDENTICAL for the original invocation and any crash-resume
          // or concurrent duplicate (the executions idempotency
          // arbitrates by key + fingerprint — an unstable marker would
          // fail a legitimate recovery closed). Recovery observability
          // rides the JOURNAL causes instead (never digested).
          cause: `realtime turn dispatched (${route.routeClass})`,
          reference: {
            sessionId: session.id,
            eventKey,
            pinnedPlanId: session.pinnedPlanId,
            pinnedPlanVersion: session.pinnedPlanVersion,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            responseRef: response.responseRef,
            reservationId,
            policySet: policySetId,
          },
          payload: {
            routeClass: route.routeClass,
            plannerOutcome: route.decisionOutcome,
            reasonCodes: route.reasonCodes,
            responsePreview: response.responsePreview.slice(0, 512),
            inboundPreview: input.payloadPreview ?? null,
            deliveredAt: delivery.deliveredAt,
            railMetadata: delivery.railMetadata ?? {},
          },
        },
        `realtime:turn:${scopedKey}`,
      );
      await sessionEvent({
        session,
        kind: "turn-recorded",
        direction: "outbound",
        eventKey: `${eventKey}:turn`,
        // Recovery observability rides the JOURNAL cause (never
        // fingerprint-arbitrated, never in the body digest).
        cause: recoveredDelivery ? "crash-recovered turn delivery" : null,
        payloadRef: response.responseRef,
        payloadPreview: response.responsePreview.slice(0, 512),
        ledgerSequence: turnEvidence.sequence,
        routeClass: route.routeClass,
        actorId: actor.actorId,
      });
      // 12. The durable operation COMPLETION — after every durable
      // outcome (a crash before this leaves the row PENDING and the
      // retry completes the turn from the checkpoint: exactly one
      // delivery, no turn loss).
      await store.completeRealtimeOperation(actor.applicationId, turnOperationKey, iso());
      return {
        eventKey,
        kind: "user-turn",
        routeClass: route.routeClass,
        responsePreview: response.responsePreview,
        responseRef: response.responseRef,
        ledgerSequence: turnEvidence.sequence,
        replayed: claim.status === "converged" && turnEvidence.replayed,
      };
    },

    /** Policy-designated, auditable human escalation/transfer. */
    async transferToHuman(
      input: {
        readonly sessionId: string;
        readonly channelSessionRef?: string;
        readonly channelEpoch?: number;
        readonly destination?: string;
        readonly cause?: string;
      },
      idempotencyKey: string,
      actor: RealtimeActor,
    ): Promise<{
      readonly sessionId: string;
      readonly executionId: string;
      readonly ledgerSequence: number;
      readonly replayed: boolean;
    }> {
      requireKey(idempotencyKey);
      const cause = requireCause(input.cause);
      const destination = input.destination ?? "human-operator";
      const session = await resolveSession(actor, input.sessionId);
      // The durable human-transfer OPERATION key (the recovery
      // discriminator — the same retry derives the same key).
      const operationKey = realtimeOperationKey("human-transfer", idempotencyKey);
      // Idempotent replay: a terminal transferred session with this key
      // replays its committed outcome (a PENDING operation row is the
      // crash window between the terminal move and the completion —
      // reconcile it: the terminal status is the durable proof).
      if (session.status === "transferred") {
        const operation = await store.findRealtimeOperation(actor.applicationId, operationKey);
        if (operation !== null && operation.status === "pending") {
          await store
            .completeRealtimeOperation(actor.applicationId, operationKey, iso())
            .catch(() => undefined);
        }
        const events = await store.listEvents(actor.applicationId, session.id);
        const replay = events.find(
          (event) =>
            event.kind === "transfer-recorded" && event.eventKey === `${idempotencyKey}:transfer`,
        );
        if (replay !== undefined) {
          return {
            sessionId: session.id,
            executionId: session.executionId,
            ledgerSequence: replay.ledgerSequence ?? 0,
            replayed: true,
          };
        }
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `realtime session ${session.id} is already terminal (${session.status}) under a different transfer key`,
        });
      }
      if (isTerminalRealtimeSessionStatus(session.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `realtime session ${session.id} is terminal (${session.status}); transfer requires a non-terminal session`,
        });
      }
      if (input.channelSessionRef !== undefined && input.channelEpoch !== undefined) {
        await resolveSession(actor, input.sessionId, {
          channelSessionRef: input.channelSessionRef,
          channelEpoch: input.channelEpoch,
        });
      }
      // The durable operation claim — BEFORE the rail side effect (a
      // crash between the rail transfer and the terminal mutation
      // leaves this row PENDING; the retry resumes with the STABLE rail
      // key instead of transferring twice).
      const begun = await beginOperation("human-transfer", idempotencyKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        sessionId: session.id,
        deploymentId: session.deploymentId,
        executionId: session.executionId,
      });
      let policySetId: string | null = null;
      let recoveredTransfer = false;
      let transferDeliveredAt: string | null = null;
      if (begun.status === "existing" && begun.record.status === "completed") {
        // A concurrent invocation completed this operation: the terminal
        // status MUST be committed (completion follows the terminal move).
        const reread = await store.findSession(actor.applicationId, session.id);
        if (reread === null || reread.status !== "transferred") {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "realtime transfer operation is completed but the session is not transferred (invariant violation)",
          });
        }
        const events = await store.listEvents(actor.applicationId, session.id);
        const replay = events.find(
          (event) =>
            event.kind === "transfer-recorded" && event.eventKey === `${idempotencyKey}:transfer`,
        );
        return {
          sessionId: session.id,
          executionId: session.executionId,
          ledgerSequence: replay?.ledgerSequence ?? 0,
          replayed: true,
        };
      }
      if (begun.status === "existing" && begun.record.status === "failed") {
        // The durably recorded rail refusal: a retry under the same key
        // replays the recorded failure (no duplicate side effect).
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the realtime rail refused the human transfer (recorded failure)",
          details: {
            sessionId: session.id,
            reason: begun.record.failureReason ?? undefined,
          },
        });
      }
      const railIssued =
        begun.status === "existing" &&
        begun.record.status === "pending" &&
        begun.record.checkpoint?.stage === "rail-issued";
      if (railIssued) {
        // CRASH RECOVERY: the rail transfer was already issued under the
        // STABLE key — skip re-admission (the decision preceded the side
        // effect) and complete the durable tail.
        recoveredTransfer = true;
        policySetId = begun.record.checkpoint?.policySetId ?? null;
        transferDeliveredAt = begun.record.checkpoint?.deliveredAt ?? null;
      } else {
        // POLICY-DESIGNATED escalation: the policy admission decides
        // BEFORE any side effect (no execution wait, no rail transfer).
        const decision = await policy.admit({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          sessionId: session.id,
          deploymentId: session.deploymentId,
          action: "human-transfer",
          channelKind: session.channelKind,
          railCapabilityId: rail.descriptor.railCapabilityId,
          routeClass: null,
          secretRef: railConnectionRef,
        });
        policySetId = decision.evidence?.policySetId ?? null;
        if (!decision.allowed) {
          await recordDenial({
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            sessionId: session.id,
            deploymentId: session.deploymentId,
            executionId: session.executionId,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            action: "human-transfer",
            code: "POLICY_DENIED",
            reason: decision.reason,
            eventKey: `${idempotencyKey}:transfer`,
          });
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "human transfer denied by admission policy (escalation is policy-designated)",
            details: { sessionId: session.id, reason: decision.reason },
          });
        }
      } // end of the policy stage (skipped on crash recovery)
      // The auditable execution wait (the public transition surface; the
      // idempotent command converges on recovery).
      const wait = await ledger.awaitHuman(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: session.executionId,
          reason: `realtime session transferred to ${destination}${cause === null ? "" : `: ${cause}`}`,
        },
        `${idempotencyKey}:wait-human`,
      );
      if (!railIssued) {
        // The rail transfer (the external side effect) — under the STABLE
        // rail-level idempotency key: a retry or crash-resume re-transfers
        // under the SAME key and the rail converges (exactly one upstream
        // transfer, ever).
        const transfer = await rail.transferCall({
          applicationId: actor.applicationId,
          sessionId: session.id,
          channelSessionRef: session.channelSessionRef,
          channelEpoch: session.channelEpoch,
          routeClass: "deterministic",
          idempotencyKey: realtimeRailTransferKey(idempotencyKey),
          responseRef: null,
          responsePreview: `transfer to ${destination}`,
          cause: cause ?? "human escalation",
        });
        if (!transfer.delivered) {
          // Failure provenance (AC4): the transfer failed on the rail AFTER
          // the governed wait — durably recorded on both ledgers, then the
          // typed failure (no transfer journal row, no terminal move).
          const transferFailure = await ledger.recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: session.executionId,
              evidenceClass: "failure",
              cause: "realtime human transfer failed on the upstream rail",
              reference: {
                sessionId: session.id,
                eventKey: `${idempotencyKey}:transfer`,
                channelSessionRef: session.channelSessionRef,
                channelEpoch: session.channelEpoch,
                waitSequence: wait.sequence,
              },
              payload: { destination, reason: transfer.reason },
            },
            `realtime:transfer-failure:${idempotencyKey}`,
          );
          await sessionEvent({
            session,
            kind: "failure-recorded",
            direction: "outbound",
            eventKey: `${idempotencyKey}:transfer`,
            cause: `rail transfer failed: ${transfer.reason.slice(0, 400)}`,
            payloadRef: null,
            payloadPreview: `transfer to ${destination}`,
            ledgerSequence: transferFailure.sequence,
            routeClass: null,
            actorId: actor.actorId,
          });
          // The operation's terminal FAILURE outcome: durably recorded on
          // both ledgers — a later retry under the same key REPLAYS this
          // recorded failure (no duplicate side effect).
          await store
            .failRealtimeOperation(
              actor.applicationId,
              operationKey,
              `rail transfer refused: ${transfer.reason.slice(0, 400)}`,
              iso(),
            )
            .catch(() => undefined);
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "the realtime rail refused the human transfer",
            details: { sessionId: session.id, reason: transfer.reason },
          });
        }
        // CHECKPOINT the point-of-no-return (the rail transfer was issued;
        // the durable tail completes from here on recovery; a concurrent
        // winner's completion converges).
        transferDeliveredAt = transfer.deliveredAt;
        await checkpointOperation(actor.applicationId, operationKey, {
          stage: "rail-issued",
          deliveredAt: transfer.deliveredAt,
          policySetId,
        });
      } // end of the rail-transfer stage (skipped on crash recovery)
      // Transfer provenance (the canonical ledger).
      const transferEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: session.executionId,
          evidenceClass: "transfer",
          // REPLAY-STABLE evidence (see the turn note above): the
          // recovery marker rides the journal cause, never this
          // fingerprint-arbitrated record.
          cause: `realtime session transferred to ${destination}`,
          reference: {
            sessionId: session.id,
            eventKey: `${idempotencyKey}:transfer`,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
            policySet: policySetId,
            waitSequence: wait.sequence,
          },
          payload: {
            destination,
            cause,
            deliveredAt: transferDeliveredAt ?? undefined,
          },
        },
        `realtime:transfer:${idempotencyKey}`,
      );
      await sessionEvent({
        session,
        kind: "transfer-recorded",
        direction: "outbound",
        eventKey: `${idempotencyKey}:transfer`,
        // Recovery observability rides the JOURNAL cause (never
        // fingerprint-arbitrated, never in the body digest).
        cause: recoveredTransfer
          ? `${cause ?? `transferred to ${destination}`} (crash-recovered)`
          : (cause ?? `transferred to ${destination}`),
        payloadRef: null,
        payloadPreview: `transfer to ${destination}`,
        ledgerSequence: transferEvidence.sequence,
        routeClass: null,
        actorId: actor.actorId,
      });
      // Terminal status move (guarded, idempotent convergence).
      const applied = await store.applyGuardedSessionMutation({
        applicationId: actor.applicationId,
        sessionId: session.id,
        expectedStatus: session.status,
        toStatus: "transferred",
        expectedChannelRef: session.channelSessionRef,
        expectedChannelEpoch: session.channelEpoch,
        toChannelRef: null,
        toChannelEpoch: null,
        closedAt: iso(),
      });
      // The durable operation COMPLETION — after every durable outcome
      // (a crash before this leaves the row PENDING; the retry converges
      // via the transferred-status reconciliation above).
      await store.completeRealtimeOperation(actor.applicationId, operationKey, iso());
      return {
        sessionId: applied.session.id,
        executionId: session.executionId,
        ledgerSequence: transferEvidence.sequence,
        replayed: recoveredTransfer || wait.replayed,
      };
    },

    /**
     * Reconnect: bind a NEW rail channel coordinate to the SAME session
     * (guarded, epoch-monotonic). The execution identity NEVER changes —
     * reconnect cannot create a second authoritative execution.
     */
    async reattachSession(
      input: {
        readonly sessionId: string;
        readonly newChannelSessionRef: string;
        readonly cause?: string;
      },
      idempotencyKey: string,
      actor: RealtimeActor,
    ): Promise<{
      readonly sessionId: string;
      readonly executionId: string;
      readonly channelSessionRef: string;
      readonly channelEpoch: number;
      readonly replayed: boolean;
    }> {
      requireKey(idempotencyKey);
      const cause = requireCause(input.cause);
      if (
        typeof input.newChannelSessionRef !== "string" ||
        !/^[\x21-\x7e]{1,200}$/.test(input.newChannelSessionRef)
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "newChannelSessionRef must be a printable reference (1..200 chars)",
        });
      }
      const session = await resolveSession(actor, input.sessionId);
      if (isTerminalRealtimeSessionStatus(session.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `realtime session ${session.id} is terminal (${session.status}); a closed call cannot reconnect`,
        });
      }
      const applied = await store.applyGuardedSessionMutation({
        applicationId: actor.applicationId,
        sessionId: session.id,
        expectedStatus: session.status,
        toStatus: "live",
        expectedChannelRef: session.channelSessionRef,
        expectedChannelEpoch: session.channelEpoch,
        toChannelRef: input.newChannelSessionRef,
        toChannelEpoch: session.channelEpoch + 1,
        closedAt: null,
      });
      const updated = applied.session;
      // Reconnect provenance (significant action; the execution
      // identity is unchanged — the SAME execution id rides the event).
      const reattachEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: updated.executionId,
          evidenceClass: "significant-action",
          cause: "realtime session reattached to a new rail channel coordinate",
          reference: {
            sessionId: updated.id,
            priorChannelSessionRef: session.channelSessionRef,
            priorChannelEpoch: session.channelEpoch,
            newChannelSessionRef: updated.channelSessionRef,
            newChannelEpoch: updated.channelEpoch,
            executionId: updated.executionId,
          },
          payload: { cause, reattachedAt: iso() },
        },
        `realtime:reattach:${idempotencyKey}`,
      );
      await sessionEvent({
        session: updated,
        kind: "session-reattached",
        direction: "internal",
        eventKey: `${idempotencyKey}:reattach`,
        cause,
        payloadRef: null,
        payloadPreview: null,
        ledgerSequence: reattachEvidence.sequence,
        routeClass: null,
        actorId: actor.actorId,
      });
      return {
        sessionId: updated.id,
        executionId: updated.executionId,
        channelSessionRef: updated.channelSessionRef,
        channelEpoch: updated.channelEpoch,
        replayed: applied.status === "converged",
      };
    },

    /** Close the session (terminal) with completion provenance. */
    async closeSession(
      input: { readonly sessionId: string; readonly cause?: string },
      idempotencyKey: string,
      actor: RealtimeActor,
    ): Promise<{
      readonly sessionId: string;
      readonly executionId: string;
      readonly replayed: boolean;
    }> {
      requireKey(idempotencyKey);
      const cause = requireCause(input.cause);
      const session = await resolveSession(actor, input.sessionId);
      // The durable session-close OPERATION key (the recovery
      // discriminator — the same retry derives the same key).
      const operationKey = realtimeOperationKey("session-close", idempotencyKey);
      if (isTerminalRealtimeSessionStatus(session.status)) {
        // CRASH RECOVERY: a PENDING close operation under this key means
        // the terminal move committed but the completion did not — the
        // terminal status IS the durable proof; reconcile and replay.
        const operation = await store.findRealtimeOperation(actor.applicationId, operationKey);
        if (operation !== null && operation.status === "pending") {
          await store
            .completeRealtimeOperation(actor.applicationId, operationKey, iso())
            .catch(() => undefined);
        }
        return { sessionId: session.id, executionId: session.executionId, replayed: true };
      }
      // The durable operation claim — BEFORE the rail side effect (a
      // crash between the rail close and the terminal mutation leaves
      // this row PENDING; the retry resumes with the STABLE rail key
      // instead of closing twice).
      const begun = await beginOperation("session-close", idempotencyKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        sessionId: session.id,
        deploymentId: session.deploymentId,
        executionId: session.executionId,
      });
      if (begun.status === "existing" && begun.record.status === "completed") {
        // A concurrent invocation completed this close: the terminal
        // status MUST be committed (completion follows the terminal move).
        const reread = await store.findSession(actor.applicationId, session.id);
        if (reread === null || !isTerminalRealtimeSessionStatus(reread.status)) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "realtime close operation is completed but the session is not terminal (invariant violation)",
          });
        }
        return { sessionId: session.id, executionId: session.executionId, replayed: true };
      }
      const completion = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: session.executionId,
          evidenceClass: "session-completed",
          cause: "realtime session closed",
          reference: {
            sessionId: session.id,
            eventKey: `${idempotencyKey}:close`,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
          },
          payload: { cause, pinnedPlanVersion: session.pinnedPlanVersion },
        },
        `realtime:completion:${idempotencyKey}`,
      );
      // The rail close (best-effort upstream cleanup) — under the STABLE
      // rail-level idempotency key: a retry or crash-resume re-closes
      // under the SAME key and the rail converges (exactly one upstream
      // close, ever).
      await rail
        .closeSession({
          applicationId: actor.applicationId,
          sessionId: session.id,
          channelSessionRef: session.channelSessionRef,
          channelEpoch: session.channelEpoch,
          idempotencyKey: realtimeRailCloseKey(idempotencyKey),
          cause,
        })
        .catch(() => undefined);
      await sessionEvent({
        session,
        kind: "session-completed",
        direction: "internal",
        eventKey: `${idempotencyKey}:close`,
        cause,
        payloadRef: null,
        payloadPreview: null,
        ledgerSequence: completion.sequence,
        routeClass: null,
        actorId: actor.actorId,
      });
      if (!isTerminalRealtimeSessionStatus(session.status)) {
        await store.applyGuardedSessionMutation({
          applicationId: actor.applicationId,
          sessionId: session.id,
          expectedStatus: session.status,
          toStatus: "closed",
          expectedChannelRef: session.channelSessionRef,
          expectedChannelEpoch: session.channelEpoch,
          toChannelRef: null,
          toChannelEpoch: null,
          closedAt: iso(),
        });
      }
      // The durable operation COMPLETION — after every durable outcome.
      await store.completeRealtimeOperation(actor.applicationId, operationKey, iso());
      return {
        sessionId: session.id,
        executionId: session.executionId,
        replayed: begun.status === "existing",
      };
    },

    /** Fail the session (terminal) with failure provenance. */
    async failSession(
      input: { readonly sessionId: string; readonly cause: string },
      idempotencyKey: string,
      actor: RealtimeActor,
    ): Promise<{
      readonly sessionId: string;
      readonly executionId: string;
      readonly replayed: boolean;
    }> {
      requireKey(idempotencyKey);
      const cause = requireCause(input.cause);
      if (cause === null) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: "a failure cause is required" });
      }
      const session = await resolveSession(actor, input.sessionId);
      // The durable session-close OPERATION key for the failure path (a
      // DISTINCT key from the graceful close: different logical outcome).
      const operationKey = realtimeOperationKey("session-close", `${idempotencyKey}:fail`);
      if (isTerminalRealtimeSessionStatus(session.status)) {
        // CRASH RECOVERY: reconcile a pending failure-close operation
        // (the terminal status is the durable proof), then replay.
        const operation = await store.findRealtimeOperation(actor.applicationId, operationKey);
        if (operation !== null && operation.status === "pending") {
          await store
            .completeRealtimeOperation(actor.applicationId, operationKey, iso())
            .catch(() => undefined);
        }
        return { sessionId: session.id, executionId: session.executionId, replayed: true };
      }
      // The durable operation claim — BEFORE the rail side effect.
      const begun = await beginOperation("session-close", `${idempotencyKey}:fail`, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        sessionId: session.id,
        deploymentId: session.deploymentId,
        executionId: session.executionId,
      });
      if (begun.status === "existing" && begun.record.status === "completed") {
        const reread = await store.findSession(actor.applicationId, session.id);
        if (reread === null || !isTerminalRealtimeSessionStatus(reread.status)) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "realtime fail operation is completed but the session is not terminal (invariant violation)",
          });
        }
        return { sessionId: session.id, executionId: session.executionId, replayed: true };
      }
      const failure = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: session.executionId,
          evidenceClass: "failure",
          cause: "realtime session failed",
          reference: {
            sessionId: session.id,
            eventKey: `${idempotencyKey}:fail`,
            channelSessionRef: session.channelSessionRef,
            channelEpoch: session.channelEpoch,
          },
          payload: { cause, pinnedPlanVersion: session.pinnedPlanVersion },
        },
        `realtime:failure:${idempotencyKey}`,
      );
      await sessionEvent({
        session,
        kind: "session-failed",
        direction: "internal",
        eventKey: `${idempotencyKey}:fail`,
        cause,
        payloadRef: null,
        payloadPreview: null,
        ledgerSequence: failure.sequence,
        routeClass: null,
        actorId: actor.actorId,
      });
      // The rail close (best-effort) — under the STABLE rail-level
      // idempotency key: a retry or crash-resume converges (exactly one
      // upstream close, ever).
      await rail
        .closeSession({
          applicationId: actor.applicationId,
          sessionId: session.id,
          channelSessionRef: session.channelSessionRef,
          channelEpoch: session.channelEpoch,
          idempotencyKey: realtimeRailCloseKey(`${idempotencyKey}:fail`),
          cause: `failed: ${cause}`,
        })
        .catch(() => undefined);
      if (!isTerminalRealtimeSessionStatus(session.status)) {
        await store.applyGuardedSessionMutation({
          applicationId: actor.applicationId,
          sessionId: session.id,
          expectedStatus: session.status,
          toStatus: "failed",
          expectedChannelRef: session.channelSessionRef,
          expectedChannelEpoch: session.channelEpoch,
          toChannelRef: null,
          toChannelEpoch: null,
          closedAt: iso(),
        });
      }
      // The durable operation COMPLETION — after every durable outcome.
      await store.completeRealtimeOperation(actor.applicationId, operationKey, iso());
      return {
        sessionId: session.id,
        executionId: session.executionId,
        replayed: begun.status === "existing",
      };
    },

    /** Read one session (application-scoped) with its execution facts. */
    async getSession(applicationId: string, sessionId: string) {
      if (!isUuid(applicationId) || !isUuid(sessionId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "applicationId/sessionId must be UUIDs",
        });
      }
      const session = await store.findSession(applicationId, sessionId);
      if (session === null) {
        return null;
      }
      const execution = await ledger.readExecution(applicationId, session.executionId);
      return { session, execution };
    },

    /** The channel journal of one session (append order). */
    async listSessionEvents(applicationId: string, sessionId: string) {
      if (!isUuid(applicationId) || !isUuid(sessionId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "applicationId/sessionId must be UUIDs",
        });
      }
      return store.listEvents(applicationId, sessionId);
    },
  };

  /**
   * The caller-hangup close path (from ingestInboundEvent) — through the
   * DURABLE session-close operation: the claim precedes the rail close,
   * the completion follows the terminal move. A crash in between leaves
   * the operation PENDING and the hangup retry RESUMES it (the rail
   * converges by the STABLE key) instead of being rejected or lost.
   */
  async function closeFromInbound(
    session: RealtimeSessionRecord,
    actor: RealtimeActor,
    eventKey: string,
    inboundEventSeq: number,
    reason: string,
    claimConverged: boolean,
  ): Promise<RealtimeIngestOutcome> {
    // The durable session-close OPERATION for the hangup (discriminated
    // by the SESSION-SCOPED inbound event key — event keys are unique per
    // (application, session), so the discriminator carries the session
    // identity; the same hangup retry derives the same key).
    const operationKey = realtimeOperationKey("session-close", `${session.id}:${eventKey}:hangup`);
    const existing = await store.findRealtimeOperation(actor.applicationId, operationKey);
    if (existing !== null && existing.status === "completed") {
      // TRUE REPLAY: the close completed durably — return the recorded
      // outcome (no side effect, no second close).
      const events = await store.listEvents(actor.applicationId, session.id);
      const closeRow = events.find(
        (event) => event.kind === "session-completed" && event.eventKey === `${eventKey}:close`,
      );
      return {
        eventKey,
        kind: "caller-hangup",
        routeClass: null,
        responsePreview: null,
        responseRef: null,
        ledgerSequence: closeRow?.ledgerSequence ?? 0,
        replayed: true,
      };
    }
    // Claim (or re-claim — a PENDING row is the crash window; the
    // attempts ledger records the resume).
    if (existing === null) {
      await beginOperation("session-close", `${session.id}:${eventKey}:hangup`, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        sessionId: session.id,
        deploymentId: session.deploymentId,
        executionId: session.executionId,
      });
    }
    const completion = await ledger.recordEvidence(
      {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        actorId: actor.actorId,
        executionId: session.executionId,
        evidenceClass: "session-completed",
        cause: `realtime session closed (${reason})`,
        reference: {
          sessionId: session.id,
          eventKey,
          channelSessionRef: session.channelSessionRef,
          channelEpoch: session.channelEpoch,
          inboundEventSeq,
        },
        payload: { reason, pinnedPlanVersion: session.pinnedPlanVersion },
      },
      `realtime:completion:${`${session.id}:${eventKey}`}`,
    );
    await sessionEvent({
      session,
      kind: "session-completed",
      direction: "internal",
      eventKey: `${eventKey}:close`,
      cause: reason,
      payloadRef: null,
      payloadPreview: null,
      ledgerSequence: completion.sequence,
      routeClass: null,
      actorId: actor.actorId,
    });
    // The rail close (best-effort) — under the STABLE rail-level
    // idempotency key: a crash-resume re-closes under the SAME key and
    // the rail converges (exactly one upstream close, ever).
    await rail
      .closeSession({
        applicationId: actor.applicationId,
        sessionId: session.id,
        channelSessionRef: session.channelSessionRef,
        channelEpoch: session.channelEpoch,
        idempotencyKey: realtimeRailCloseKey(`${session.id}:${eventKey}:hangup`),
        cause: reason,
      })
      .catch(() => undefined);
    if (!isTerminalRealtimeSessionStatus(session.status)) {
      await store.applyGuardedSessionMutation({
        applicationId: actor.applicationId,
        sessionId: session.id,
        expectedStatus: session.status,
        toStatus: "closed",
        expectedChannelRef: session.channelSessionRef,
        expectedChannelEpoch: session.channelEpoch,
        toChannelRef: null,
        toChannelEpoch: null,
        closedAt: iso(),
      });
    }
    // The durable operation COMPLETION — after every durable outcome.
    await store.completeRealtimeOperation(actor.applicationId, operationKey, iso());
    return {
      eventKey,
      kind: "caller-hangup",
      routeClass: null,
      responsePreview: null,
      responseRef: null,
      ledgerSequence: completion.sequence,
      replayed: claimConverged && completion.replayed,
    };
  }
}

export type RealtimeSessionService = ReturnType<typeof createRealtimeSessionService>;
