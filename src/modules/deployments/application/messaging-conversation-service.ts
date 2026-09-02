/**
 * Messaging conversation service (deployments module application;
 * WORK-025, MOD-008/MOD-009).
 *
 * THE governed lifecycle of provider-neutral conversational messaging
 * over the WORK-023 deployment fabric. A conversation MAPS TO a
 * governed Execution and a pinned deployment plan version; every
 * operation is idempotent, audited and concurrency-safe; inbound
 * messages, outbound replies, delivery callbacks, human escalations,
 * failures and significant actions are preserved as EXECUTION
 * provenance through the executions ledger (the module's messaging
 * ledger port — the single canonical event path; the message ledger is
 * conversation state + the inbound idempotency ledger + ordering
 * evidence, never a second event authority).
 *
 * The frozen admission ordering (the models-gateway / IMPLEMENTATION.md
 * §7 discipline — MOD-009's policy-before-send): TENANT scope
 * resolution → POLICY admission → CAPABILITY resolution → BUDGET
 * reservation (paid routes only) → SECRET mediation → THEN the
 * governed side effects (rail send / paid inference). A denial at ANY
 * stage happens BEFORE every side effect and is durably recorded
 * (journal-then-fail) on the message ledger AND the execution ledger.
 *
 * DURABLE, RECOVERABLE OPERATION STATE (the WORK-024 crash-safety
 * standard — the architect's review bar): every operation that can
 * perform an external side effect owns ONE durable operation row
 * (pending → completed | failed) plus a STABLE rail-level idempotency
 * key. The ordering rule: the durable operation claim is written
 * BEFORE the rail side effect, and the durable completion AFTER every
 * durable outcome — a crash in between leaves the row PENDING, and a
 * retry RESUMES it (the rail converges by key: exactly one upstream
 * side effect, ever) instead of mistaking the claim for convergence.
 * A stage checkpoint marks the point of no return: resumption past it
 * NEVER re-runs admission (the decision preceded the side effect) and
 * completes the durable tail from the checkpointed facts.
 *
 * ```text
 * startConversation → deployment facts (tenant-guarded, active
 *                     status) → version PIN (the deployment's current
 *                     plan) → policy admission → execution identity
 *                     (idempotent) → OP CLAIM → rail conversation open
 *                     (STABLE KEY) → CHECKPOINT(conversation-opened)
 *                     → durable conversation row → provenance
 *                     (conversation-started) → OP COMPLETE
 * ingestEvent       → conversation resolution (tenant guard; terminal
 *                     guard for NEW events) → event key (upstream id
 *                     or deterministic substitute) → ordering
 *                     resolution (the channel contract's declared
 *                     semantics — in-order/out-of-order/gap/assigned
 *                     evidence, never a block) → inbound claim
 *                     (idempotency ledger — duplicates converge, no
 *                     second side effect) → OP STATE check (completed
 *                     → pure replay; failed → recorded failure;
 *                     pending/absent → RESUME) → planner route
 *                     (deterministic/hybrid/generative) → policy →
 *                     capability → budget (paid routes) → secret
 *                     mediation → responder → CHECKPOINT(responded)
 *                     → RAIL SEND (STABLE KEY) → budget settle →
 *                     provenance + reply row → OP COMPLETE
 * applyDelivery     → conversation + message resolution (tenant +
 *                     correlation guards) → callback key (upstream id
 *                     or deterministic substitute) → OP CLAIM →
 *                     delivery evidence row (UNIQUE per conversation)
 *                     → guarded monotonic projection (pending → sent →
 *                     delivered|undelivered — evidence, never a second
 *                     execution state machine) → provenance (delivery)
 *                     → OP COMPLETE
 * escalateToHuman   → policy-designated escalation (deny → no side
 *                     effect) → OP CLAIM → execution wait-human (the
 *                     GOVERNED escalation step) → rail escalation
 *                     notice (STABLE KEY) → CHECKPOINT(rail-issued) →
 *                     escalation record + provenance → OP COMPLETE
 * closeConversation → OP CLAIM → provenance → rail close (STABLE KEY,
 *                     best-effort) → marker row → terminal → OP
 *                     COMPLETE
 * ```
 *
 * Deployment version pinning: the conversation pins the plan version
 * at start; promotion/rollback on the deployment moves the pointer for
 * NEW conversations only — live conversations keep their pin and their
 * execution identity (provenance never rewritten).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type {
  MessagingConversationRecord,
  MessagingDeliveryCallbackInput,
  MessagingDeliveryStatus,
  MessagingInboundEventInput,
  MessagingMessageKind,
  MessagingOperationCheckpoint,
  MessagingOperationKind,
  MessagingOperationRecord,
  MessagingOrderingMarker,
  MessagingRouteClass,
  StartMessagingConversationInput,
} from "../domain/messaging";
import {
  deterministicMessagingCallbackKey,
  deterministicMessagingEventKey,
  isTerminalMessagingConversationStatus,
  isTerminalMessagingDeliveryStatus,
  messagingContainsRawSecretValue,
  messagingConversationCreationFingerprint,
  messagingMessageBodyDigestBase,
  messagingOperationKey,
  messagingRailCloseKey,
  messagingRailEscalateKey,
  messagingRailOpenKey,
  messagingRailSendKey,
  resolveMessagingOrdering,
  validateMessagingDeliveryCallback,
  validateMessagingInboundEvent,
  validateStartMessagingConversationInput,
} from "../domain/messaging";
import type { DeploymentStore } from "../ports/deployment-store";
import type {
  MessagingBudgetAdmission,
  MessagingCapabilityAdmission,
  MessagingPolicyAdmission,
  MessagingSecretMediation,
} from "../ports/messaging-admission";
import type { MessagingExecutionLedger } from "../ports/messaging-execution-ledger";
import type { MessagingRail } from "../ports/messaging-rail";
import type { MessagingStore } from "../ports/messaging-store";
import type { MessagingSubtaskRouter, MessagingTurnRoute } from "../ports/messaging-subtask-router";
import type { MessagingTurnResponder } from "../ports/messaging-turn-responder";

/** The read-only deployment-facts surface this service consumes. */
export type MessagingDeploymentFacts = Pick<
  DeploymentStore,
  "findDeployment" | "findPlan" | "findProfile"
>;

export interface MessagingActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface MessagingConversationServiceDeps {
  readonly store: MessagingStore;
  /** Read-only deployment facts through the WORK-023 fabric store. */
  readonly deployments: MessagingDeploymentFacts;
  /** The provider-neutral upstream messaging rail (replaceable infrastructure). */
  readonly rail: MessagingRail;
  /** REQUIRED policy admission (no default-allow exists). */
  readonly policy: MessagingPolicyAdmission;
  /** REQUIRED capability admission. */
  readonly capabilities: MessagingCapabilityAdmission;
  /** REQUIRED budget admission (paid routes). */
  readonly budget: MessagingBudgetAdmission;
  /** REQUIRED secret mediation (rail channel credentials, references only). */
  readonly secrets: MessagingSecretMediation;
  /** REQUIRED planner-decided subtask routing. */
  readonly router: MessagingSubtaskRouter;
  /** REQUIRED reply responder (the deployed agent's turn handling seam). */
  readonly responder: MessagingTurnResponder;
  /** REQUIRED execution provenance ledger (the executions public seam). */
  readonly ledger: MessagingExecutionLedger;
  /**
   * The rail channel's neutral connection reference (the mediated
   * credential access target — a reference, never a value).
   */
  readonly railConnectionRef: string;
  readonly digest: (canonical: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export interface StartMessagingConversationOutcome {
  readonly conversationId: string;
  readonly executionId: string;
  readonly channelConversationRef: string;
  readonly orderingMode: string;
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  readonly replayed: boolean;
}

export interface MessagingIngestOutcome {
  readonly eventKey: string;
  /** The deterministic ordering outcome recorded for the inbound message. */
  readonly orderingMarker: string | null;
  /** The reply outcome (the governed outbound side effect). */
  readonly reply: {
    readonly messageKey: string;
    readonly responsePreview: string | null;
    readonly responseRef: string | null;
    readonly channelMessageRef: string | null;
    readonly deliveryStatus: string | null;
    readonly ledgerSequence: number;
  } | null;
  readonly routeClass: string | null;
  readonly replayed: boolean;
}

export interface MessagingDeliveryApplyOutcome {
  readonly conversationId: string;
  readonly messageKey: string;
  /** The message row's delivery projection after the application. */
  readonly deliveryStatus: string;
  /** True when the evidence row already existed (duplicate callback). */
  readonly replayed: boolean;
  readonly ledgerSequence: number;
}

export interface MessagingEscalationOutcome {
  readonly conversationId: string;
  readonly executionId: string;
  readonly escalationKey: string;
  readonly destination: string;
  readonly ledgerSequence: number;
  readonly replayed: boolean;
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
  if (messagingContainsRawSecretValue(cause)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "cause looks like it embeds a raw secret value",
    });
  }
  return cause;
}

export function createMessagingConversationService(deps: MessagingConversationServiceDeps) {
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
        message: `plan ${planId}@${planVersion} is not published; a messaging conversation cannot pin an unknown plan version`,
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
    readonly conversationId: string | null;
    readonly deploymentId: string;
    readonly executionId: string | null;
    readonly action: string;
    readonly code: string;
    readonly reason: string;
    readonly eventKey: string;
  }) => {
    if (context.executionId !== null && context.conversationId !== null) {
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
              conversationId: context.conversationId,
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
          `messaging:denial:${context.eventKey}`,
        )
        .catch(() => undefined);
    }
    if (context.conversationId !== null) {
      // The message-ledger marker row (bounded, append-only).
      await store
        .appendMessage({
          messageId: generateId(),
          applicationId: context.applicationId,
          tenantId: context.tenantId,
          conversationId: context.conversationId,
          deploymentId: context.deploymentId,
          kind: "system-marker",
          direction: "internal",
          eventKey: `denial:${context.eventKey}`,
          threadRef: null,
          threadSequence: null,
          orderingMarker: null,
          executionId: context.executionId,
          ledgerSequence: null,
          routeClass: null,
          replyToEventKey: null,
          channelMessageRef: null,
          deliveryStatus: null,
          cause: `${context.action} denied (${context.code}): ${context.reason.slice(0, 400)}`,
          payloadRef: null,
          payloadPreview: null,
          attachments: [],
          actorId: context.actorId,
          bodyDigest: digest(
            messagingMessageBodyDigestBase({
              conversationId: context.conversationId,
              kind: "system-marker",
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

  /** Resolve a conversation with the tenant guard. */
  const resolveConversation = async (actor: MessagingActor, conversationId: string) => {
    if (!isUuid(conversationId)) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "conversationId must be a UUID" });
    }
    const conversation = await store.findConversation(actor.applicationId, conversationId);
    if (conversation === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `messaging conversation ${conversationId} not found in this application`,
      });
    }
    if (conversation.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "messaging conversation belongs to another tenant",
      });
    }
    return conversation;
  };

  const appendMessage = async (input: {
    readonly conversation: MessagingConversationRecord;
    readonly kind: MessagingMessageKind;
    readonly direction: "inbound" | "outbound" | "internal";
    readonly eventKey: string;
    readonly threadRef: string | null;
    readonly threadSequence: number | null;
    readonly orderingMarker: MessagingOrderingMarker | null;
    readonly ledgerSequence: number | null;
    readonly routeClass: MessagingRouteClass | null;
    readonly replyToEventKey: string | null;
    readonly channelMessageRef: string | null;
    readonly deliveryStatus: MessagingDeliveryStatus | null;
    readonly cause: string | null;
    readonly payloadRef: string | null;
    readonly payloadPreview: string | null;
    readonly attachments: readonly string[];
    readonly actorId: string;
  }) => {
    return store.appendMessage({
      messageId: generateId(),
      applicationId: input.conversation.applicationId,
      tenantId: input.conversation.tenantId,
      conversationId: input.conversation.id,
      deploymentId: input.conversation.deploymentId,
      kind: input.kind,
      direction: input.direction,
      eventKey: input.eventKey,
      threadRef: input.threadRef,
      threadSequence: input.threadSequence,
      orderingMarker: input.orderingMarker,
      executionId: input.conversation.executionId,
      ledgerSequence: input.ledgerSequence,
      routeClass: input.routeClass,
      replyToEventKey: input.replyToEventKey,
      channelMessageRef: input.channelMessageRef,
      deliveryStatus: input.deliveryStatus,
      cause: input.cause,
      payloadRef: input.payloadRef,
      payloadPreview: input.payloadPreview,
      attachments: input.attachments.slice(0, 8),
      actorId: input.actorId,
      bodyDigest: digest(
        messagingMessageBodyDigestBase({
          conversationId: input.conversation.id,
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
    kind: MessagingOperationKind,
    discriminator: string,
    refs: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly conversationId: string | null;
      readonly deploymentId: string;
      readonly executionId: string | null;
    },
  ) =>
    store.beginMessagingOperation({
      operationId: generateId(),
      ...refs,
      operationKind: kind,
      operationKey: messagingOperationKey(kind, discriminator),
      createdAt: iso(),
    });

  /**
   * RACE-TOLERANT checkpoint write: a CONCURRENT invocation of the same
   * logical operation may complete (or durably fail) it between our
   * state check and this write — the winner owns the outcome, and our
   * durable tail converges through the stable keys (rail, executions
   * ledger, message ledger); a still-pending row means the write
   * genuinely failed and the error stands.
   */
  const checkpointOperation = async (
    applicationId: string,
    operationKey: string,
    checkpoint: MessagingOperationCheckpoint,
  ): Promise<MessagingOperationRecord | null> => {
    try {
      return await store.recordMessagingOperationCheckpoint(
        applicationId,
        operationKey,
        checkpoint,
        iso(),
      );
    } catch (error) {
      if (error instanceof PlatformError && error.code === "INVALID_STATE_TRANSITION") {
        const reread = await store.findMessagingOperation(applicationId, operationKey);
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
    /** Start (or idempotently replay) one messaging conversation on a deployment. */
    async startConversation(
      input: StartMessagingConversationInput,
      idempotencyKey: string,
      actor: MessagingActor,
    ): Promise<StartMessagingConversationOutcome> {
      requireKey(idempotencyKey);
      const check = validateStartMessagingConversationInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      const orderingMode = input.orderingMode ?? "unordered";
      // The durable conversation-start OPERATION key (the recovery
      // discriminator — the same retry derives the same key).
      const operationKey = messagingOperationKey("conversation-start", idempotencyKey);
      // Idempotent replay fast path (a retried start converges on the
      // SAME conversation + execution identity — never a second one),
      // WITH creation-fingerprint arbitration: the same key with a
      // DIFFERENT body is key reuse and fails closed.
      const replayed = await store.findConversationByStartKey(actor.applicationId, idempotencyKey);
      if (replayed !== null) {
        const expectedFingerprint = messagingConversationCreationFingerprint(
          actor.applicationId,
          input,
          replayed.executionId,
        );
        if (replayed.creationFingerprint !== expectedFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "messaging conversation idempotency key already exists with a different creation fingerprint",
            details: { conversationId: replayed.id },
          });
        }
        // CRASH RECOVERY: the conversation row exists but the start
        // operation may still be PENDING (a crash between the durable
        // insert and the operation completion lost the provenance tail)
        // — complete it instead of returning the gap.
        const op = await store.findMessagingOperation(actor.applicationId, operationKey);
        if (op !== null && op.status === "pending") {
          const startEvidence = await ledger.recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: replayed.executionId,
              evidenceClass: "conversation-started",
              // REPLAY-STABLE cause: identical for the original start
              // and the recovered provenance tail (the executions
              // idempotency arbitrates by key + fingerprint).
              cause: "messaging conversation started on the deployment fabric",
              reference: {
                conversationId: replayed.id,
                deploymentId: replayed.deploymentId,
                pinnedPlanId: replayed.pinnedPlanId,
                pinnedPlanVersion: replayed.pinnedPlanVersion,
                channelKind: replayed.channelKind,
                channelConversationRef: replayed.channelConversationRef,
                orderingMode: replayed.orderingMode,
              },
              payload: {
                participantRef: replayed.participantRef,
                railCapabilityId: rail.descriptor.railCapabilityId,
              },
            },
            `${idempotencyKey}:conversation-started`,
          );
          await store
            .appendMessage({
              messageId: generateId(),
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              conversationId: replayed.id,
              deploymentId: replayed.deploymentId,
              kind: "system-marker",
              direction: "internal",
              eventKey: `${idempotencyKey}:conversation-started`,
              threadRef: null,
              threadSequence: null,
              orderingMarker: null,
              executionId: replayed.executionId,
              ledgerSequence: startEvidence.sequence,
              routeClass: null,
              replyToEventKey: null,
              channelMessageRef: null,
              deliveryStatus: null,
              cause: null,
              payloadRef: input.initialPayloadRef ?? null,
              payloadPreview: null,
              attachments: [],
              actorId: actor.actorId,
              bodyDigest: digest(
                messagingMessageBodyDigestBase({
                  conversationId: replayed.id,
                  kind: "system-marker",
                  direction: "internal",
                  eventKey: `${idempotencyKey}:conversation-started`,
                  payloadRef: input.initialPayloadRef ?? null,
                  payloadPreview: null,
                }),
              ),
              createdAt: iso(),
            })
            .catch(() => undefined);
          await store.completeMessagingOperation(actor.applicationId, operationKey, iso());
        }
        return {
          conversationId: replayed.id,
          executionId: replayed.executionId,
          channelConversationRef: replayed.channelConversationRef,
          orderingMode: replayed.orderingMode,
          pinnedPlanId: replayed.pinnedPlanId,
          pinnedPlanVersion: replayed.pinnedPlanVersion,
          replayed: true,
        };
      }
      // 0. The durable operation claim — BEFORE the rail side effect (a
      // crash between the rail open and the durable conversation row
      // leaves this row PENDING; the retry resumes from its checkpoint).
      const conversationId = generateId();
      const begun = await beginOperation("conversation-start", idempotencyKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId,
        deploymentId: input.deploymentId,
        executionId: null,
      });
      let deployment: Awaited<ReturnType<typeof resolveDeployment>> | null = null;
      let plan: Awaited<ReturnType<typeof resolvePinnedPlan>>["plan"] | null = null;
      let execution: Awaited<ReturnType<typeof ledger.openExecution>> | null = null;
      let decisionEvidence: { readonly policySetId: string | null } | null = null;
      let railConversation: Awaited<ReturnType<typeof rail.openConversation>> | null = null;
      if (begun.status === "existing" && begun.record.status === "completed") {
        // A concurrent invocation completed this operation: its
        // conversation row MUST exist (completion follows the durable
        // insert).
        const converged = await store.findConversationByStartKey(
          actor.applicationId,
          idempotencyKey,
        );
        if (converged === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "messaging conversation start operation is completed but its conversation row is absent (invariant violation)",
          });
        }
        return {
          conversationId: converged.id,
          executionId: converged.executionId,
          channelConversationRef: converged.channelConversationRef,
          orderingMode: converged.orderingMode,
          pinnedPlanId: converged.pinnedPlanId,
          pinnedPlanVersion: converged.pinnedPlanVersion,
          replayed: true,
        };
      }
      if (
        begun.status === "existing" &&
        begun.record.status === "pending" &&
        begun.record.checkpoint?.stage === "conversation-opened"
      ) {
        // CRASH RECOVERY from the checkpoint: the rail opened/bound the
        // channel conversation under the STABLE key — resume the
        // durable tail (insert + provenance + completion) WITHOUT
        // re-running admission (the decision preceded the side effect)
        // and WITHOUT a second rail open (the rail converges by key
        // even if re-issued).
        const checkpoint = begun.record.checkpoint;
        execution = {
          executionId: checkpoint.executionId ?? "",
          replayed: true,
          status: "running",
        };
        railConversation = {
          channelConversationRef: checkpoint.channelConversationRef ?? "",
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
            message: `deployment ${deployment.slug} is ${deployment.status}; messaging conversations start only on active deployments`,
          });
        }
        // 2. Version PIN: the deployment's CURRENT plan version at start.
        const pinned = await resolvePinnedPlan(
          actor.applicationId,
          deployment.currentPlanId,
          deployment.currentPlanVersion,
        );
        plan = pinned.plan;
        // 3. POLICY — the conversation-start admission (BEFORE any side effect).
        const decision = await policy.admit({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: null,
          deploymentId: deployment.id,
          action: "conversation-start",
          channelKind: input.channelKind,
          railCapabilityId: rail.descriptor.railCapabilityId,
          routeClass: null,
          secretRef: railConnectionRef,
        });
        if (!decision.allowed) {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "messaging conversation start denied by admission policy",
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
              kind: "messaging-conversation",
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
        // 5. The rail conversation open (the upstream binding; neutral
        // refs) — under the STABLE rail-level idempotency key: a retry
        // or crash resume re-opens under the SAME key and the rail
        // converges on the SAME channel coordinates (exactly one
        // upstream conversation).
        railConversation = await rail.openConversation({
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          deploymentId: deployment.id,
          pinnedPlanId: plan.planId,
          pinnedPlanVersion: plan.version,
          executionId: execution.executionId,
          channelKind: input.channelKind,
          idempotencyKey: messagingRailOpenKey(idempotencyKey),
          channelConversationRef: input.channelConversationRef ?? null,
          orderingMode,
          participantRef: input.participantRef ?? null,
          sessionPolicy: plan.sessionPolicy,
        });
        // 6. CHECKPOINT the past-no-return facts (a crash from here on
        // resumes the durable tail WITHOUT re-admission and without a
        // second rail open; a concurrent winner's completion converges).
        await checkpointOperation(actor.applicationId, operationKey, {
          stage: "conversation-opened",
          conversationId,
          executionId: execution.executionId,
          deploymentId: deployment.id,
          pinnedPlanId: plan.planId,
          pinnedPlanVersion: plan.version,
          channelConversationRef: railConversation.channelConversationRef,
          orderingMode,
          participantRef: input.participantRef ?? null,
          policySetId: decisionEvidence.policySetId,
        });
      }
      // 7. The durable conversation row (idempotent convergence). The
      // conversation identity is the one pinned by the durable
      // operation row (a crash-resume converges on the SAME identity).
      const durableConversationId = begun.record.conversationId ?? conversationId;
      const fingerprint = messagingConversationCreationFingerprint(
        actor.applicationId,
        input,
        execution.executionId,
      );
      const insert = await store.insertConversation({
        conversationId: durableConversationId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        deploymentId: deployment.id,
        pinnedPlanId: plan.planId,
        pinnedPlanVersion: plan.version,
        executionId: execution.executionId,
        channelKind: input.channelKind,
        channelConversationRef: railConversation.channelConversationRef,
        orderingMode,
        participantRef: input.participantRef ?? null,
        creationFingerprint: fingerprint,
        createdBy: actor.actorId,
        idempotencyKey,
        createdAt: iso(),
      });
      const conversation = await store.findConversation(actor.applicationId, insert.conversationId);
      if (conversation === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "messaging conversation row disappeared after insert",
        });
      }
      // 8. Provenance: the conversation start rides the executions ledger.
      const startEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: execution.executionId,
          evidenceClass: "conversation-started",
          cause: "messaging conversation started on the deployment fabric",
          reference: {
            conversationId: conversation.id,
            deploymentId: deployment.id,
            pinnedPlanId: conversation.pinnedPlanId,
            pinnedPlanVersion: conversation.pinnedPlanVersion,
            channelKind: conversation.channelKind,
            channelConversationRef: conversation.channelConversationRef,
            orderingMode: conversation.orderingMode,
            policySet: decisionEvidence.policySetId,
          },
          payload: {
            participantRef: conversation.participantRef,
            railCapabilityId: rail.descriptor.railCapabilityId,
          },
        },
        `${idempotencyKey}:conversation-started`,
      );
      await appendMessage({
        conversation,
        kind: "system-marker",
        direction: "internal",
        eventKey: `${idempotencyKey}:conversation-started`,
        threadRef: null,
        threadSequence: null,
        orderingMarker: null,
        ledgerSequence: startEvidence.sequence,
        routeClass: null,
        replyToEventKey: null,
        channelMessageRef: null,
        deliveryStatus: null,
        cause: null,
        payloadRef: input.initialPayloadRef ?? null,
        payloadPreview: null,
        attachments: [],
        actorId: actor.actorId,
      });
      // 9. The durable operation completion (a crash before this leaves
      // the row PENDING; the retry completes the tail via the fast path).
      await store.completeMessagingOperation(actor.applicationId, operationKey, iso());
      return {
        conversationId: conversation.id,
        executionId: conversation.executionId,
        channelConversationRef: conversation.channelConversationRef,
        orderingMode: conversation.orderingMode,
        pinnedPlanId: conversation.pinnedPlanId,
        pinnedPlanVersion: conversation.pinnedPlanVersion,
        replayed: execution.replayed || insert.status === "converged" || railConversation.replayed,
      };
    },

    /** Ingest one inbound conversational event (user message). */
    async ingestInboundEvent(
      input: MessagingInboundEventInput,
      actor: MessagingActor,
    ): Promise<MessagingIngestOutcome> {
      const check = validateMessagingInboundEvent(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      // 1. Conversation resolution: tenant scope. The terminal guard
      // applies to NEW events below — a REPLAY of an already-claimed
      // event converges regardless of a later terminal move.
      const conversation = await resolveConversation(actor, input.conversationId);
      // 2. The idempotency discriminator: the upstream-supplied event id
      // or the deterministic substitute (conversation coordinates +
      // thread + occurrence ordinal).
      const priorMessages = await store.listMessages(actor.applicationId, conversation.id);
      const threadMessages = priorMessages.filter(
        (message) =>
          message.direction === "inbound" &&
          (message.threadRef ?? null) === (input.threadRef ?? null),
      );
      const eventKey =
        input.eventKey ??
        deterministicMessagingEventKey({
          conversationId: conversation.id,
          threadRef: input.threadRef ?? null,
          occurrenceOrdinal: input.occurrenceOrdinal ?? threadMessages.length + 1,
        });
      const priorInbound = priorMessages.find(
        (message) => message.direction === "inbound" && message.eventKey === eventKey,
      );
      // 2b. The CONVERSATION-SCOPED event discriminator: event keys are
      // unique per (application, CONVERSATION) — two concurrent calls
      // may legitimately reuse an upstream event id — so EVERY
      // application-scoped key derived from an inbound event (the
      // turn-reply operation key, the stable rail send key, the
      // responder turn key, the budget operation id and the
      // executions-ledger evidence keys) is scoped by the conversation
      // identity: a same-key message on ANOTHER conversation is a
      // DIFFERENT logical operation, never a collision.
      const scopedKey = `${conversation.id}:${eventKey}`;
      if (priorInbound === undefined) {
        // A NEW event: apply the terminal guard BEFORE the claim.
        if (isTerminalMessagingConversationStatus(conversation.status)) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: `messaging conversation ${conversation.id} is terminal (${conversation.status}); inbound events are rejected`,
          });
        }
      }
      // 3. The ORDERING resolution (the channel contract's declared
      // semantics — ordering EVIDENCE, never a dispatch decision; a
      // duplicate replays the committed row's marker).
      const threadSequenceInput = input.threadSequence ?? null;
      const priorThreadSequence = priorInbound?.threadSequence ?? null;
      const ordering =
        priorInbound !== undefined && priorThreadSequence !== null
          ? {
              threadSequence: priorThreadSequence,
              marker: priorInbound.orderingMarker,
            }
          : resolveMessagingOrdering({
              orderingMode: conversation.orderingMode,
              threadRef: input.threadRef ?? null,
              threadSequence: threadSequenceInput,
              maxThreadSequence: threadMessages.reduce(
                (max, message) => Math.max(max, message.threadSequence ?? 0),
                0,
              ),
              threadMessageCount: threadMessages.length,
            });
      // 4. The INBOUND CLAIM (the idempotency ledger): a duplicate
      // converges on the committed row — no second side effect, ever.
      // The BODY-DIGEST ARBITRATION still runs: a same-key/different-
      // body replay fails closed (the poisoned-replay discipline).
      if (priorInbound !== undefined) {
        const replayDigest = digest(
          messagingMessageBodyDigestBase({
            conversationId: conversation.id,
            kind: "user-message",
            direction: "inbound",
            eventKey,
            payloadRef: input.payloadRef ?? null,
            payloadPreview: input.payloadPreview ?? null,
          }),
        );
        if (priorInbound.bodyDigest !== replayDigest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "messaging event key already exists with a different body",
            details: { eventKey },
          });
        }
      }
      const claim =
        priorInbound !== undefined
          ? ({ status: "converged", message: priorInbound } as const)
          : await appendMessage({
              conversation,
              kind: "user-message",
              direction: "inbound",
              eventKey,
              threadRef: input.threadRef ?? null,
              threadSequence: ordering.threadSequence,
              orderingMarker: ordering.marker,
              ledgerSequence: null,
              routeClass: null,
              replyToEventKey: null,
              channelMessageRef: input.channelMessageRef ?? null,
              deliveryStatus: null,
              cause: null,
              payloadRef: input.payloadRef ?? null,
              payloadPreview: input.payloadPreview ?? null,
              attachments: input.attachments ?? [],
              actorId: actor.actorId,
            });
      // 4b. THE DURABLE OPERATION STATE check — the crash-safety
      // discriminator (the WORK-024 standard): a converged claim alone
      // proves NOTHING about the side effect. A COMPLETED operation
      // replays its recorded outcome; a FAILED operation replays its
      // recorded failure; a PENDING or ABSENT operation row means the
      // claim was committed but the durable outcome was not — the
      // pipeline RESUMES below (the rail converges by the stable key:
      // exactly one send, ever).
      const replyMessageKey = `${eventKey}:reply`;
      const turnOperationKey = messagingOperationKey("turn-reply", scopedKey);
      if (claim.status === "converged") {
        const operation = await store.findMessagingOperation(actor.applicationId, turnOperationKey);
        if (operation !== null && operation.status === "failed") {
          // The durably recorded rail refusal: a retry under the same
          // key replays the recorded failure (no duplicate side effect).
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "the messaging rail refused the reply send (recorded failure)",
            details: {
              conversationId: conversation.id,
              reason: operation.failureReason ?? undefined,
            },
          });
        }
        if (operation !== null && operation.status === "completed") {
          // Fully completed: the winner's processing is the truth. The
          // reply row (outbound) carries the ledger linkage; replays
          // return it.
          const reply = priorMessages.find(
            (message) => message.direction === "outbound" && message.eventKey === replyMessageKey,
          );
          return {
            eventKey,
            orderingMarker: claim.message.orderingMarker,
            reply:
              reply === undefined
                ? null
                : {
                    messageKey: reply.eventKey,
                    responsePreview: reply.payloadPreview,
                    responseRef: reply.payloadRef,
                    channelMessageRef: reply.channelMessageRef,
                    deliveryStatus: reply.deliveryStatus,
                    ledgerSequence: reply.ledgerSequence ?? claim.message.eventSeq,
                  },
            routeClass: reply?.routeClass ?? null,
            replayed: true,
          };
        }
        // PENDING or ABSENT: fall through and RESUME the reply pipeline.
      }

      // 5. The durable turn-reply OPERATION (claim or crash-RESUME —
      // the WORK-024 standard): claimed before the responder and the
      // rail send; completed after every durable outcome. A crash in
      // between leaves it PENDING and this invocation RESUMES.
      const begunTurn = await beginOperation("turn-reply", scopedKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId: conversation.id,
        deploymentId: conversation.deploymentId,
        executionId: conversation.executionId,
      });
      const respondedCheckpoint =
        begunTurn.status === "existing" &&
        begunTurn.record.status === "pending" &&
        begunTurn.record.checkpoint?.stage === "responded"
          ? begunTurn.record.checkpoint
          : null;
      let route: MessagingTurnRoute;
      let response: Awaited<ReturnType<typeof responder.respond>>;
      let reservationId: string | null = null;
      let reservedAmountMicroUsd: string | null = null;
      let policySetId: string | null = null;
      let recoveredSend = false;
      if (respondedCheckpoint !== null) {
        // CRASH RECOVERY from the responded checkpoint: the admitted
        // responder ALREADY produced the reply frame — the send resumes
        // with THESE facts. The paid-inference seam is NOT re-invoked;
        // admission is NOT re-run (the decisions preceded the side
        // effect); the rail send converges by the stable key (exactly
        // one send, ever).
        recoveredSend = true;
        reservationId = respondedCheckpoint.reservationId ?? null;
        response = {
          responseRef: respondedCheckpoint.responseRef ?? null,
          responsePreview: respondedCheckpoint.responsePreview ?? "",
          responseAttachments: respondedCheckpoint.responseAttachments ?? [],
          actualCostMicroUsd: respondedCheckpoint.actualCostMicroUsd ?? "0",
        };
        route = {
          routeClass: respondedCheckpoint.routeClass ?? "generative",
          decisionOutcome: respondedCheckpoint.plannerOutcome ?? "uncertain",
          reasonCodes: respondedCheckpoint.reasonCodes ?? [],
          rationale: respondedCheckpoint.deliveryCause ?? "crash-recovered reply",
          estimatedCostMicroUsd: null,
        };
        policySetId = respondedCheckpoint.policySetId ?? null;
      } else {
        // 5a. The planner route (the existing planner decision
        // establishes whether generative inference is needed).
        const { profile } = await resolvePinnedPlan(
          actor.applicationId,
          conversation.pinnedPlanId,
          conversation.pinnedPlanVersion,
        );
        route = await router.routeTurn({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          deploymentId: conversation.deploymentId,
          pinnedPlanId: conversation.pinnedPlanId,
          pinnedPlanVersion: conversation.pinnedPlanVersion,
          channelKind: conversation.channelKind,
          subtaskKind: input.subtaskKind ?? "mixed",
          requiredCapabilities: profile.requiredCapabilities,
          turnPreview: input.payloadPreview ?? null,
          turnPayloadRef: input.payloadRef ?? null,
        });

        // 6. ADMISSION CHAIN — before EVERY governed side effect.
        // 6a. POLICY (reply send).
        const policyDecision = await policy.admit({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          deploymentId: conversation.deploymentId,
          action: "message-send",
          channelKind: conversation.channelKind,
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
            conversationId: conversation.id,
            deploymentId: conversation.deploymentId,
            executionId: conversation.executionId,
            action: "message-send",
            code: "POLICY_DENIED",
            reason: policyDecision.reason,
            eventKey: scopedKey,
          });
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "messaging reply send denied by admission policy",
            details: { conversationId: conversation.id, eventKey, reason: policyDecision.reason },
          });
        }
        // 6b. CAPABILITY (the pinned plan's declaration + the rail).
        const capabilityDecision = await capabilities.resolve({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          requiredCapabilities: profile.requiredCapabilities,
          railCapabilityId: rail.descriptor.railCapabilityId,
        });
        if (!capabilityDecision.satisfied) {
          await recordDenial({
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            conversationId: conversation.id,
            deploymentId: conversation.deploymentId,
            executionId: conversation.executionId,
            action: "message-send",
            code: "CAPABILITY_UNAVAILABLE",
            reason: `unmet capabilities: ${capabilityDecision.unmet.join(", ")}`,
            eventKey: scopedKey,
          });
          throw new PlatformError({
            code: "CAPABILITY_UNAVAILABLE",
            message: "messaging reply send cannot proceed: required capabilities are unmet",
            details: { conversationId: conversation.id, unmet: capabilityDecision.unmet },
          });
        }
        // 6c. BUDGET — paid routes only (deterministic routes never
        // reserve: no generative inference, no paid dispatch).
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
              executionId: conversation.executionId,
              operationId: `messaging-turn:${scopedKey}`,
              amountMicroUsd: route.estimatedCostMicroUsd,
              reason: `messaging turn ${scopedKey} on deployment ${conversation.deploymentId} (route ${route.routeClass})`,
            });
            reservationId = reservation.reservationId;
            reservedAmountMicroUsd = reservation.amountMicroUsd;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await recordDenial({
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              conversationId: conversation.id,
              deploymentId: conversation.deploymentId,
              executionId: conversation.executionId,
              action: "message-send",
              code: "BUDGET_EXCEEDED",
              reason,
              eventKey: scopedKey,
            });
            throw error;
          }
        }
        // 6d. SECRET — mediated rail-channel credential access
        // (references only; before the rail send).
        const mediation = await secrets.mediate({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          connectionRef: railConnectionRef,
        });
        if (!mediation.mediated) {
          await recordDenial({
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            conversationId: conversation.id,
            deploymentId: conversation.deploymentId,
            executionId: conversation.executionId,
            action: "message-send",
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
                operationId: `messaging-turn:${scopedKey}`,
              })
              .catch(() => undefined);
          }
          throw new PlatformError({
            code: "AUTHORIZATION_DENIED",
            message: "mediated rail-channel credential access was refused",
            details: { conversationId: conversation.id, reason: mediation.reason },
          });
        }

        // 7. The responder (the deployed agent's reply seam —
        // deterministic content or admitted paid inference). The request
        // carries the turn's STABLE key so a production responder can
        // converge paid inference across crashes/retries.
        response = await responder.respond({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          deploymentId: conversation.deploymentId,
          pinnedPlanId: conversation.pinnedPlanId,
          pinnedPlanVersion: conversation.pinnedPlanVersion,
          channelKind: conversation.channelKind,
          threadRef: input.threadRef ?? null,
          turnKey: scopedKey,
          routeClass: route.routeClass,
          turnPreview: input.payloadPreview ?? null,
          turnPayloadRef: input.payloadRef ?? null,
          turnAttachments: input.attachments ?? [],
          reservationId,
          channelGrantRef: mediation.grantRef,
        });
        // 7b. CHECKPOINT the responded facts BEFORE the rail send —
        // the point of no return for the paid-inference seam: a crash
        // from here on resumes the SEND with these facts and never
        // re-invokes admission or the responder (a concurrent winner's
        // completion converges).
        await checkpointOperation(actor.applicationId, turnOperationKey, {
          stage: "responded",
          routeClass: route.routeClass,
          plannerOutcome: route.decisionOutcome,
          reasonCodes: route.reasonCodes.slice(0, 8).map((code) => code.slice(0, 64)),
          responseRef: response.responseRef,
          responsePreview: response.responsePreview.slice(0, 512),
          responseAttachments: response.responseAttachments.slice(0, 8),
          reservationId,
          actualCostMicroUsd: MICRO_USD_PATTERN.test(response.actualCostMicroUsd)
            ? response.actualCostMicroUsd
            : "0",
          deliveryCause: route.rationale.slice(0, 400),
          policySetId,
        });
      } // end of the full reply pipeline (the non-resumed path)

      // 8. THE RAIL SEND (the governed external side effect) — under
      // the STABLE rail-level idempotency key: a retry or crash-resume
      // re-sends under the SAME key and the rail converges (exactly one
      // upstream send, ever).
      const send = await rail.sendMessage({
        applicationId: actor.applicationId,
        conversationId: conversation.id,
        channelConversationRef: conversation.channelConversationRef,
        channelKind: conversation.channelKind,
        routeClass: route.routeClass,
        threadRef: input.threadRef ?? null,
        messageKey: replyMessageKey,
        idempotencyKey: messagingRailSendKey(scopedKey),
        replyToEventKey: eventKey,
        payloadRef: response.responseRef,
        payloadPreview: response.responsePreview.slice(0, 512),
        attachments: response.responseAttachments.slice(0, 8),
        cause: route.rationale.slice(0, 400),
      });
      if (!send.sent) {
        // Failure provenance: the reply failed on the rail (normalized,
        // rail detail retained as evidence — never domain control
        // flow). The reply row is appended with the recorded failure
        // status so a replay reads the recorded outcome.
        const failure = await ledger.recordEvidence(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: conversation.executionId,
            evidenceClass: "failure",
            cause: "messaging reply send failed on the upstream rail",
            reference: {
              conversationId: conversation.id,
              eventKey,
              replyMessageKey,
              channelConversationRef: conversation.channelConversationRef,
            },
            payload: { reason: send.reason, routeClass: route.routeClass },
          },
          `messaging:failure:${scopedKey}`,
        );
        await appendMessage({
          conversation,
          kind: "agent-reply",
          direction: "outbound",
          eventKey: replyMessageKey,
          threadRef: input.threadRef ?? null,
          threadSequence: null,
          orderingMarker: null,
          ledgerSequence: failure.sequence,
          routeClass: route.routeClass,
          replyToEventKey: eventKey,
          channelMessageRef: null,
          deliveryStatus: "undelivered",
          cause: `rail send failed: ${send.reason.slice(0, 400)}`,
          payloadRef: response.responseRef,
          payloadPreview: response.responsePreview.slice(0, 512),
          attachments: response.responseAttachments.slice(0, 8),
          actorId: actor.actorId,
        });
        if (reservationId !== null) {
          await budget
            .release({
              actorId: actor.actorId,
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              operationId: `messaging-turn:${scopedKey}`,
            })
            .catch(() => undefined);
        }
        // The operation's terminal FAILURE outcome: durably recorded on
        // both ledgers — a later retry under the same key REPLAYS this
        // recorded failure (no duplicate side effect, no reply loss).
        await store
          .failMessagingOperation(
            actor.applicationId,
            turnOperationKey,
            `rail send refused: ${send.reason.slice(0, 400)}`,
            iso(),
          )
          .catch(() => undefined);
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the messaging rail refused the reply send",
          details: { conversationId: conversation.id, reason: send.reason },
        });
      }

      // 9. Budget settle (actual usage; unused remainder releases).
      if (reservationId !== null) {
        await budget
          .settle({
            actorId: actor.actorId,
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            operationId: `messaging-turn:${scopedKey}`,
            actualAmountMicroUsd: MICRO_USD_PATTERN.test(response.actualCostMicroUsd)
              ? response.actualCostMicroUsd
              : (reservedAmountMicroUsd ?? "0"),
          })
          .catch(() => undefined);
      }

      // 10. Turn provenance (the executions ledger — the canonical
      // path: the full chain inbound message → execution → reply).
      const turnEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: conversation.executionId,
          evidenceClass: "message",
          // REPLAY-STABLE evidence: the cause/reference/payload are
          // IDENTICAL for the original invocation and any crash-resume
          // or concurrent duplicate (the executions idempotency
          // arbitrates by key + fingerprint — an unstable marker would
          // fail a legitimate recovery closed). Recovery observability
          // rides the ledger-row CAUSES instead (never digested).
          cause: `messaging reply sent (${route.routeClass})`,
          reference: {
            conversationId: conversation.id,
            eventKey,
            replyMessageKey,
            threadRef: input.threadRef ?? null,
            pinnedPlanId: conversation.pinnedPlanId,
            pinnedPlanVersion: conversation.pinnedPlanVersion,
            channelConversationRef: conversation.channelConversationRef,
            responseRef: response.responseRef,
            reservationId,
            policySet: policySetId,
          },
          payload: {
            routeClass: route.routeClass,
            plannerOutcome: route.decisionOutcome,
            reasonCodes: route.reasonCodes,
            responsePreview: response.responsePreview.slice(0, 512),
            responseAttachments: response.responseAttachments.slice(0, 8),
            inboundPreview: input.payloadPreview ?? null,
            inboundAttachments: (input.attachments ?? []).slice(0, 8),
            channelMessageRef: send.channelMessageRef,
            sentAt: send.sentAt,
          },
        },
        `messaging:message:${scopedKey}`,
      );
      await appendMessage({
        conversation,
        kind: "agent-reply",
        direction: "outbound",
        eventKey: replyMessageKey,
        threadRef: input.threadRef ?? null,
        threadSequence: null,
        orderingMarker: null,
        ledgerSequence: turnEvidence.sequence,
        routeClass: route.routeClass,
        replyToEventKey: eventKey,
        channelMessageRef: send.channelMessageRef,
        deliveryStatus: "sent",
        // Recovery observability rides the message-row cause (never
        // fingerprint-arbitrated, never in the body digest).
        cause: recoveredSend ? "crash-recovered reply send" : null,
        payloadRef: response.responseRef,
        payloadPreview: response.responsePreview.slice(0, 512),
        attachments: response.responseAttachments.slice(0, 8),
        actorId: actor.actorId,
      });
      // 11. The durable operation COMPLETION — after every durable
      // outcome (a crash before this leaves the row PENDING and the
      // retry completes the reply from the checkpoint: exactly one
      // send, no reply loss).
      await store.completeMessagingOperation(actor.applicationId, turnOperationKey, iso());
      return {
        eventKey,
        orderingMarker: claim.message.orderingMarker,
        reply: {
          messageKey: replyMessageKey,
          responsePreview: response.responsePreview,
          responseRef: response.responseRef,
          channelMessageRef: send.channelMessageRef,
          deliveryStatus: "sent",
          ledgerSequence: turnEvidence.sequence,
        },
        routeClass: route.routeClass,
        replayed: claim.status === "converged" && turnEvidence.replayed,
      };
    },

    /**
     * Apply one delivery-status callback to its originating outbound
     * reply — CORRELATION-GUARDED (the message resolves by its Zeck
     * send key inside THIS conversation; a mismatched rail message
     * reference fails closed) and IDEMPOTENT (the callback key converges
     * on the physical UNIQUE; the projection moves only FORWARD through
     * the frozen delivery vocabulary). Delivery state is EVIDENCE
     * referencing the execution — never a second execution state
     * machine.
     */
    async applyDeliveryStatus(
      input: MessagingDeliveryCallbackInput,
      actor: MessagingActor,
    ): Promise<MessagingDeliveryApplyOutcome> {
      const check = validateMessagingDeliveryCallback(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      // 1. Conversation resolution: tenant scope (a callback never
      // mutates another tenant's conversation — the resolution fails
      // closed first).
      const conversation = await resolveConversation(actor, input.conversationId);
      // 2. Message correlation: the OUTBOUND reply resolves by its
      // Zeck send key inside THIS conversation. A callback naming a
      // message that is not an agent-reply of this conversation is
      // unrepresentable as a mutation (typed failure, zero effects).
      const message = await store.findMessage(
        actor.applicationId,
        conversation.id,
        input.messageKey,
      );
      if (message === null || message.kind !== "agent-reply" || message.direction !== "outbound") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no outbound reply message under this send key in this conversation (delivery callbacks correlate to the originating reply only)",
          details: { conversationId: conversation.id, messageKey: input.messageKey },
        });
      }
      // 3. The correlation guard: a callback carrying a rail message
      // reference that does not match the RECORDED reference of the
      // originating send cannot mutate the wrong message — fail closed
      // (typed), zero durable effects.
      if (
        input.channelMessageRef !== undefined &&
        message.channelMessageRef !== input.channelMessageRef
      ) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `delivery callback correlation rejected: the callback reports rail message ${input.channelMessageRef} but the reply under key ${input.messageKey} was sent as ${message.channelMessageRef ?? "(unrecorded)"}`,
          details: { conversationId: conversation.id, messageKey: input.messageKey },
        });
      }
      // 4. The callback dedupe key: the upstream-supplied callback id
      // or the deterministic substitute (conversation + send key +
      // status).
      const callbackKey =
        input.callbackKey ??
        deterministicMessagingCallbackKey({
          conversationId: conversation.id,
          messageKey: input.messageKey,
          status: input.status,
        });
      // CONVERSATION-SCOPED discriminator (the event-key discipline):
      // callback ids are unique per (application, CONVERSATION).
      const scopedCallbackKey = `${conversation.id}:${callbackKey}`;
      const operationKey = messagingOperationKey("delivery-apply", scopedCallbackKey);
      // 5. The durable operation state check — a COMPLETED operation
      // replays its recorded outcome (no second evidence row, no
      // projection move).
      const existingOperation = await store.findMessagingOperation(
        actor.applicationId,
        operationKey,
      );
      if (existingOperation !== null && existingOperation.status === "failed") {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the delivery-status application failed (recorded failure)",
          details: {
            conversationId: conversation.id,
            reason: existingOperation.failureReason ?? undefined,
          },
        });
      }
      if (existingOperation !== null && existingOperation.status === "completed") {
        const deliveries = await store.listDeliveries(actor.applicationId, conversation.id);
        const recorded = deliveries.find((delivery) => delivery.callbackKey === callbackKey);
        return {
          conversationId: conversation.id,
          messageKey: input.messageKey,
          deliveryStatus: message.deliveryStatus ?? "pending",
          replayed: true,
          ledgerSequence: recorded?.ledgerSequence ?? 0,
        };
      }
      // 6. The durable operation claim — BEFORE the evidence append and
      // the projection move (a crash in between leaves this row PENDING;
      // the retry resumes: the evidence row converges on the callback
      // key, the projection move is monotonic-guarded).
      await beginOperation("delivery-apply", scopedCallbackKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId: conversation.id,
        deploymentId: conversation.deploymentId,
        executionId: conversation.executionId,
      });
      const fromStatus = message.deliveryStatus ?? "pending";
      // 7. The delivery EVIDENCE row (append-only; the deliveries
      // ledger converges on the physical UNIQUE (application,
      // conversation, callback_key) — a duplicate callback converges; a
      // same-key/different-status replay fails closed in the store).
      const evidence = await store.appendDelivery({
        deliveryId: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId: conversation.id,
        deploymentId: conversation.deploymentId,
        messageId: message.id,
        executionId: conversation.executionId,
        callbackKey,
        channelMessageRef: message.channelMessageRef ?? "",
        fromStatus,
        toStatus: input.status,
        detail: input.detail ?? null,
        ledgerSequence: null,
        actorId: actor.actorId,
        createdAt: iso(),
      });
      // 8. The guarded monotonic PROJECTION on the message row: the
      // delivery vocabulary moves only forward (pending → sent →
      // delivered|undelivered; terminal immutable). A stale callback
      // records its evidence but cannot regress the projection.
      const projection = await store.applyGuardedDeliveryStatusUpdate({
        applicationId: actor.applicationId,
        conversationId: conversation.id,
        messageId: message.id,
        expectedChannelMessageRef: message.channelMessageRef,
        toStatus: input.status,
        deliveredAt: isTerminalMessagingDeliveryStatus(input.status) ? iso() : null,
      });
      // 9. Delivery provenance (the executions ledger — evidence
      // referencing the execution; never a second state machine).
      const deliveryEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: conversation.executionId,
          evidenceClass: "delivery",
          // REPLAY-STABLE evidence (the marker discipline above).
          cause: `messaging delivery status ${input.status}`,
          reference: {
            conversationId: conversation.id,
            eventKey: message.eventKey,
            replyMessageKey: message.eventKey,
            callbackKey,
            channelMessageRef: message.channelMessageRef,
            replyToEventKey: message.replyToEventKey,
          },
          payload: {
            fromStatus,
            toStatus: input.status,
            detail: input.detail ?? null,
            projectionStatus: projection.message.deliveryStatus,
          },
        },
        `messaging:delivery:${scopedCallbackKey}`,
      );
      // 10. The durable operation COMPLETION — after every durable
      // outcome (a crash before this leaves the row PENDING; the retry
      // converges through the callback key and the monotonic guard).
      await store.completeMessagingOperation(actor.applicationId, operationKey, iso());
      return {
        conversationId: conversation.id,
        messageKey: input.messageKey,
        deliveryStatus: projection.message.deliveryStatus ?? "pending",
        replayed: evidence.status === "converged" || projection.status === "converged",
        ledgerSequence: deliveryEvidence.sequence,
      };
    },

    /**
     * Policy-designated, auditable human escalation: the escalation is
     * a GOVERNED Execution step (the executions public wait-human
     * transition) plus a durable escalation record plus the rail
     * escalation notice — never an ad-hoc flag and never a bypass.
     */
    async escalateToHuman(
      input: {
        readonly conversationId: string;
        readonly destination?: string;
        readonly cause?: string;
      },
      idempotencyKey: string,
      actor: MessagingActor,
    ): Promise<MessagingEscalationOutcome> {
      requireKey(idempotencyKey);
      const cause = requireCause(input.cause);
      const destination = input.destination ?? "human-operator";
      if (destination.length < 1 || destination.length > 200) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "destination must be 1..200 characters",
        });
      }
      if (messagingContainsRawSecretValue(destination)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "destination looks like it embeds a raw secret value",
        });
      }
      const conversation = await resolveConversation(actor, input.conversationId);
      // The durable human-escalation OPERATION key (the recovery
      // discriminator — the same retry derives the same key).
      const operationKey = messagingOperationKey("human-escalation", idempotencyKey);
      // Idempotent replay: a committed escalation record under this key
      // replays its outcome (a PENDING operation row is the crash
      // window between the rail notice and the record — reconcile it:
      // the record's existence is the durable proof when complete, the
      // pending checkpoint resumes otherwise).
      const existingRecord = await store.findEscalation(actor.applicationId, idempotencyKey);
      if (existingRecord !== null) {
        const operation = await store.findMessagingOperation(actor.applicationId, operationKey);
        if (operation !== null && operation.status === "pending") {
          await store
            .completeMessagingOperation(actor.applicationId, operationKey, iso())
            .catch(() => undefined);
        }
        return {
          conversationId: conversation.id,
          executionId: conversation.executionId,
          escalationKey: idempotencyKey,
          destination: existingRecord.destination,
          ledgerSequence: existingRecord.waitSequence,
          replayed: true,
        };
      }
      if (isTerminalMessagingConversationStatus(conversation.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `messaging conversation ${conversation.id} is terminal (${conversation.status}); escalation requires a non-terminal conversation`,
        });
      }
      // The durable operation claim — BEFORE the rail side effect (a
      // crash between the rail escalation and the durable record leaves
      // this row PENDING; the retry resumes with the STABLE rail key
      // instead of escalating twice).
      const begun = await beginOperation("human-escalation", idempotencyKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId: conversation.id,
        deploymentId: conversation.deploymentId,
        executionId: conversation.executionId,
      });
      let policySetId: string | null = null;
      let recoveredEscalation = false;
      let notifiedAt: string | null = null;
      if (begun.status === "existing" && begun.record.status === "completed") {
        // A concurrent invocation completed this operation: the
        // escalation record MUST exist (completion follows the record).
        const reread = await store.findEscalation(actor.applicationId, idempotencyKey);
        if (reread === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "messaging escalation operation is completed but its record is absent (invariant violation)",
          });
        }
        return {
          conversationId: conversation.id,
          executionId: conversation.executionId,
          escalationKey: idempotencyKey,
          destination: reread.destination,
          ledgerSequence: reread.waitSequence,
          replayed: true,
        };
      }
      if (begun.status === "existing" && begun.record.status === "failed") {
        // The durably recorded rail refusal: a retry under the same key
        // replays the recorded failure (no duplicate side effect).
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the messaging rail refused the escalation notice (recorded failure)",
          details: {
            conversationId: conversation.id,
            reason: begun.record.failureReason ?? undefined,
          },
        });
      }
      const railIssued =
        begun.status === "existing" &&
        begun.record.status === "pending" &&
        begun.record.checkpoint?.stage === "rail-issued";
      if (railIssued) {
        // CRASH RECOVERY: the rail escalation was already issued under
        // the STABLE key — skip re-admission (the decision preceded the
        // side effect) and complete the durable tail.
        recoveredEscalation = true;
        policySetId = begun.record.checkpoint?.policySetId ?? null;
        notifiedAt = begun.record.checkpoint?.deliveredAt ?? null;
      } else {
        // POLICY-DESIGNATED escalation: the policy admission decides
        // BEFORE any side effect (no execution wait, no rail notice).
        const decision = await policy.admit({
          tenantId: actor.tenantId,
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          deploymentId: conversation.deploymentId,
          action: "human-escalation",
          channelKind: conversation.channelKind,
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
            conversationId: conversation.id,
            deploymentId: conversation.deploymentId,
            executionId: conversation.executionId,
            action: "human-escalation",
            code: "POLICY_DENIED",
            reason: decision.reason,
            eventKey: `${idempotencyKey}:escalation`,
          });
          throw new PlatformError({
            code: "POLICY_DENIED",
            message:
              "human escalation denied by admission policy (escalation is policy-designated)",
            details: { conversationId: conversation.id, reason: decision.reason },
          });
        }
      } // end of the policy stage (skipped on crash recovery)
      // The auditable execution wait — the GOVERNED escalation step
      // (the public transition surface; the idempotent command
      // converges on recovery).
      const wait = await ledger.awaitHuman(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: conversation.executionId,
          reason: `messaging conversation escalated to ${destination}${cause === null ? "" : `: ${cause}`}`,
        },
        `${idempotencyKey}:wait-human`,
      );
      if (!railIssued) {
        // The rail escalation notice (the external side effect) — under
        // the STABLE rail-level idempotency key: a retry or
        // crash-resume re-issues under the SAME key and the rail
        // converges (exactly one upstream notice, ever).
        const notice = await rail.escalate({
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          channelConversationRef: conversation.channelConversationRef,
          channelKind: conversation.channelKind,
          idempotencyKey: messagingRailEscalateKey(idempotencyKey),
          destination,
          cause,
          escalationKey: idempotencyKey,
        });
        if (!notice.sent) {
          // Failure provenance: the escalation failed on the rail AFTER
          // the governed wait — durably recorded on both ledgers, then
          // the typed failure (no escalation record, no completion).
          const escalationFailure = await ledger.recordEvidence(
            {
              applicationId: actor.applicationId,
              tenantId: actor.tenantId,
              actorId: actor.actorId,
              executionId: conversation.executionId,
              evidenceClass: "failure",
              cause: "messaging human escalation failed on the upstream rail",
              reference: {
                conversationId: conversation.id,
                eventKey: `${idempotencyKey}:escalation`,
                channelConversationRef: conversation.channelConversationRef,
                waitSequence: wait.sequence,
              },
              payload: { destination, reason: notice.reason },
            },
            `messaging:escalation-failure:${idempotencyKey}`,
          );
          await appendMessage({
            conversation,
            kind: "system-marker",
            direction: "internal",
            eventKey: `${idempotencyKey}:escalation-failure`,
            threadRef: null,
            threadSequence: null,
            orderingMarker: null,
            ledgerSequence: escalationFailure.sequence,
            routeClass: null,
            replyToEventKey: null,
            channelMessageRef: null,
            deliveryStatus: null,
            cause: `rail escalation failed: ${notice.reason.slice(0, 400)}`,
            payloadRef: null,
            payloadPreview: null,
            attachments: [],
            actorId: actor.actorId,
          });
          // The operation's terminal FAILURE outcome: durably recorded
          // on both ledgers — a later retry under the same key REPLAYS
          // this recorded failure (no duplicate side effect).
          await store
            .failMessagingOperation(
              actor.applicationId,
              operationKey,
              `rail escalation refused: ${notice.reason.slice(0, 400)}`,
              iso(),
            )
            .catch(() => undefined);
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "the messaging rail refused the escalation notice",
            details: { conversationId: conversation.id, reason: notice.reason },
          });
        }
        // CHECKPOINT the point-of-no-return (the rail notice was
        // issued; the durable tail completes from here on recovery; a
        // concurrent winner's completion converges).
        notifiedAt = notice.sentAt;
        await checkpointOperation(actor.applicationId, operationKey, {
          stage: "rail-issued",
          deliveredAt: notice.sentAt,
          policySetId,
        });
      } // end of the rail-escalation stage (skipped on crash recovery)
      // The durable escalation record (idempotent by escalation key).
      const record = await store.insertEscalation({
        escalationId: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId: conversation.id,
        deploymentId: conversation.deploymentId,
        executionId: conversation.executionId,
        escalationKey: idempotencyKey,
        destination,
        cause,
        waitSequence: wait.sequence,
        notifiedAt,
        createdAt: iso(),
      });
      // Escalation provenance (the canonical ledger).
      const escalationEvidence = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: conversation.executionId,
          evidenceClass: "escalation",
          // REPLAY-STABLE evidence (the marker discipline above): the
          // recovery marker rides the message-row cause, never this
          // fingerprint-arbitrated record.
          cause: `messaging conversation escalated to ${destination}`,
          reference: {
            conversationId: conversation.id,
            eventKey: `${idempotencyKey}:escalation`,
            channelConversationRef: conversation.channelConversationRef,
            policySet: policySetId,
            waitSequence: wait.sequence,
            escalationKey: idempotencyKey,
          },
          payload: {
            destination,
            cause,
            notifiedAt: notifiedAt ?? undefined,
          },
        },
        `messaging:escalation:${idempotencyKey}`,
      );
      await appendMessage({
        conversation,
        kind: "system-marker",
        direction: "internal",
        eventKey: `${idempotencyKey}:escalation`,
        threadRef: null,
        threadSequence: null,
        orderingMarker: null,
        ledgerSequence: escalationEvidence.sequence,
        routeClass: null,
        replyToEventKey: null,
        channelMessageRef: null,
        deliveryStatus: null,
        // Recovery observability rides the message-row cause (never
        // fingerprint-arbitrated, never in the body digest).
        cause: recoveredEscalation
          ? `${cause ?? `escalated to ${destination}`} (crash-recovered)`
          : (cause ?? `escalated to ${destination}`),
        payloadRef: null,
        payloadPreview: null,
        attachments: [],
        actorId: actor.actorId,
      });
      // The durable operation COMPLETION — after every durable outcome
      // (a crash before this leaves the row PENDING; the retry
      // converges via the record-reconciliation path above).
      await store.completeMessagingOperation(actor.applicationId, operationKey, iso());
      return {
        conversationId: conversation.id,
        executionId: conversation.executionId,
        escalationKey: idempotencyKey,
        destination: record.escalation.destination,
        ledgerSequence: escalationEvidence.sequence,
        replayed: recoveredEscalation || wait.replayed,
      };
    },

    /** Close the conversation (terminal) with completion provenance. */
    async closeConversation(
      input: { readonly conversationId: string; readonly cause?: string },
      idempotencyKey: string,
      actor: MessagingActor,
    ): Promise<{
      readonly conversationId: string;
      readonly executionId: string;
      readonly replayed: boolean;
    }> {
      requireKey(idempotencyKey);
      const cause = requireCause(input.cause);
      const conversation = await resolveConversation(actor, input.conversationId);
      // The durable conversation-close OPERATION key (the recovery
      // discriminator — the same retry derives the same key).
      const operationKey = messagingOperationKey("conversation-close", idempotencyKey);
      if (isTerminalMessagingConversationStatus(conversation.status)) {
        // CRASH RECOVERY: a PENDING close operation under this key means
        // the terminal move committed but the completion did not — the
        // terminal status IS the durable proof; reconcile and replay.
        const operation = await store.findMessagingOperation(actor.applicationId, operationKey);
        if (operation !== null && operation.status === "pending") {
          await store
            .completeMessagingOperation(actor.applicationId, operationKey, iso())
            .catch(() => undefined);
        }
        return {
          conversationId: conversation.id,
          executionId: conversation.executionId,
          replayed: true,
        };
      }
      // The durable operation claim — BEFORE the rail side effect (a
      // crash between the rail close and the terminal mutation leaves
      // this row PENDING; the retry resumes with the STABLE rail key
      // instead of closing twice).
      const begun = await beginOperation("conversation-close", idempotencyKey, {
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        conversationId: conversation.id,
        deploymentId: conversation.deploymentId,
        executionId: conversation.executionId,
      });
      if (begun.status === "existing" && begun.record.status === "completed") {
        // A concurrent invocation completed this close: the terminal
        // status MUST be committed (completion follows the terminal move).
        const reread = await store.findConversation(actor.applicationId, conversation.id);
        if (reread === null || !isTerminalMessagingConversationStatus(reread.status)) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message:
              "messaging close operation is completed but the conversation is not terminal (invariant violation)",
          });
        }
        return {
          conversationId: conversation.id,
          executionId: conversation.executionId,
          replayed: true,
        };
      }
      const completion = await ledger.recordEvidence(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: conversation.executionId,
          evidenceClass: "conversation-completed",
          cause: "messaging conversation closed",
          reference: {
            conversationId: conversation.id,
            eventKey: `${idempotencyKey}:close`,
            channelConversationRef: conversation.channelConversationRef,
          },
          payload: { cause, pinnedPlanVersion: conversation.pinnedPlanVersion },
        },
        `messaging:completion:${idempotencyKey}`,
      );
      // The rail close (best-effort upstream cleanup) — under the
      // STABLE rail-level idempotency key: a retry or crash-resume
      // re-closes under the SAME key and the rail converges (exactly
      // one upstream close, ever).
      await rail
        .closeConversation({
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          channelConversationRef: conversation.channelConversationRef,
          idempotencyKey: messagingRailCloseKey(idempotencyKey),
          cause,
        })
        .catch(() => undefined);
      await appendMessage({
        conversation,
        kind: "system-marker",
        direction: "internal",
        eventKey: `${idempotencyKey}:close`,
        threadRef: null,
        threadSequence: null,
        orderingMarker: null,
        ledgerSequence: completion.sequence,
        routeClass: null,
        replyToEventKey: null,
        channelMessageRef: null,
        deliveryStatus: null,
        cause,
        payloadRef: null,
        payloadPreview: null,
        attachments: [],
        actorId: actor.actorId,
      });
      if (!isTerminalMessagingConversationStatus(conversation.status)) {
        await store.applyGuardedConversationMutation({
          applicationId: actor.applicationId,
          conversationId: conversation.id,
          expectedStatus: conversation.status,
          toStatus: "closed",
          closedAt: iso(),
        });
      }
      // The durable operation COMPLETION — after every durable outcome.
      await store.completeMessagingOperation(actor.applicationId, operationKey, iso());
      return {
        conversationId: conversation.id,
        executionId: conversation.executionId,
        replayed: begun.status === "existing",
      };
    },

    /** Read one conversation (application-scoped) with its execution facts. */
    async getConversation(applicationId: string, conversationId: string) {
      if (!isUuid(applicationId) || !isUuid(conversationId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "applicationId/conversationId must be UUIDs",
        });
      }
      const conversation = await store.findConversation(applicationId, conversationId);
      if (conversation === null) {
        return null;
      }
      const execution = await ledger.readExecution(applicationId, conversation.executionId);
      return { conversation, execution };
    },

    /** The message ledger of one conversation (append order). */
    async listMessages(applicationId: string, conversationId: string) {
      if (!isUuid(applicationId) || !isUuid(conversationId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "applicationId/conversationId must be UUIDs",
        });
      }
      return store.listMessages(applicationId, conversationId);
    },

    /** The delivery-evidence rows of one conversation (append order). */
    async listDeliveries(applicationId: string, conversationId: string) {
      if (!isUuid(applicationId) || !isUuid(conversationId)) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "applicationId/conversationId must be UUIDs",
        });
      }
      return store.listDeliveries(applicationId, conversationId);
    },
  };
}

export type MessagingConversationService = ReturnType<typeof createMessagingConversationService>;
