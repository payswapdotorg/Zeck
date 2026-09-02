/**
 * Shared real-PostgreSQL fixture for the conversational messaging suite
 * (WORK-025).
 *
 * Extends the WORK-023 deployment-fabric world with the WORK-025
 * messaging fabric over the provider-neutral DatabasePort:
 *
 *   * conversations/messages/deliveries/escalations/operations:
 *     SqlMessagingStore (migration 0020);
 *   * provenance: the REAL messaging execution-ledger adapter over the
 *     REAL executions service (conversation-mapped executions are
 *     created and lifecycle-walked through the executions PUBLIC
 *     surface, and every turn/delivery/escalation/completion rides the
 *     real EventEnvelope ledger);
 *   * policy admission: the REAL policies engine (WORK-007) through the
 *     deployments module's policy-messaging adapter, with a default
 *     platform-allow document;
 *   * the upstream rail: the in-process simulated messaging rail (the
 *     provider-honesty stance — no external messaging-provider
 *     credentials exist in this environment; external behavior is
 *     UNVERIFIED and recorded as such in docs/work-items/WORK-025.md);
 *   * capability/budget/secret/router/responder seams: recording fakes
 *     (their PG behavior is owned by their own modules' suites; the
 *     durable-state proofs here need only deterministic toggles).
 */

import { createHash } from "node:crypto";
import type {
  DeploymentPlanInput,
  DeploymentProfileInput,
  MessagingActor,
  MessagingBudgetReserveCommand,
  MessagingCapabilityAdmissionRequest,
  MessagingConversationService,
  MessagingPolicyAdmissionRequest,
  MessagingRouteClass,
  MessagingSecretMediationRequest,
  MessagingTurnResponderRequest,
  MessagingTurnRouteRequest,
} from "../../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessMessagingRail,
  createMessagingConversationService,
  createMessagingExecutionLedgerAdapter,
  createModalityAdapterRegistry,
  createPolicyMessagingAdmission,
  createSqlEnvironmentResolver,
  SqlMessagingStore,
} from "../../../src/modules/deployments/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type DeploymentPgWorld, seedDeploymentWorld } from "./deployments-world";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** The neutral messaging profile body (the messaging modality). */
export const MESSAGING_PROFILE_BODY: DeploymentProfileInput = {
  profileId: "support-chat",
  modality: "messaging",
  channelKinds: ["web", "sms"],
  requiredCapabilities: ["messaging-conversation"],
  latencyClass: "asynchronous",
  resourceClass: "standard",
  sideEffectClass: "read-only",
  inputModalities: ["text"],
  outputModalities: ["text"],
};

export function messagingPlanBody(world: {
  readonly environmentId: string;
  readonly agentId: string;
}): DeploymentPlanInput {
  return {
    planId: "support-chat-plan",
    profileRef: { profileId: "support-chat", version: 1 },
    agentRef: { agentId: world.agentId, agentVersion: "1.0.0", agentKind: "zeck" },
    environmentId: world.environmentId,
    channelBindings: [
      { channelKind: "web", adapterCapabilityId: "messaging-channel-adapter" },
      { channelKind: "sms", adapterCapabilityId: "messaging-channel-adapter" },
    ],
    sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
  };
}

/** Recording fakes for the four admission seams + router + responder. */
class MessagingAdmissions {
  readonly policyCalls: MessagingPolicyAdmissionRequest[] = [];
  readonly capabilityCalls: MessagingCapabilityAdmissionRequest[] = [];
  readonly reserves: MessagingBudgetReserveCommand[] = [];
  readonly releases: Array<Record<string, unknown>> = [];
  readonly mediationCalls: MessagingSecretMediationRequest[] = [];
  readonly routerCalls: MessagingTurnRouteRequest[] = [];
  readonly responderCalls: MessagingTurnResponderRequest[] = [];
  unmetCapabilities: string[] = [];
  denyPolicy = false;
  denyAction: string | null = null;
  failBudget = false;
  refuseMediation = false;
  routeClass: MessagingRouteClass = "generative";

  readonly policy = {
    admit: async (request: MessagingPolicyAdmissionRequest) => {
      this.policyCalls.push(request);
      return this.denyPolicy || (this.denyAction !== null && this.denyAction === request.action)
        ? { allowed: false as const, reason: "fixture denial" }
        : { allowed: true as const };
    },
  };

  readonly capabilities = {
    resolve: async (request: MessagingCapabilityAdmissionRequest) => {
      this.capabilityCalls.push(request);
      return { satisfied: this.unmetCapabilities.length === 0, unmet: this.unmetCapabilities };
    },
  };

  readonly budget = {
    reserve: async (command: MessagingBudgetReserveCommand) => {
      this.reserves.push(command);
      if (this.failBudget) {
        throw new Error("fixture: budget exhausted (mapped by the adapter contract)");
      }
      // Key-convergent reservation (the REAL budgets module treats
      // operationId as the idempotency discriminator: a retried or
      // concurrent duplicate converges on the SAME reservation — the
      // crash-recovery proofs depend on that convergence).
      const existing = this.reservationsByOperation.get(command.operationId);
      if (existing !== undefined) {
        return { reservationId: existing, amountMicroUsd: "10000", converged: true };
      }
      const reservationId = `resv-${this.reserves.length}`;
      this.reservationsByOperation.set(command.operationId, reservationId);
      return {
        reservationId,
        amountMicroUsd: "10000",
        converged: false,
      };
    },
    settle: async () => ({ reservationId: "resv-x", settled: true }),
    release: async (command: Record<string, unknown>) => {
      this.releases.push(command);
      return { reservationId: "resv-x", released: true };
    },
  };

  private readonly reservationsByOperation = new Map<string, string>();

  readonly secrets = {
    mediate: async (request: MessagingSecretMediationRequest) => {
      this.mediationCalls.push(request);
      return this.refuseMediation
        ? { mediated: false as const, reason: "fixture connection inactive" }
        : { mediated: true as const, grantRef: "mediated:conn-1" };
    },
  };

  readonly router = {
    routeTurn: async (request: MessagingTurnRouteRequest) => {
      this.routerCalls.push(request);
      return {
        routeClass: this.routeClass,
        decisionOutcome:
          this.routeClass === "deterministic"
            ? ("sufficient" as const)
            : this.routeClass === "hybrid"
              ? ("uncertain" as const)
              : ("insufficient" as const),
        reasonCodes: ["fixture"],
        rationale: "fixture planner decision",
        estimatedCostMicroUsd: this.routeClass === "deterministic" ? null : "10000",
      };
    },
  };

  readonly responder = {
    respond: async (request: MessagingTurnResponderRequest) => {
      this.responderCalls.push(request);
      return {
        responseRef: "artifact:responses/1",
        responsePreview: "fixture answer",
        responseAttachments: [],
        actualCostMicroUsd: "0",
      };
    },
  };
}

export interface MessagingPgWorld {
  readonly db: DatabasePort;
  readonly base: DeploymentPgWorld;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly messagingStore: SqlMessagingStore;
  readonly service: MessagingConversationService;
  readonly rail: ReturnType<typeof createInProcessMessagingRail>;
  readonly admissions: MessagingAdmissions;
  /** The REAL policies authority behind the policy admission seam. */
  readonly policyAuthority: ReturnType<typeof createPolicyAuthority>;
  readonly actor: () => MessagingActor;
  /**
   * Boot (or re-boot) the messaging conversation service over the
   * SURVIVING world — the process-restart primitive for the
   * crash-injection proofs: the PG store, the executions ledger (PG),
   * the upstream rail (the external provider's idempotency-key ledger)
   * and the admission seams persist across a Zeck process death; a
   * `point` arms ONE durable-boundary crash (a method on
   * store/rail/ledger, before/after its durable commit) that kills the
   * booted process mid-flight.
   */
  readonly boot: (point?: CrashInjectionPoint | null) => {
    readonly service: MessagingConversationService;
    readonly crashed: () => boolean;
  };
}

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface CrashInjectionPoint {
  readonly target: "store" | "rail" | "ledger";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable/external seam so the booted process dies at the
 * planned point (`before` = the durable commit did not happen; `after`
 * = the commit / external side effect did). The wrapper records the
 * firing so a vacuous proof (a point the service never reaches) fails
 * its `crashed()` assertion.
 */
function crashableSeam<T extends object>(
  target: T,
  label: string,
  point: CrashInjectionPoint | null,
) {
  let fired = false;
  if (point === null || point.target !== label) {
    return { proxy: target, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, t);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`${label}.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

export async function seedMessagingWorld(db: DatabasePort): Promise<MessagingPgWorld> {
  const base = await seedDeploymentWorld(db);
  const actor = base.actor();

  // The messaging-fabric deployment service over the SAME SQL store with
  // the messaging modality adapter registered (plan validation is
  // fail-closed: an uncovered binding rejects the plan at validation
  // time, never at conversation time — the WORK-023 discipline).
  const sha = sha256Hex;
  const newId = createUuidv7Generator();
  const now = () => new Date();
  const adapters = createModalityAdapterRegistry();
  adapters.register({
    descriptor: {
      adapterCapabilityId: "messaging-channel-adapter",
      channelKinds: ["web", "in-app", "sms", "email"],
    },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind, adapter: "messaging" };
    },
  });
  const deploymentService = createDeploymentService({
    store: base.deploymentStore,
    agentInventory: {
      async findVersion(_applicationId, agentId, version) {
        return agentId === base.agentId && version === base.agentVersion
          ? {
              agentId,
              version,
              validationState: "valid" as const,
              agentStatus: "available" as const,
            }
          : null;
      },
    },
    environmentResolver: createSqlEnvironmentResolver(db),
    adapters,
    digest: sha,
    generateId: newId,
    now,
  });

  // Profile + plan v1/v2 + the deployment (active, pinned at v1).
  await deploymentService.publishProfile({ ...MESSAGING_PROFILE_BODY }, { version: 1 }, actor);
  await deploymentService.publishPlan(messagingPlanBody(base), { version: 1 }, actor);
  await deploymentService.publishPlan(
    {
      ...messagingPlanBody(base),
      sessionPolicy: { maxSessionDurationMs: 1_800_000, maxConcurrentSessions: 32 },
    },
    { version: 2 },
    actor,
  );
  const created = await deploymentService.createDeployment(
    {
      slug: "support-chat-prod",
      name: "Support chat (production)",
      environmentId: base.environmentId,
      agentId: base.agentId,
      agentVersion: base.agentVersion,
      agentKind: "zeck",
      planId: "support-chat-plan",
    },
    "messaging-create-deployment",
    actor,
  );

  // The REAL policies engine for the messaging admission seam.
  const authority = createPolicyAuthority({
    store: new InMemoryPolicyStore(),
    hasher: nodePolicyHasher,
  });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  const admissions = new MessagingAdmissions();
  const rail = createInProcessMessagingRail(["web", "in-app", "sms", "email"]);
  const messagingStore = new SqlMessagingStore(db);
  const ledger = createMessagingExecutionLedgerAdapter(base.executionService);
  const railConnectionRef = "connections:simulated-messaging-rail";
  const boot = (point: CrashInjectionPoint | null = null) => {
    const storeProcess = crashableSeam(messagingStore, "store", point);
    const railProcess = crashableSeam(rail, "rail", point);
    const ledgerProcess = crashableSeam(ledger, "ledger", point);
    const service = createMessagingConversationService({
      store: storeProcess.proxy,
      deployments: base.deploymentStore,
      rail: railProcess.proxy,
      policy: createPolicyMessagingAdmission(authority),
      capabilities: admissions.capabilities,
      budget: admissions.budget,
      secrets: admissions.secrets,
      router: admissions.router,
      responder: admissions.responder,
      ledger: ledgerProcess.proxy,
      railConnectionRef,
      digest: sha,
      generateId: newId,
      now,
    });
    return {
      service,
      crashed: () => storeProcess.crashed() || railProcess.crashed() || ledgerProcess.crashed(),
    };
  };

  return {
    db,
    base,
    tenantId: base.tenantId,
    applicationId: base.applicationId,
    environmentId: base.environmentId,
    deploymentId: created.deploymentId,
    messagingStore,
    service: boot().service,
    rail,
    admissions,
    policyAuthority: authority,
    actor: () => ({
      actorId: base.actor().actorId,
      applicationId: base.applicationId,
      tenantId: base.tenantId,
    }),
    boot,
  };
}

/** Start one messaging conversation on the world's deployment (v1 pin). */
export async function startMessagingConversation(
  world: MessagingPgWorld,
  suffix: string,
  overrides: {
    readonly channelKind?: "web" | "sms";
    readonly orderingMode?: "thread-sequenced" | "unordered";
  } = {},
): Promise<ReturnType<MessagingConversationService["startConversation"]>> {
  return world.service.startConversation(
    {
      deploymentId: world.deploymentId,
      channelKind: overrides.channelKind ?? "web",
      channelConversationRef: `channel-thread-${suffix}`,
      orderingMode: overrides.orderingMode,
    },
    `start-${suffix}`,
    world.actor(),
  );
}

/** One inbound user-message event on the conversation. */
export function userMessage(
  conversationId: string,
  eventKey: string,
  overrides: {
    readonly threadRef?: string;
    readonly threadSequence?: number;
  } = {},
): {
  readonly conversationId: string;
  readonly eventKey: string;
  readonly payloadRef: string;
  readonly payloadPreview: string;
  readonly subtaskKind: string;
  readonly threadRef?: string;
  readonly threadSequence?: number;
} {
  return {
    conversationId,
    eventKey,
    payloadRef: "artifact:inbound/1",
    payloadPreview: "customer question",
    subtaskKind: "mixed",
    ...(overrides.threadRef === undefined ? {} : { threadRef: overrides.threadRef }),
    ...(overrides.threadSequence === undefined ? {} : { threadSequence: overrides.threadSequence }),
  };
}
