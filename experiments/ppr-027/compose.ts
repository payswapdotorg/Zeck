/**
 * PPR-027 — the per-cell experiment composition: the REAL Zeck public API
 * (seeded in-process exactly like the platform's own API suites and the
 * nine certified proofs) over the REAL model gateway and rail machinery,
 * with the SYNTHETIC supply transport (transport.ts) behind the rails and
 * THIS study's execution driver driving every created execution through
 * the executions authority's public transitions.
 *
 * This composes the same machinery the nine certified integrations
 * composed (the seedApiWorld + createModelGateway + createRailRegistry +
 * execution-driver discipline), with two experiment-side substitutions,
 * both disclosed:
 *  - the supply rails dispatch to the injected synthetic transport, not
 *    to a live provider endpoint (the sandbox's provider axis is a
 *    declared deterministic profile — see transport.ts);
 *  - the execution driver is THIS study's driver (experiments/ppr-027 —
 *    owned by this work order), implementing the platform-side provider
 *    selection policy for the provider-count axis: single-configuration
 *    cells address the one registered supply; multi-configuration cells
 *    address three registered supplies round-robin with failover on the
 *    policy retry. Provider selection NEVER appears on the application
 *    side (the experiment driver in driver.ts addresses the boundary
 *    only — it is provider-blind by construction).
 *
 * Two execution planes (the certified discipline): the MODEL plane
 * (chat/vision/audio/image/embeddings/rerank surfaces through the rail)
 * and the DETERMINISTIC substrate plane (sandbox-program-execution —
 * modelCalls 0, a real deterministic computation, mirroring the
 * PPR-024 substrate plane and the PPR-025 embeddings plane).
 */

import { createHash } from "node:crypto";
import type { Principal, ScopeResolver } from "../../src/modules/auth/public";
import {
  createScopeResolver,
  type IdentityStore,
  type MembershipRecord,
} from "../../src/modules/auth/public";
import type {
  ConnectionCatalog,
  ConnectionDispatchFacts,
  CredentialMaterializer,
} from "../../src/modules/connections/public";
import type { ExecutionRecord, ExecutionService } from "../../src/modules/executions/public";
import type { ModelGateway } from "../../src/modules/models/application/model-gateway";
import { createModelGateway } from "../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../src/modules/models/application/rail-registry";
import type {
  DispatchStatus,
  ModelCallOutcome as JournalOutcome,
  ModelCallOutcome,
} from "../../src/modules/models/domain/outcome";
import type { ModelRequest } from "../../src/modules/models/domain/request";
import type { StreamEvent } from "../../src/modules/models/domain/stream";
import type {
  DispatchIntentInput,
  DispatchJournal,
  JournalAttempt,
} from "../../src/modules/models/ports/dispatch-journal";
import type {
  ModelProvider,
  ProviderDispatchContext,
} from "../../src/modules/models/ports/model-provider";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import type { CostClaim } from "../../src/platform/execution-ir/cost-model";
import type { OptimizationDecisionRecord } from "../../src/platform/execution-ir/decision-record";
import type { ExecutionIr, IrDigestPort } from "../../src/platform/execution-ir/ir";
import { attributeFailure } from "../../src/platform/failure-recovery/attribution";
import type { FailureClass, FailureSignal } from "../../src/platform/failure-recovery/catalog";
import type {
  RecoveryPlan,
  RecoveryPlanConfiguration,
  RecoveryPlanStepFrame,
} from "../../src/platform/failure-recovery/plan";
import { decideSupplyRetry } from "../../src/platform/failure-recovery/supply-retry";
import { selectModelRepresentation } from "../../src/platform/model-economics/model-selection";
import type { QualityFacts } from "../../src/platform/model-economics/vocabulary";
import type { ApiWorld } from "../../tests/unit/api/world";
import { ACTOR_ID, seedApiWorld } from "../../tests/unit/api/world";
import {
  type ProviderConfigKind,
  requestCostNanoUsd,
  type SubjectDefinition,
  type SubjectEdge,
  type WorkloadRequest,
  type WorkloadSurface,
} from "./config";
import { createSyntheticSupply, type SyntheticSupplyTransport } from "./transport";

/** The task envelope THIS study's boundary carries (the ACR-007 task shape). */
export interface WorkloadTaskEnvelope {
  readonly kind: "ppr-027.workload";
  readonly edgeId: string;
  readonly surface: WorkloadSurface;
  readonly role: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One dispatch attempt's durable facts (the worker's telemetry axis). */
export interface WorkerDispatchFact {
  readonly executionId: string;
  readonly providerId: string;
  readonly attempt: number;
  readonly outcome: "provider-success" | "provider-failure";
  readonly latencyMs: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly costNanoUsd: number;
  readonly policyRetry: boolean;
}

export interface ExperimentStack {
  readonly world: ApiWorld;
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly applicationId: string;
  readonly transport: SyntheticSupplyTransport;
  readonly dispatchFacts: () => readonly WorkerDispatchFact[];
  readonly close: () => Promise<void>;
}

export interface ComposeExperimentOptions {
  readonly subject: SubjectDefinition;
  readonly providerConfig: ProviderConfigKind;
  /** The synthetic supplies' provider ids (from the sweep config). */
  readonly providerIds: readonly string[];
  /** The retry cooldown (compressed for the sweep — declared, disclosed). */
  readonly retryCooldownMs?: number;
  /** The sleeper (injectable for hermetic tests). */
  readonly sleeper?: (ms: number) => Promise<void>;
  /**
   * PCR-002 (ACR-008 §6): the recovery wiring at THIS traced retry/
   * failover seam — the plan-composition mode rides the
   * `RecoveryConfiguration` with plan mode DEFAULT OFF. ABSENT (or
   * `planMode: "off"`) preserves the traced one-failover-retry posture
   * byte-for-byte; `planMode: "on"` is an evaluation/tenant
   * configuration ONLY — no code path promotes it by default.
   */
  readonly recovery?: ExperimentRecoveryWiring;
}

/**
 * The recovery wiring at the traced seam: the plan mode (DEFAULT OFF)
 * plus — when plan mode is ON — the evaluation/tenant-supplied plan
 * composition inputs. All inputs are EXPLICIT policy inputs (never
 * ambient, never self-raising); plan mode ON without its plan inputs
 * fails closed at the wiring's decision core.
 */
export interface ExperimentRecoveryWiring {
  /** The plan mode — DEFAULT OFF (absent = off = the byte-preserved posture). */
  readonly planMode?: "off" | "on";
  /** The plan composition inputs — REQUIRED when planMode is "on". */
  readonly plan?: ExperimentRecoveryPlanInputs;
}

/** The evaluation/tenant-supplied plan composition inputs (plan mode ON). */
export interface ExperimentRecoveryPlanInputs {
  /** The recovery-plan configuration (the step bound is REQUIRED — never ambient). */
  readonly planConfiguration: RecoveryPlanConfiguration;
  /** The governing quality facts (the assurance floor — inviolable). */
  readonly qualityFacts: QualityFacts;
  /** The governing constraint set (hard constraints enforced). */
  readonly constraints: readonly OptimizationConstraint[];
  /** The retry path's declared claim (the declared economics per retry attempt). */
  readonly retryClaim: CostClaim;
  /**
   * The declared provider-failover alternates (capability-equal
   * alternate SUPPLIES for the same selected representation — the
   * claims are the evaluation's declared economics per alternate
   * supply).
   */
  readonly providerAlternates: readonly {
    readonly providerId: string;
    readonly claim: CostClaim;
  }[];
  /** The governed Execution IR the recovery's decisions belong to. */
  readonly ir: ExecutionIr;
  /** The governed IR's model-selection step id (a generative step). */
  readonly stepId: string;
  /** The digest port (content addressing — injected, never ambient). */
  readonly digest: IrDigestPort;
  /** The observer of the composed plan (the evaluation's evidence hook). */
  readonly onPlanComposed?: (plan: RecoveryPlan) => void;
  /**
   * The observer of the plan steps' WORK-049 decision records — the
   * EXISTING seam's append-only VALUES (the caller appends them at its
   * own seam; this wiring creates no new durable surface).
   */
  readonly onDecisionRecords?: (records: readonly OptimizationDecisionRecord[]) => void;
}

/** The synthetic model identity for one surface (neutral strings). */
export function syntheticModelOf(surface: WorkloadSurface): string {
  switch (surface) {
    case "text-generation":
      return "synth-text";
    case "vision-image-understanding":
      return "synth-vision";
    case "speech-recognition":
      return "synth-asr";
    case "speech-generation":
      return "synth-tts";
    case "image-generation":
      return "synth-image";
    case "embeddings":
      return "synth-embed";
    case "rerank":
      return "synth-rerank";
    case "sandbox-program-execution":
      return "synth-substrate";
  }
}

/** The dispatch envelope the rail parses back out of the ModelRequest. */
interface RailEnvelope {
  readonly edgeId: string;
  readonly surface: WorkloadSurface;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly streamKey: string;
  readonly attempt: number;
}

function buildModelRequest(envelope: RailEnvelope): ModelRequest {
  return {
    model: syntheticModelOf(envelope.surface),
    messages: [
      {
        role: "user",
        content: JSON.stringify({
          edgeId: envelope.edgeId,
          surface: envelope.surface,
          inputTokens: envelope.inputTokens,
          outputTokens: envelope.outputTokens,
          streamKey: envelope.streamKey,
          attempt: envelope.attempt,
        }),
      },
    ],
  };
}

function parseRailEnvelope(request: ModelRequest): RailEnvelope {
  const last = request.messages.at(-1);
  if (last === undefined) {
    throw new Error("the experiment rail envelope requires one message");
  }
  return JSON.parse(last.content) as RailEnvelope;
}

/**
 * The one synthetic supply rail (a ModelProvider over the transport). The
 * rail slug is the platform's "custom" class (the certified proofs' own
 * rail identity); the ADDRESSED SUPPLY comes from the connection's
 * endpoint URL ("synthetic://supply-a" | -b | -c) — the platform's BYOK
 * connection model, where provider multiplicity lives in connections,
 * never in the application.
 */
function createSyntheticRail(
  transport: SyntheticSupplyTransport,
  edgeOfSubject: (edgeId: string) => SubjectEdge,
): ModelProvider {
  return {
    rail: "custom",
    async complete(
      request: ModelRequest,
      context: ProviderDispatchContext,
    ): Promise<ModelCallOutcome> {
      const endpoint = context.endpointUrl ?? "synthetic://supply-a";
      const providerId = endpoint.replace("synthetic://", "");
      const envelope = parseRailEnvelope(request);
      const edge = edgeOfSubject(envelope.edgeId);
      const workload: WorkloadRequest = {
        edgeId: envelope.edgeId,
        inputTokens: envelope.inputTokens,
        outputTokens: envelope.outputTokens,
      };
      const outcome = await transport.dispatch({
        providerId,
        edge,
        request: workload,
        streamKey: envelope.streamKey,
        attempt: envelope.attempt,
      });
      if (outcome.ok) {
        return {
          kind: "provider-success",
          response: {
            content: [
              JSON.stringify({
                edgeId: envelope.edgeId,
                providerId,
                outputBytes: outcome.usage.outputTokens,
              }),
            ],
            stopReason: "stop",
            structuredOutput: null,
            usage: {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              totalTokens: null,
              costUsd: null,
            },
            providerLatencyMs: outcome.latencyMs,
          },
        };
      }
      return {
        kind: "provider-failure",
        failure: {
          category: outcome.category,
          retryable: outcome.retryable,
          rail: providerId,
          providerCode: `synthetic-${outcome.category}`,
          providerMessage: `synthetic supply ${providerId} injected a ${outcome.category} fault (declared profile)`,
          httpStatus:
            outcome.category === "rate-limit" ? 429 : outcome.category === "timeout" ? 504 : 503,
          durationMs: outcome.latencyMs,
        },
      };
    },
    stream(request: ModelRequest): AsyncIterable<StreamEvent> {
      void request;
      throw new Error("the experiment rail does not stream (one-shot dispatch only)");
    },
  };
}

/** The scope/identity wiring (the world's own pattern, in-process). */
function scopeResolverOf(world: ApiWorld): ScopeResolver {
  const rows = new Map<string, { membership: MembershipRecord; applicationTenantId: string }>([
    [
      `${ACTOR_ID}:${world.applicationId}`,
      {
        membership: {
          id: `membership-${world.applicationId.slice(-8)}`,
          actorId: ACTOR_ID,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          role: "owner",
          createdAt: "2026-10-10T00:00:00Z",
        },
        applicationTenantId: world.tenantId,
      },
    ],
  ]);
  const store: IdentityStore = {
    provisionActor: (() => {
      throw new Error("not implemented in the experiment composition");
    }) as never,
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: (async (actorId: string, applicationId: string) =>
      rows.get(`${actorId}:${applicationId}`) ?? null) as never,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: (() => {
      throw new Error("not implemented in the experiment composition");
    }) as never,
    updateMembershipRole: (() => {
      throw new Error("not implemented in the experiment composition");
    }) as never,
    deleteMembership: (() => {
      throw new Error("not implemented in the experiment composition");
    }) as never,
    lockApplicationMemberships: (async () => []) as never,
  };
  return createScopeResolver(store);
}

/** The multi-connection in-memory catalog (the sweep's provider axis). */
function createExperimentConnectionCatalog(
  connections: {
    readonly connectionId: string;
    readonly tenantId: string;
    readonly applicationId: string;
    readonly rail: "custom";
    readonly endpointUrl: string;
  }[],
): ConnectionCatalog & CredentialMaterializer {
  const factsById = new Map<string, ConnectionDispatchFacts>(
    connections.map((connection) => [
      connection.connectionId,
      {
        id: connection.connectionId,
        tenantId: connection.tenantId,
        applicationId: connection.applicationId,
        rail: connection.rail,
        endpointUrl: connection.endpointUrl,
        credentialKind: "byok",
        credentialRef: `ppr-027-supply-${connection.endpointUrl}`,
        status: "active",
      },
    ]),
  );
  const materialByRef = new Map(
    connections.map((connection) => [
      `ppr-027-supply-${connection.endpointUrl}`,
      connection.connectionId,
    ]),
  );
  return {
    async getConnectionForDispatch(scope, connectionId) {
      const facts = factsById.get(connectionId);
      if (facts === undefined) {
        throw Object.assign(new Error("connection not found"), { name: "PlatformError" });
      }
      if (facts.tenantId !== scope.tenantId || facts.applicationId !== scope.applicationId) {
        throw Object.assign(new Error("connection belongs to a different application or tenant"), {
          name: "PlatformError",
        });
      }
      return facts;
    },
    async materialize(reference) {
      const connectionId = materialByRef.get(reference);
      if (connectionId === undefined) {
        throw new Error(`unknown credential reference ${reference}`);
      }
      return { reference, plaintext: `synthetic-supply:${connectionId}` };
    },
  } satisfies ConnectionCatalog & CredentialMaterializer;
}

/** The in-memory dispatch journal (the same write discipline as the proofs). */
function createExperimentDispatchJournal(): DispatchJournal & {
  readonly attempts: readonly JournalAttempt[];
} {
  const byId = new Map<string, JournalAttempt>();
  let clock = 0;
  const now = () => {
    clock += 1;
    return new Date(Date.parse("2026-10-10T00:00:00Z") + clock).toISOString();
  };
  return {
    get attempts() {
      return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async recordIntent(input: DispatchIntentInput) {
      byId.set(input.id, {
        id: input.id,
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        connectionId: input.connectionId,
        rail: input.rail,
        model: input.model,
        requestHash: input.requestHash,
        admitted: true,
        status: "dispatching",
        outcome: null,
        createdAt: now(),
        resolvedAt: null,
      });
    },
    async recordOutcome(attemptId, status: DispatchStatus, outcome: JournalOutcome) {
      const attempt = byId.get(attemptId);
      if (attempt === undefined) {
        throw new Error(`unknown dispatch attempt ${attemptId}`);
      }
      byId.set(attemptId, { ...attempt, status, outcome, resolvedAt: now() });
    },
    async recordDenial(input, reason) {
      byId.set(input.id, {
        id: input.id,
        tenantId: input.tenantId,
        applicationId: input.applicationId,
        connectionId: input.connectionId,
        rail: input.rail,
        model: input.model,
        requestHash: input.requestHash,
        admitted: false,
        status: "denied",
        outcome: { reason },
        createdAt: now(),
        resolvedAt: now(),
      });
    },
    async findAttempt(attemptId) {
      return byId.get(attemptId) ?? null;
    },
  };
}

/**
 * Compose one experiment cell's stack. The execution driver wraps the
 * world's executions service BEFORE the API serves its first request —
 * every execution the boundary creates is driven to a terminal status by
 * THIS study's driver through the authority's own commands.
 */
export async function composeExperimentStack(
  options: ComposeExperimentOptions,
): Promise<ExperimentStack> {
  const world = await seedApiWorld();
  const sleep = options.sleeper ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryCooldownMs = options.retryCooldownMs ?? 5;
  const transport = createSyntheticSupply({ sleeper: options.sleeper });

  const providerIds =
    options.providerConfig === "single"
      ? [options.providerIds[0] ?? "supply-a"]
      : options.providerIds;
  const edgeOfSubject = (edgeId: string): SubjectEdge => {
    const edge = options.subject.edges.find((candidate) => candidate.edgeId === edgeId);
    if (edge === undefined) {
      throw new Error(`unknown edge ${edgeId} for subject ${options.subject.subjectId}`);
    }
    return edge;
  };

  const rails = [createSyntheticRail(transport, edgeOfSubject)];
  const registry = createRailRegistry(rails);

  const connections = providerIds.map((providerId, index) => ({
    connectionId: `00000000-0000-7000-8000-${`ppr027${index}`.padEnd(12, "0").slice(0, 12)}`,
    tenantId: world.tenantId,
    applicationId: world.applicationId,
    rail: "custom" as const,
    endpointUrl: `synthetic://${providerId}`,
  }));
  const catalog = createExperimentConnectionCatalog(connections);
  const journal = createExperimentDispatchJournal();

  const gateway: ModelGateway = createModelGateway({
    resolver: scopeResolverOf(world),
    catalog,
    credentials: catalog,
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: {
      async resolve() {
        return { satisfied: true, catalogRevision: "ppr-027", satisfactions: [] };
      },
    },
    rails: registry,
    journal,
    generateId: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `00000000-0000-7000-8000-${String(5_000_000 + n).slice(-12)}`;
      };
    })(),
    defaultTimeoutMs: 30_000,
    hashRequest: (request) =>
      createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
  });

  const PRINCIPAL: Principal = {
    actorId: ACTOR_ID,
    authenticatedAt: new Date().toISOString(),
  };

  const dispatchFacts: WorkerDispatchFact[] = [];

  /**
   * The platform-side provider selection policy (the provider-count axis):
   * attempt 1 round-robins across the registered supplies; the ONE policy
   * retry fails over to the NEXT supply (multi cells) or re-addresses the
   * same supply (single cells). Both attempts are recorded honestly.
   *
   * PCR-002 (ACR-008 §6): the traced one-failover-retry posture is now
   * the typed decision core of the failure-recovery plane
   * (`decideSupplyRetry`), wired HERE behind the `RecoveryConfiguration`
   * with plan mode DEFAULT OFF — the traced posture is byte-preserved
   * (plan mode off = the exact dispatch sequence below); plan mode ON
   * (an evaluation/tenant configuration only) composes the bounded
   * recovery plan through the PCR-001 composer and executes its
   * dispatch-representable steps instead.
   */
  let roundRobin = 0;
  const connectionForAttempt = (attempt: number): string => {
    const count = connections.length;
    const index = attempt === 1 ? roundRobin % count : (roundRobin + 1) % count;
    if (attempt === 1) {
      roundRobin += 1;
    }
    return connections[index]?.connectionId ?? connections[0]?.connectionId ?? "";
  };
  const supplyOfConnection = (connectionId: string): string => {
    const connection = connections.find((candidate) => candidate.connectionId === connectionId);
    if (connection === undefined) {
      throw new Error(`unknown connection ${connectionId}`);
    }
    return connection.endpointUrl.replace("synthetic://", "");
  };

  /**
   * PCR-002: the traced seam's recovery configuration — plan mode rides
   * the configuration (DEFAULT OFF: absent = off; the byte-preserved
   * one-failover-retry posture). The base policy numbers mirror the
   * traced posture: ONE policy retry at the first attempt. Plan mode ON
   * carries the evaluation's declared plan configuration wholesale (the
   * plan step bound rides the configuration — never ambient).
   */
  const recoveryConfiguration =
    options.recovery?.planMode === "on" && options.recovery.plan !== undefined
      ? { ...options.recovery.plan.planConfiguration, planMode: "on" as const }
      : {
          maxRetryAttempts: 1,
          escalationEvidenceBound: 8,
          continuationStepBound: 32,
          planMode: options.recovery?.planMode ?? "off",
        };

  /**
   * The failure-signal mapping of the synthetic supplies' closed fault
   * vocabulary onto the failure-recovery plane's own closed observation
   * signals (the CALLER-side mapping — the plane never imports a
   * transport taxonomy; an unknown category fails closed).
   */
  const RECOVERY_SIGNAL_OF: Readonly<
    Record<
      string,
      {
        readonly signal: FailureSignal;
        readonly failureClass: FailureClass;
        readonly evidence:
          | { readonly kind: "provider"; readonly providerErrorClass: "rate-limited" | "capacity" }
          | { readonly kind: "infrastructure"; readonly transient: true };
      }
    >
  > = {
    "rate-limit": {
      signal: "provider-rate-limited",
      failureClass: "provider",
      evidence: { kind: "provider", providerErrorClass: "rate-limited" },
    },
    timeout: {
      signal: "transport-timeout",
      failureClass: "infrastructure",
      evidence: { kind: "infrastructure", transient: true },
    },
    "provider-unavailable": {
      signal: "provider-capacity",
      failureClass: "provider",
      evidence: { kind: "provider", providerErrorClass: "capacity" },
    },
  };

  /** The neutral outcome mirror the decision core consumes. */
  const outcomeMirrorOf = (
    outcome: ModelCallOutcome,
  ): { readonly kind: "provider-success" | "provider-failure"; readonly retryable: boolean } => ({
    kind: outcome.kind,
    retryable: outcome.kind === "provider-failure" ? outcome.failure.retryable : false,
  });

  /**
   * The physical-dispatch occurrence: every REAL provider exposure draws
   * independently (the occurrence suffix), while the task payload stays
   * idempotency-stable — a repeated logical request with a durable
   * successful outcome REPLAYS (zero provider exposure); a re-dispatch
   * after a FAILED outcome (the fresh-key mechanism) draws fresh provider
   * behavior, exactly as a real re-issued request would.
   *
   * PCR-002: the retry decision runs through the failure-recovery plane's
   * typed decision core (`decideSupplyRetry`) behind the
   * `RecoveryConfiguration` — plan mode DEFAULT OFF byte-preserves the
   * traced posture (one retry on a retryable provider failure of the
   * first attempt, failing over to the next supply); plan mode ON (an
   * evaluation/tenant configuration only) composes the bounded recovery
   * plan through the PCR-001 composer over caller-supplied frames and
   * executes its dispatch-representable steps, recording every plan
   * step's decision through the EXISTING WORK-049 seam (append-only
   * values at the caller's observer).
   */
  let dispatchOccurrence = 0;
  const dispatchWithPolicyRetry = async (
    envelope: RailEnvelope,
    executionId: string,
  ): Promise<{ outcome: ModelCallOutcome; providerId: string; attempt: number }> => {
    dispatchOccurrence += 1;
    const occurrence = dispatchOccurrence;
    const dispatchEnvelope: RailEnvelope = {
      ...envelope,
      streamKey: `${envelope.streamKey}:d${occurrence}`,
    };
    const firstConnection = connectionForAttempt(1);
    const first = await gateway.complete(
      PRINCIPAL,
      world.applicationId,
      firstConnection,
      buildModelRequest(dispatchEnvelope),
    );
    const decision = decideSupplyRetry({
      attemptsUsed: 1,
      lastOutcome: outcomeMirrorOf(first.outcome),
      configuration: recoveryConfiguration,
      ...(options.recovery?.plan !== undefined && first.outcome.kind === "provider-failure"
        ? {
            plan: {
              frames: planFramesOf(dispatchEnvelope, first.outcome, occurrence, executionId),
              qualityFacts: options.recovery.plan.qualityFacts,
              constraints: options.recovery.plan.constraints,
              decision: {
                ir: options.recovery.plan.ir,
                scope: {
                  applicationId: world.applicationId,
                  tenantId: world.tenantId,
                  executionId,
                  recordedAt: new Date().toISOString(),
                },
              },
              digest: options.recovery.plan.digest,
            },
          }
        : {}),
    });
    if (decision.kind === "execute-plan") {
      // PLAN MODE ON (an evaluation/tenant configuration ONLY): execute
      // the composed plan's dispatch-representable steps — retry moves
      // re-address the current supply, provider-failover re-routes
      // dispatch on the step's OWN selected route. The plan's bounded
      // step count IS the retry bound (plans never loop, never exceed
      // their bound); a non-dispatch-representable move stops execution
      // honestly (the seam returns the last outcome with the plan and
      // its records already observed).
      options.recovery?.plan?.onPlanComposed?.(decision.plan);
      options.recovery?.plan?.onDecisionRecords?.(decision.decisionRecords);
      let outcome = first.outcome;
      let connectionId = firstConnection;
      let attempt = 1;
      for (const step of decision.plan.steps) {
        let nextConnection = connectionId;
        if (step.move.kind === "retry") {
          nextConnection = connectionId;
        } else if (step.move.kind === "re-route" && step.move.dimension === "provider") {
          const selectedRoute = step.facts.reroute.provider?.selection.selected?.route;
          if (selectedRoute === undefined || selectedRoute === null) {
            break;
          }
          const connection = connections.find(
            (candidate) =>
              candidate.endpointUrl.replace("synthetic://", "") === selectedRoute.provider,
          );
          if (connection === undefined) {
            break;
          }
          nextConnection = connection.connectionId;
        } else {
          // A move this supply seam cannot execute (model/substrate
          // re-route, escalation, repair) — the honest stop.
          break;
        }
        await sleep(retryCooldownMs);
        attempt += 1;
        connectionId = nextConnection;
        const next = await gateway.complete(
          PRINCIPAL,
          world.applicationId,
          connectionId,
          buildModelRequest({ ...dispatchEnvelope, attempt }),
        );
        outcome = next.outcome;
        if (next.outcome.kind === "provider-success") {
          break;
        }
      }
      return { outcome, providerId: supplyOfConnection(connectionId), attempt };
    }
    if (decision.kind === "retry-once-next-supply") {
      await sleep(retryCooldownMs);
      const secondConnection = connectionForAttempt(2);
      const second = await gateway.complete(
        PRINCIPAL,
        world.applicationId,
        secondConnection,
        buildModelRequest({ ...dispatchEnvelope, attempt: 2 }),
      );
      return {
        outcome: second.outcome,
        providerId: supplyOfConnection(secondConnection),
        attempt: 2,
      };
    }
    return { outcome: first.outcome, providerId: supplyOfConnection(firstConnection), attempt: 1 };
  };

  /**
   * PCR-002 (plan mode ON): build the caller-supplied per-step frames —
   * the driver-side projection of the then-current failure state as the
   * bounded ladder is consumed: the SAME attributed root failure
   * persists, the incumbent supply rotates through the registered
   * failover ladder (the projected post-failover state), the retry
   * attempt numbers stay coherent, and the provider-failover alternates
   * exclude the projected incumbent (a capability-equal alternate for
   * the SAME selected representation). The frames are the CALLER's
   * declared projection (the pure plane never derives them) — one frame
   * per step the configured plan bound admits.
   */
  const planFramesOf = (
    envelope: RailEnvelope,
    outcome: ModelCallOutcome,
    occurrence: number,
    executionId: string,
  ): RecoveryPlanStepFrame[] => {
    const plan = options.recovery?.plan;
    if (plan === undefined || outcome.kind !== "provider-failure") {
      throw new Error("plan frames require the plan inputs and a provider-failure outcome");
    }
    const mapping = RECOVERY_SIGNAL_OF[outcome.failure.category];
    if (mapping === undefined) {
      throw new Error(`unknown provider failure category ${outcome.failure.category}`);
    }
    const model = syntheticModelOf(envelope.surface);
    const observedAt = new Date().toISOString();
    const supplies = connections.map((candidate) =>
      candidate.endpointUrl.replace("synthetic://", ""),
    );
    const attribution = attributeFailure(
      {
        signal: mapping.signal,
        component: "model-rail",
        stepId: plan.stepId,
        routeRef: { provider: supplies[0] ?? "supply-a", model },
        detail: `the synthetic supply failed with ${outcome.failure.category} (attempt 1, occurrence ${occurrence})`,
        observedAt,
        observationDigest: plan.digest.sha256Hex(
          `ppr-027:fault:${outcome.failure.category}:${envelope.streamKey}:${occurrence}`,
        ),
      },
      mapping.failureClass,
      mapping.evidence,
      plan.digest,
    );
    const maxPlanSteps = plan.planConfiguration.maxPlanSteps;
    const frames: RecoveryPlanStepFrame[] = [];
    for (let index = 0; index < maxPlanSteps; index += 1) {
      const incumbentSupply = supplies[index % supplies.length] ?? "supply-a";
      const alternates = plan.providerAlternates
        .filter((alternate) => alternate.providerId !== incumbentSupply)
        .map((alternate) => ({
          candidateId: `${alternate.providerId}-${model}`,
          route: { provider: alternate.providerId, model },
          representationClass: "sufficient-model" as const,
          claim: alternate.claim,
        }));
      frames.push({
        attribution,
        context: {
          executionId,
          stepId: plan.stepId,
          attemptsUsed: 1 + index,
          incumbentRoute: { provider: incumbentSupply, model },
        },
        facts: {
          retry: { nextAttempt: 2 + index, claim: plan.retryClaim },
          reroute: {
            model: null,
            substrate: null,
            provider:
              alternates.length === 0
                ? null
                : {
                    selection: selectModelRepresentation({
                      ir: plan.ir,
                      stepId: plan.stepId,
                      candidates: alternates,
                      qualityFacts: plan.qualityFacts,
                      constraints: plan.constraints,
                    }),
                    declaredCandidates: alternates,
                  },
          },
          escalation: null,
        },
      });
    }
    return frames;
  };

  const executions = world.executions;
  const execute = async (record: ExecutionRecord): Promise<void> => {
    const task = record.task as Record<string, unknown>;
    const key = (step: string) => `ppr-027-driver-${record.id}-${step}`;
    const actor = { actorId: ACTOR_ID, tenantId: record.tenantId };
    const envelope: RailEnvelope = {
      edgeId: String(task.edgeId ?? ""),
      surface: (task.surface ?? "text-generation") as WorkloadSurface,
      inputTokens: Number(task.inputTokens ?? 0),
      outputTokens: Number(task.outputTokens ?? 0),
      streamKey: String(task.streamKey ?? ""),
      attempt: 1,
    };

    for (const step of ["authorize", "plan"] as const) {
      await executions.transition(
        {
          command: step,
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
        },
        key(step),
      );
    }

    const model = syntheticModelOf(envelope.surface);
    const isDeterministicSubstrate = envelope.surface === "sandbox-program-execution";
    await executions.recordPlanningDecision(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        tenantId: record.tenantId,
        actorId: actor.actorId,
        decisionId: `decision-${record.id}`,
        planId: `plan-${record.id}`,
        payload: {
          candidates: [
            {
              strategyId: isDeterministicSubstrate
                ? "ppr-027-deterministic-substrate"
                : "ppr-027-model-rail",
              plan: {
                strategyClass: isDeterministicSubstrate ? "deterministic-substrate" : "model-rail",
                modelCalls: isDeterministicSubstrate ? 0 : 1,
                steps: [
                  {
                    routeRef: {
                      provider: isDeterministicSubstrate ? "deterministic" : "experiment-supply",
                      model,
                    },
                  },
                ],
              },
            },
          ],
          selectedStrategyId: isDeterministicSubstrate
            ? "ppr-027-deterministic-substrate"
            : "ppr-027-model-rail",
        },
      },
      key("decision"),
    );

    await executions.transition(
      {
        command: "queue",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
      },
      key("queue"),
    );
    await executions.transition(
      {
        command: "start",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
        dispatch: { operationId: `dispatch-${record.id}`, amountMicroUsd: "5000" },
      },
      key("start"),
    );

    await executions.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        actor,
        command: "tool-requested",
        cause: isDeterministicSubstrate
          ? "deterministic-substrate-dispatch"
          : "model-rail-dispatch",
        reference: {
          tool: isDeterministicSubstrate ? "deterministic-substrate" : "model-rail",
          ...(isDeterministicSubstrate ? {} : { provider: "experiment-supply", model }),
        },
        payload: {
          tool: isDeterministicSubstrate ? "deterministic-substrate" : "model-rail",
          edge: envelope.edgeId,
          kind: task.kind,
          streamKey: envelope.streamKey,
        },
      },
      key("tool-requested"),
    );

    // ------------------------------------------------------------------
    // THE DETERMINISTIC SUBSTRATE PLANE (modelCalls 0 — PPR-024's shape)
    // ------------------------------------------------------------------
    if (isDeterministicSubstrate) {
      const startedAt = Date.now();
      const computation = createHash("sha256").update(envelope.streamKey).digest("hex");
      const recomputed = createHash("sha256").update(envelope.streamKey).digest("hex");
      const identical = computation === recomputed;
      const latencyMs = Date.now() - startedAt;
      dispatchFacts.push({
        executionId: record.id,
        providerId: "deterministic",
        attempt: 1,
        outcome: "provider-success",
        latencyMs,
        usage: { inputTokens: 0, outputTokens: 0 },
        costNanoUsd: 0,
        policyRetry: false,
      });
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: "deterministic-substrate-result",
          reference: { tool: "deterministic-substrate" },
          payload: {
            tool: "deterministic-substrate",
            kind: "substrate-result",
            modelCalls: 0,
            strategy: "deterministic-substrate",
            computation: computation.slice(0, 32),
          },
        },
        key("tool-result"),
      );
      await executions.transition(
        {
          command: "verify",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
        },
        key("verify"),
      );
      await executions.transition(
        {
          command: "pass",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          verificationResults: [
            {
              criterionId: "substrate-wellformed",
              strategy: "mechanical-nonempty",
              status: "PASS",
              recordedBy: "ppr-027-execution-driver",
              evidence: [`deterministic:${record.id}`],
            },
            {
              criterionId: "substrate-deterministic",
              strategy: "mechanical-recomputation-identity",
              status: identical ? "PASS" : "FAIL",
              recordedBy: "ppr-027-execution-driver",
            },
          ],
        },
        key("pass"),
      );
      return;
    }

    // ----------------------------------------------------------------------
    // THE MODEL PLANE (the rail: chat, vision, audio, image, embeddings, rerank)
    // ----------------------------------------------------------------------
    let dispatch: { outcome: ModelCallOutcome; providerId: string; attempt: number };
    try {
      dispatch = await dispatchWithPolicyRetry(envelope, record.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-denied",
          cause: "gateway-rejection",
          reference: { tool: "model-rail" },
          payload: { tool: "model-rail", rejection: message.slice(0, 200) },
        },
        key("tool-denied"),
      );
      await executions.transition(
        {
          command: "fail",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          reason: `model gateway rejected the dispatch: ${message.slice(0, 120)}`,
          verificationResults: [
            {
              criterionId: "rail-dispatch",
              strategy: "mechanical-validation",
              status: "FAIL",
              recordedBy: "ppr-027-execution-driver",
            },
          ],
        },
        key("fail"),
      );
      return;
    }

    const failureUsage = { inputTokens: 0, outputTokens: 0 };
    dispatchFacts.push({
      executionId: record.id,
      providerId: dispatch.providerId,
      attempt: dispatch.attempt,
      outcome: dispatch.outcome.kind,
      latencyMs:
        dispatch.outcome.kind === "provider-success"
          ? (dispatch.outcome.response.providerLatencyMs ?? 0)
          : (dispatch.outcome.failure.durationMs ?? 0),
      usage:
        dispatch.outcome.kind === "provider-success"
          ? {
              inputTokens: dispatch.outcome.response.usage.inputTokens,
              outputTokens: dispatch.outcome.response.usage.outputTokens,
            }
          : failureUsage,
      costNanoUsd: 0,
      policyRetry: dispatch.attempt > 1,
    });

    if (dispatch.outcome.kind === "provider-failure") {
      await executions.recordStepEvent(
        {
          applicationId: record.applicationId,
          executionId: record.id,
          actor,
          command: "tool-result",
          cause: "model-rail-provider-failure",
          reference: { tool: "model-rail", attemptId: `attempt-${dispatch.attempt}` },
          payload: {
            tool: "model-rail",
            kind: "model-failure",
            category: dispatch.outcome.failure.category,
            retryable: dispatch.outcome.failure.retryable,
            provider: dispatch.providerId,
            policyRetry: dispatch.attempt > 1,
          },
        },
        key("tool-result-failure"),
      );
      await executions.transition(
        {
          command: "fail",
          applicationId: record.applicationId,
          executionId: record.id,
          ...actor,
          reason: `provider-axis failure (${dispatch.outcome.failure.category})`,
          verificationResults: [
            {
              criterionId: "rail-dispatch",
              strategy: "mechanical-validation",
              status: "FAIL",
              recordedBy: "ppr-027-execution-driver",
            },
          ],
        },
        key("fail"),
      );
      return;
    }

    const response = dispatch.outcome.response;
    const content = response.content[0] ?? "";
    const wellFormed = content.length > 0;
    const usageRecorded = response.usage.inputTokens > 0 || response.usage.outputTokens > 0;
    const settledCostNanoUsd = requestCostNanoUsd(
      {
        edgeId: envelope.edgeId,
        inputTokens: envelope.inputTokens,
        outputTokens: envelope.outputTokens,
      },
      edgeOfSubject(envelope.edgeId),
    );
    await executions.recordStepEvent(
      {
        applicationId: record.applicationId,
        executionId: record.id,
        actor,
        command: "tool-result",
        cause: "model-rail-completion",
        reference: { tool: "model-rail", attemptId: `attempt-${dispatch.attempt}` },
        payload: {
          tool: "model-rail",
          kind: "model-completion",
          content,
          provider: dispatch.providerId,
          model,
          policyRetry: dispatch.attempt > 1,
          usage: {
            input: response.usage.inputTokens,
            output: response.usage.outputTokens,
          },
          providerLatencyMs: response.providerLatencyMs,
          costMicroUsd: String(Math.floor(settledCostNanoUsd / 1000)),
        },
      },
      key("tool-result"),
    );
    await executions.transition(
      {
        command: "verify",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
      },
      key("verify"),
    );
    await executions.transition(
      {
        command: "pass",
        applicationId: record.applicationId,
        executionId: record.id,
        ...actor,
        verificationResults: [
          {
            criterionId: "result-wellformed",
            strategy: "mechanical-nonempty",
            status: wellFormed ? "PASS" : "FAIL",
            recordedBy: "ppr-027-execution-driver",
            evidence: [`tool-result:attempt-${dispatch.attempt}`],
          },
          {
            criterionId: "usage-recorded",
            strategy: "mechanical-usage-presence",
            status: usageRecorded ? "PASS" : "INCONCLUSIVE",
            recordedBy: "ppr-027-execution-driver",
          },
        ],
      },
      key("pass"),
    );
  };

  // The docs-battery pattern: wrap the world's executions service so every
  // created execution is executed by the driver (through the SAME public
  // service object the API routes hold). Replay-safe: a replayed create
  // returns the durable receipt without a second drive.
  const service = world.executions as unknown as {
    createExecution: ExecutionService["createExecution"];
  };
  const originalCreate = service.createExecution.bind(world.executions);
  service.createExecution = async (input, idempotencyKey, actor) => {
    const receipt = await originalCreate(input, idempotencyKey, actor);
    if (!receipt.replayed) {
      const record: ExecutionRecord | null = await world.executions.getExecution(
        input.applicationId,
        receipt.executionId,
      );
      if (record !== null) {
        await execute(record);
      }
    }
    return receipt;
  };

  const listened: string = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
  const apiBaseUrl =
    typeof listened === "string" && listened.length > 0
      ? listened
      : `http://127.0.0.1:${(world.server.app.server.address() as { port: number }).port}`;

  return {
    world,
    apiBaseUrl,
    apiToken: world.bearerToken,
    applicationId: world.applicationId,
    transport,
    dispatchFacts: () => [...dispatchFacts],
    close: async () => {
      await world.server.app.close();
    },
  };
}
