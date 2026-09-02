/**
 * Unit tests — the messaging conversation service over the in-memory world
 * (WORK-025, MOD-008/009; the runtime halves of the acceptance criteria
 * and the required safety proofs).
 *
 * The world: the REAL deployment fabric (InMemoryDeploymentStore +
 * createDeploymentService) + the REAL in-memory messaging store + the REAL
 * in-process simulated messaging rail + recording fakes for the five
 * admission seams (policy/capability/budget/secrets/router) and the
 * responder, and an in-memory execution-ledger fake that models the
 * executions public seam's contract (idempotent open, sequenced evidence,
 * wait-human transitions). The fakes record every call into a SHARED
 * ORDERED LOG so the policy-before-send proofs are mechanically
 * observable, and the rail is wrapped with a logging proxy for the same
 * purpose.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentPlanInput,
  DeploymentProfileInput,
  MessagingActor,
  MessagingBudgetReserveCommand,
  MessagingCapabilityAdmissionRequest,
  MessagingConversationService,
  MessagingConversationServiceDeps,
  MessagingEvidenceInput,
  MessagingExecutionLedger,
  MessagingExecutionOpenInput,
  MessagingInboundEventInput,
  MessagingOperationKind,
  MessagingPolicyAdmissionRequest,
  MessagingRouteClass,
  MessagingSecretMediationRequest,
  MessagingTurnResponderRequest,
  MessagingTurnRouteRequest,
  StartMessagingConversationInput,
} from "../../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessMessagingRail,
  createMessagingConversationService,
  createModalityAdapterRegistry,
  InMemoryDeploymentStore,
  InMemoryMessagingStore,
  messagingOperationKey,
} from "../../../src/modules/deployments/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Structural view of a typed input (evidence inspection helper). */
const struct = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const ACTOR: MessagingActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const OTHER_TENANT_ACTOR: MessagingActor = {
  actorId: "00000000-0000-7000-8000-0000000000f1",
  applicationId: ACTOR.applicationId,
  tenantId: "00000000-0000-7000-8000-0000000000f3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

const PROFILE: DeploymentProfileInput = {
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

const planInput = (overrides: Partial<DeploymentPlanInput> = {}): DeploymentPlanInput => ({
  planId: "support-chat-plan",
  profileRef: { profileId: "support-chat", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" as const },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "messaging-channel-adapter" },
    { channelKind: "sms", adapterCapabilityId: "messaging-channel-adapter" },
  ],
  sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
  ...overrides,
});

const CREATION: CreateDeploymentInput = {
  slug: "support-chat-prod",
  name: "Support chat",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck" as const,
  planId: "support-chat-plan",
};

// ---------------------------------------------------------------------------
// The recording fakes (the five admission seams + the responder; the
// executions-ledger in-memory model). Every call lands in the SHARED
// ORDERED LOG so the admission-before-side-effect proofs are mechanical.
// ---------------------------------------------------------------------------

class CallLog {
  readonly entries: string[] = [];
  push(label: string) {
    this.entries.push(label);
  }
  /** The first index of a label (-1 when absent). */
  index(label: string): number {
    return this.entries.indexOf(label);
  }
}

class FakePolicyAdmission {
  readonly calls: MessagingPolicyAdmissionRequest[] = [];
  deny = false;
  denyAction: string | null = null;
  constructor(private readonly log: CallLog) {}
  async admit(request: MessagingPolicyAdmissionRequest) {
    this.calls.push(request);
    this.log.push("policy");
    if (this.deny || (this.denyAction !== null && this.denyAction === request.action)) {
      return { allowed: false as const, reason: "fixture denial" };
    }
    return {
      allowed: true as const,
      evidence: {
        policySetId: "ps-1",
        policySetVersion: 1,
        policyContentHash: "hash-1",
        restrictionSetDigest: "digest-1",
      },
    };
  }
}

class FakeCapabilityAdmission {
  readonly calls: MessagingCapabilityAdmissionRequest[] = [];
  unmet: string[] = [];
  constructor(private readonly log: CallLog) {}
  async resolve(request: MessagingCapabilityAdmissionRequest) {
    this.calls.push(request);
    this.log.push("capability");
    return { satisfied: this.unmet.length === 0, unmet: this.unmet };
  }
}

class FakeBudgetAdmission {
  readonly reserves: MessagingBudgetReserveCommand[] = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly releases: Array<Record<string, unknown>> = [];
  failReserve = false;
  private seq = 0;
  private readonly reservationsByOperation = new Map<string, string>();
  constructor(private readonly log: CallLog) {}
  async reserve(command: MessagingBudgetReserveCommand) {
    this.log.push("budget-reserve");
    // Key-convergent reservation (the REAL budgets module treats
    // operationId as the idempotency discriminator).
    const existing = this.reservationsByOperation.get(command.operationId);
    if (existing !== undefined) {
      return { reservationId: existing, amountMicroUsd: "10000", converged: true };
    }
    this.reserves.push(command);
    if (this.failReserve) {
      throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted budget" });
    }
    this.seq += 1;
    const reservationId = `resv-${this.seq}`;
    this.reservationsByOperation.set(command.operationId, reservationId);
    return { reservationId, amountMicroUsd: "10000", converged: false };
  }
  async settle(input: Record<string, unknown>) {
    this.settles.push(input);
    this.log.push("budget-settle");
    return { reservationId: "resv-latest", settled: true };
  }
  async release(input: Record<string, unknown>) {
    this.releases.push(input);
    this.log.push("budget-release");
    return { reservationId: "resv-latest", released: true };
  }
}

class FakeSecretMediation {
  readonly calls: MessagingSecretMediationRequest[] = [];
  refuse = false;
  constructor(private readonly log: CallLog) {}
  async mediate(request: MessagingSecretMediationRequest) {
    this.calls.push(request);
    this.log.push("secrets");
    if (this.refuse) {
      return { mediated: false as const, reason: "fixture connection inactive" };
    }
    return { mediated: true as const, grantRef: "mediated:conn-1:cred" };
  }
}

class FakeRouter {
  readonly calls: MessagingTurnRouteRequest[] = [];
  routeClass: MessagingRouteClass = "generative";
  constructor(private readonly log: CallLog) {}
  async routeTurn(request: MessagingTurnRouteRequest) {
    this.calls.push(request);
    this.log.push("router");
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
  }
}

class FakeResponder {
  readonly calls: MessagingTurnResponderRequest[] = [];
  constructor(private readonly log: CallLog) {}
  async respond(request: MessagingTurnResponderRequest) {
    this.calls.push(request);
    this.log.push("responder");
    return {
      responseRef: "artifact:responses/1",
      responsePreview: "fixture deterministic answer",
      responseAttachments: ["artifact:attachments/1"],
      actualCostMicroUsd: "0",
    };
  }
}

/** In-memory model of the executions public seam (the ledger port). */
class FakeExecutionLedger implements MessagingExecutionLedger {
  readonly opened: Array<{ key: string; input: MessagingExecutionOpenInput }> = [];
  readonly evidence: Array<{ key: string; input: MessagingEvidenceInput }> = [];
  readonly humanWaits: Array<{ key: string; input: Record<string, unknown> }> = [];
  readonly resumes: Array<{ key: string; input: Record<string, unknown> }> = [];
  private readonly executions = new Map<string, string>();
  private readonly evidenceKeys = new Set<string>();
  private readonly humanWaitKeys = new Set<string>();
  private seq = 0;
  private nextExecution = 0;
  constructor(private readonly log: CallLog) {}
  async openExecution(input: MessagingExecutionOpenInput, idempotencyKey: string) {
    this.log.push("execution-open");
    const existing = this.executions.get(idempotencyKey);
    if (existing !== undefined) {
      return { executionId: existing, replayed: true, status: "running" };
    }
    this.nextExecution += 1;
    const executionId = `00000000-0000-7000-8000-${String(this.nextExecution).padStart(12, "0")}`;
    this.executions.set(idempotencyKey, executionId);
    this.opened.push({ key: idempotencyKey, input });
    return { executionId, replayed: false, status: "running" };
  }
  async recordEvidence(input: MessagingEvidenceInput, idempotencyKey: string) {
    this.log.push("ledger-evidence");
    const replayed = this.evidenceKeys.has(idempotencyKey);
    this.evidenceKeys.add(idempotencyKey);
    this.seq += 1;
    if (!replayed) {
      this.evidence.push({ key: idempotencyKey, input });
    }
    return { sequence: this.seq, type: "agent-action-recorded", replayed };
  }
  async readExecution(_applicationId: string, executionId: string) {
    const existing = [...this.executions.values()].find((id) => id === executionId);
    return existing === undefined
      ? null
      : { id: existing, tenantId: ACTOR.tenantId, status: "running" };
  }
  async awaitHuman(input: Record<string, unknown>, idempotencyKey: string) {
    this.log.push("wait-human");
    const replayed = this.humanWaitKeys.has(idempotencyKey);
    this.humanWaitKeys.add(idempotencyKey);
    if (!replayed) {
      this.humanWaits.push({ key: idempotencyKey, input });
    }
    this.seq += 1;
    return { sequence: this.seq, replayed };
  }
  async continueAfterHuman(input: Record<string, unknown>, _idempotencyKey: string) {
    this.resumes.push({ key: _idempotencyKey, input });
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
}

interface MessagingWorld {
  readonly service: MessagingConversationService;
  readonly store: InMemoryMessagingStore;
  readonly rail: ReturnType<typeof createInProcessMessagingRail>;
  readonly policy: FakePolicyAdmission;
  readonly capabilities: FakeCapabilityAdmission;
  readonly budget: FakeBudgetAdmission;
  readonly secrets: FakeSecretMediation;
  readonly router: FakeRouter;
  readonly responder: FakeResponder;
  readonly ledger: FakeExecutionLedger;
  readonly log: CallLog;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
}

/** Wrap the rail so every side-effecting call lands in the ordered log. */
function loggingRail(
  rail: ReturnType<typeof createInProcessMessagingRail>,
  log: CallLog,
): ReturnType<typeof createInProcessMessagingRail> {
  return new Proxy(rail, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (
        typeof prop === "string" &&
        ["openConversation", "sendMessage", "escalate", "closeConversation"].includes(prop) &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          log.push(`rail-${prop}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
}

function buildWorld(): MessagingWorld {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  for (const [capability, kinds] of [
    ["messaging-channel-adapter", ["web", "in-app", "sms", "email"]],
  ] as const) {
    registry.register({
      descriptor: { adapterCapabilityId: capability, channelKinds: [...kinds] },
      async checkBinding() {
        return { ok: true };
      },
      async describeBinding(binding) {
        return { channelKind: binding.channelKind };
      },
    });
  }
  let idSeq = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++idSeq).padStart(12, "0")}`;
  const deploymentService = createDeploymentService({
    store: deploymentStore,
    agentInventory: {
      async findVersion(_applicationId, agentId, version) {
        return agentId === AGENT_ID && version === "1.0.0"
          ? {
              agentId,
              version,
              validationState: "valid" as const,
              agentStatus: "available" as const,
            }
          : null;
      },
    },
    environmentResolver: {
      async resolve(applicationId, environmentId) {
        return environmentId === ENV_ID
          ? { environmentId, applicationId, tenantId: ACTOR.tenantId }
          : null;
      },
    },
    adapters: registry,
    digest,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  const store = new InMemoryMessagingStore();
  const rail = createInProcessMessagingRail(["web", "in-app", "sms", "email"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const log = new CallLog();
  const policy = new FakePolicyAdmission(log);
  const capabilities = new FakeCapabilityAdmission(log);
  const budget = new FakeBudgetAdmission(log);
  const secrets = new FakeSecretMediation(log);
  const router = new FakeRouter(log);
  const responder = new FakeResponder(log);
  const ledger = new FakeExecutionLedger(log);

  const deps: MessagingConversationServiceDeps = {
    store,
    deployments: deploymentStore,
    rail: loggingRail(rail, log),
    policy,
    capabilities,
    budget,
    secrets,
    router,
    responder,
    ledger,
    railConnectionRef: "conn-rail-1",
    digest,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  const service = createMessagingConversationService(deps);
  return {
    service,
    store,
    rail,
    policy,
    capabilities,
    budget,
    secrets,
    router,
    responder,
    ledger,
    log,
    deploymentService,
    deploymentId: "",
  };
}

async function seededWorld(): Promise<MessagingWorld> {
  const world = buildWorld();
  const actor = { ...ACTOR };
  await world.deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
  await world.deploymentService.publishPlan(planInput(), { version: 1 }, actor);
  const created = await world.deploymentService.createDeployment(
    { ...CREATION },
    "deploy-key-0",
    actor,
  );
  world.deploymentId = created.deploymentId;
  // Plan v2 exists (for promotion/pinning proofs).
  await world.deploymentService.publishPlan(
    planInput({
      sessionPolicy: { maxSessionDurationMs: 1_800_000, maxConcurrentSessions: 32 },
    }),
    { version: 2 },
    actor,
  );
  return world;
}

const startInput = (overrides: Record<string, unknown> = {}): StartMessagingConversationInput =>
  ({
    deploymentId: "00000000-0000-0000-0000-000000000000", // replaced per-world below
    channelKind: "web",
    ...overrides,
  }) as StartMessagingConversationInput;

async function startConversation(
  world: MessagingWorld,
  key = "start-1",
  actor: MessagingActor = ACTOR,
  overrides: Record<string, unknown> = {},
) {
  return world.service.startConversation(
    { ...startInput(overrides), deploymentId: world.deploymentId },
    key,
    actor,
  );
}

const userEvent = (
  conversationId: string,
  eventKey: string,
  overrides: Record<string, unknown> = {},
): MessagingInboundEventInput =>
  ({
    conversationId,
    eventKey,
    payloadRef: "artifact:inbound/1",
    payloadPreview: "customer question",
    ...overrides,
  }) as MessagingInboundEventInput;

const operation = (world: MessagingWorld, kind: MessagingOperationKind, discriminator: string) =>
  world.store.findMessagingOperation(
    ACTOR.applicationId,
    messagingOperationKey(kind, discriminator),
  );

const railRecords = (world: MessagingWorld, kind: string) =>
  world.rail.sends.filter((record) => record.kind === kind);

describe("startConversation (the governed conversation birth)", () => {
  test("the happy path: tenant scope → pin → policy → execution → rail open → durable rows → provenance → completion", async () => {
    const world = await seededWorld();
    const outcome = await startConversation(world, "start-1");
    expect(outcome.channelConversationRef).toBe("simmsg-conversation-1");
    expect(outcome.orderingMode).toBe("unordered");
    expect(outcome.pinnedPlanVersion).toBe(1);
    expect(outcome.replayed).toBe(false);
    // Exactly ONE upstream conversation (AC2/AC5: the single external effect).
    expect(railRecords(world, "open")).toHaveLength(1);
    // The durable conversation row is bound to tenant + deployment + pin + execution (AC3).
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      outcome.conversationId,
    );
    expect(conversation?.tenantId).toBe(ACTOR.tenantId);
    expect(conversation?.deploymentId).toBe(world.deploymentId);
    expect(conversation?.pinnedPlanVersion).toBe(1);
    expect(conversation?.executionId).toBe(outcome.executionId);
    expect(conversation?.status).toBe("active");
    // The conversation-start provenance rode the executions ledger (AC6).
    expect(
      world.ledger.evidence.some(
        (entry) => String(struct(entry.input).evidenceClass) === "conversation-started",
      ),
    ).toBe(true);
    // The durable operation completed with the honest attempts ledger.
    expect(await operation(world, "conversation-start", "start-1")).toMatchObject({
      status: "completed",
      attempts: 1,
    });
    // The marker row exists with the ledger linkage.
    const messages = await world.service.listMessages(ACTOR.applicationId, outcome.conversationId);
    expect(messages.some((message) => message.eventKey === "start-1:conversation-started")).toBe(
      true,
    );
  });

  test("the admission order: policy admission happens BEFORE the rail open and the execution identity", async () => {
    const world = await seededWorld();
    await startConversation(world, "start-order");
    expect(world.log.index("policy")).toBeGreaterThanOrEqual(0);
    expect(world.log.index("policy")).toBeLessThan(world.log.index("rail-openConversation"));
  });

  test("idempotent replay: the same key converges on the SAME conversation + execution (never a second one)", async () => {
    const world = await seededWorld();
    const first = await startConversation(world, "start-2");
    const second = await startConversation(world, "start-2");
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.openedConversations).toBe(1);
    expect(world.ledger.opened).toHaveLength(1);
    // No second marker row.
    const messages = await world.service.listMessages(ACTOR.applicationId, first.conversationId);
    expect(
      messages.filter((message) => message.eventKey === "start-2:conversation-started"),
    ).toHaveLength(1);
  });

  test("key reuse with a different body fails closed (IDEMPOTENCY_KEY_REUSED)", async () => {
    const world = await seededWorld();
    await startConversation(world, "start-3");
    await expect(
      startConversation(world, "start-3", ACTOR, { channelKind: "sms" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("a wrong-tenant actor cannot start on another tenant's deployment (TENANT_SCOPE_VIOLATION)", async () => {
    const world = await seededWorld();
    await expect(startConversation(world, "start-4", OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    expect(railRecords(world, "open")).toHaveLength(0);
  });

  test("policy denial happens BEFORE every side effect (no rail open, no execution, no conversation row)", async () => {
    const world = await seededWorld();
    world.policy.deny = true;
    await expect(startConversation(world, "start-5")).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(railRecords(world, "open")).toHaveLength(0);
    expect(world.ledger.opened).toHaveLength(0);
    expect(await world.store.findConversationByStartKey(ACTOR.applicationId, "start-5")).toBeNull();
    // The WORK-024 house pattern: the durable operation claim precedes
    // admission, so the denial leaves the row PENDING (no checkpoint, no
    // outcome) — a retry re-runs admission and denies again (deterministic,
    // zero side effects either way).
    const denied = await operation(world, "conversation-start", "start-5");
    expect(denied?.status).toBe("pending");
    expect(denied?.checkpoint).toBeNull();
    await expect(startConversation(world, "start-5")).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(railRecords(world, "open")).toHaveLength(0);
    expect(world.ledger.opened).toHaveLength(0);
  });

  test("a non-active deployment rejects new conversations (INVALID_STATE_TRANSITION)", async () => {
    const world = await seededWorld();
    const _actor = { ...ACTOR };
    await world.deploymentService.suspendDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "suspend-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    await expect(startConversation(world, "start-6")).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("version pinning: promotion moves the pointer for NEW conversations only", async () => {
    const world = await seededWorld();
    const before = await startConversation(world, "start-pin-1");
    await world.deploymentService.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "promote-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const after = await startConversation(world, "start-pin-2");
    expect(after.pinnedPlanVersion).toBe(2);
    const first = await world.store.findConversation(ACTOR.applicationId, before.conversationId);
    expect(first?.pinnedPlanVersion).toBe(1);
    expect(first?.executionId).toBe(before.executionId);
  });

  test("the declared ordering semantics ride the conversation (thread-sequenced channel contract)", async () => {
    const world = await seededWorld();
    const outcome = await startConversation(world, "start-ordering", ACTOR, {
      orderingMode: "thread-sequenced",
    });
    expect(outcome.orderingMode).toBe("thread-sequenced");
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      outcome.conversationId,
    );
    expect(conversation?.orderingMode).toBe("thread-sequenced");
  });

  test("a caller-supplied rail conversation reference is bound (the channel coordinate)", async () => {
    const world = await seededWorld();
    const outcome = await startConversation(world, "start-ref", ACTOR, {
      channelConversationRef: "channel-thread-42",
    });
    expect(outcome.channelConversationRef).toBe("channel-thread-42");
    // A SECOND conversation cannot bind the same channel coordinate.
    await expect(
      startConversation(world, "start-ref-2", ACTOR, {
        channelConversationRef: "channel-thread-42",
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

describe("ingestInboundEvent (the governed turn: ordering evidence + admission + reply)", () => {
  async function startedConversation(world: MessagingWorld, key = "start-t") {
    return startConversation(world, key);
  }

  test("the happy generative path: the FULL admission chain in the frozen order, then the send, then provenance", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    // Isolate this turn's calls in the ordered log.
    world.log.entries.length = 0;
    const ingest = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-1"),
      ACTOR,
    );
    expect(ingest.eventKey).toBe("evt-1");
    expect(ingest.routeClass).toBe("generative");
    expect(ingest.reply?.messageKey).toBe("evt-1:reply");
    expect(ingest.reply?.deliveryStatus).toBe("sent");
    expect(ingest.replayed).toBe(false);
    // Exactly ONE upstream send (the rail send ledger).
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(railRecords(world, "send")[0]?.messageKey).toBe("evt-1:reply");
    // The frozen admission order (policy → capability → budget → secrets → responder → send).
    const order = {
      policy: world.log.index("policy"),
      capability: world.log.index("capability"),
      budget: world.log.index("budget-reserve"),
      secrets: world.log.index("secrets"),
      responder: world.log.index("responder"),
      send: world.log.index("rail-sendMessage"),
    };
    for (const [a, b] of [
      ["policy", "capability"],
      ["capability", "budget"],
      ["budget", "secrets"],
      ["secrets", "responder"],
      ["responder", "send"],
    ] as const) {
      expect(order[a], `${a} must precede ${b}`).toBeGreaterThanOrEqual(0);
      expect(order[a]).toBeLessThan(order[b]);
    }
    // The reply row carries the ledger linkage + route class + provenance chain (AC6).
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-1:reply",
    );
    expect(reply?.kind).toBe("agent-reply");
    expect(reply?.routeClass).toBe("generative");
    expect(reply?.replyToEventKey).toBe("evt-1");
    expect(reply?.ledgerSequence).toBe(ingest.reply?.ledgerSequence);
    expect(reply?.payloadRef).toBe("artifact:responses/1");
    expect(reply?.attachments).toEqual(["artifact:attachments/1"]);
    // The turn evidence rode the canonical executions ledger.
    expect(
      world.ledger.evidence.some(
        (entry) => entry.key === `messaging:message:${started.conversationId}:evt-1`,
      ),
    ).toBe(true);
    // The durable operation completed.
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-1`)).toMatchObject({
      status: "completed",
      attempts: 1,
    });
    // The budget settled after the send.
    expect(world.budget.settles).toHaveLength(1);
  });

  test("a deterministic route: no budget reservation, no paid dispatch, the reply still sends", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    world.router.routeClass = "deterministic";
    const ingest = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-det"),
      ACTOR,
    );
    expect(ingest.routeClass).toBe("deterministic");
    expect(world.budget.reserves).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(1);
    expect(railRecords(world, "send")).toHaveLength(1);
  });

  test("duplicate inbound events converge: no second side effect, the recorded outcome replays", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    const first = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-dup"),
      ACTOR,
    );
    const second = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-dup"),
      ACTOR,
    );
    expect(second.replayed).toBe(true);
    expect(second.reply?.messageKey).toBe(first.reply?.messageKey);
    // EXACTLY ONE upstream send and ONE responder invocation across the duplicate.
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.rail.acceptedSends).toBe(1);
    expect(world.responder.calls).toHaveLength(1);
    // The message ledger holds one inbound row and one reply row.
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((m) => m.eventKey === "evt-dup")).toHaveLength(1);
    expect(messages.filter((m) => m.eventKey === "evt-dup:reply")).toHaveLength(1);
  });

  test("concurrent duplicates of one event: exactly one send, one durable effect set (the idempotency ledger arbitrates)", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    const outcomes = await Promise.allSettled([
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-race"), ACTOR),
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-race"), ACTOR),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    // Exactly ONE upstream send per stable key — the side-effect invariant.
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.rail.acceptedSends).toBe(1);
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((m) => m.eventKey === "evt-race")).toHaveLength(1);
    expect(messages.filter((m) => m.eventKey === "evt-race:reply")).toHaveLength(1);
    // The turn operation completed exactly once (terminal; the honest winner).
    const op = await operation(world, "turn-reply", `${started.conversationId}:evt-race`);
    expect(op?.status).toBe("completed");
  });

  test("the SAME event key on ANOTHER conversation is a different logical turn (conversation-scoped keys)", async () => {
    const world = await seededWorld();
    const startedA = await startedConversation(world, "start-scope-a");
    const startedB = await startedConversation(world, "start-scope-b");
    const a = await world.service.ingestInboundEvent(
      userEvent(startedA.conversationId, "evt-shared"),
      ACTOR,
    );
    const b = await world.service.ingestInboundEvent(
      userEvent(startedB.conversationId, "evt-shared"),
      ACTOR,
    );
    expect(a.eventKey).toBe("evt-shared");
    expect(b.eventKey).toBe("evt-shared");
    expect(a.reply).not.toBeNull();
    expect(b.reply).not.toBeNull();
    // Two DIFFERENT durable operations (no false convergence) and two sends.
    expect(railRecords(world, "send")).toHaveLength(2);
    expect(
      await operation(world, "turn-reply", `${startedA.conversationId}:evt-shared`),
    ).toMatchObject({ status: "completed" });
    expect(
      await operation(world, "turn-reply", `${startedB.conversationId}:evt-shared`),
    ).toMatchObject({ status: "completed" });
  });

  test("a same-key/different-body replay fails closed (the poisoned-replay discipline)", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-poison", { payloadPreview: "first body" }),
      ACTOR,
    );
    await expect(
      world.service.ingestInboundEvent(
        userEvent(started.conversationId, "evt-poison", { payloadPreview: "different body" }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("a wrong-tenant actor cannot ingest into another tenant's conversation", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    await expect(
      world.service.ingestInboundEvent(
        userEvent(started.conversationId, "evt-tenant"),
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(railRecords(world, "send")).toHaveLength(0);
  });

  test("policy denial happens BEFORE the send, the responder and the budget (journal-then-fail on both ledgers)", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    world.policy.denyAction = "message-send";
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-denied"), ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(railRecords(world, "send")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(0);
    // The denial is durably recorded (journal-then-fail) on both ledgers.
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(
      messages.some(
        (message) =>
          message.kind === "system-marker" &&
          message.eventKey === `denial:${started.conversationId}:evt-denied`,
      ),
    ).toBe(true);
    expect(
      world.ledger.evidence.some(
        (entry) => String(struct(entry.input).evidenceClass) === "significant-action",
      ),
    ).toBe(true);
  });

  test("a missing capability cannot send (before the responder and the rail)", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    world.capabilities.unmet = ["messaging-conversation"];
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-cap"), ACTOR),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(railRecords(world, "send")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
  });

  test("a denied budget prevents the paid send (the reservation failure is typed and journaled)", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    world.budget.failReserve = true;
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-budget"), ACTOR),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(railRecords(world, "send")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(
      messages.some(
        (message) => message.eventKey === `denial:${started.conversationId}:evt-budget`,
      ),
    ).toBe(true);
  });

  test("refused secret mediation fails closed with the reservation released (before the send)", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    world.secrets.refuse = true;
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-secret"), ACTOR),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(railRecords(world, "send")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    // The reserved amount was released (no leak).
    expect(world.budget.releases).toHaveLength(1);
  });

  test("a rail send refusal records the terminal failure on both ledgers; a retry REPLAYS the recorded failure", async () => {
    const world = await seededWorld();
    const started = await startedConversation(world);
    world.rail.failNextSend("fixture carrier refusal");
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-refused"), ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    // The reply row is appended with the recorded undelivered outcome.
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-refused:reply",
    );
    expect(reply?.deliveryStatus).toBe("undelivered");
    // The operation durably FAILED.
    expect(
      await operation(world, "turn-reply", `${started.conversationId}:evt-refused`),
    ).toMatchObject({ status: "failed" });
    // A retry under the same key replays the recorded failure (no second send attempt).
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-refused"), ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(railRecords(world, "send")).toHaveLength(0);
  });

  test("thread-sequenced ordering evidence: in-order, out-of-order and gap markers are deterministic (AC4)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-seq", ACTOR, {
      orderingMode: "thread-sequenced",
    });
    const first = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "seq-1", { threadRef: "t1", threadSequence: 1 }),
      ACTOR,
    );
    expect(first.orderingMarker).toBe("in-order");
    const second = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "seq-2", { threadRef: "t1", threadSequence: 2 }),
      ACTOR,
    );
    expect(second.orderingMarker).toBe("in-order");
    // Out-of-order: an already-seen sequence arrives late.
    const late = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "seq-3", { threadRef: "t1", threadSequence: 1 }),
      ACTOR,
    );
    expect(late.orderingMarker).toBe("out-of-order");
    // Gap: a sequence beyond max+1.
    const gap = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "seq-4", { threadRef: "t1", threadSequence: 9 }),
      ACTOR,
    );
    expect(gap.orderingMarker).toBe("gap");
    // Ordering is EVIDENCE, never a block: every message produced its reply.
    expect(railRecords(world, "send")).toHaveLength(4);
  });

  test("unordered channels assign the deterministic arrival ordinal (never an assumed global order)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-unseq");
    const first = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "ord-1", { threadSequence: 999 }),
      ACTOR,
    );
    expect(first.orderingMarker).toBe("assigned");
    const second = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "ord-2", { threadSequence: 42 }),
      ACTOR,
    );
    expect(second.orderingMarker).toBe("assigned");
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.find((m) => m.eventKey === "ord-1")?.threadSequence).toBe(1);
    expect(messages.find((m) => m.eventKey === "ord-2")?.threadSequence).toBe(2);
  });

  test("a closed conversation rejects NEW inbound events (terminal guard) while replays converge", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-close");
    await world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-before"), ACTOR);
    await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-1",
      ACTOR,
    );
    await expect(
      world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-after"), ACTOR),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // The replay of the pre-close event converges.
    const replay = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-before"),
      ACTOR,
    );
    expect(replay.replayed).toBe(true);
    expect(railRecords(world, "send")).toHaveLength(1);
  });

  test("attachments ride artifact references; the turn request carries the bounded turn payload (never bytes)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-attach");
    await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-attach", {
        attachments: ["artifact:inbound/attach-1", "artifact:inbound/attach-2"],
      }),
      ACTOR,
    );
    const request = world.responder.calls[0];
    expect(request?.turnAttachments).toEqual([
      "artifact:inbound/attach-1",
      "artifact:inbound/attach-2",
    ]);
    expect(request?.turnPayloadRef).toBe("artifact:inbound/1");
    const inbound = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-attach",
    );
    expect(inbound?.attachments).toEqual([
      "artifact:inbound/attach-1",
      "artifact:inbound/attach-2",
    ]);
  });
});

describe("applyDeliveryStatus (correlation-guarded, idempotent delivery evidence)", () => {
  async function conversationWithReply(world: MessagingWorld, eventKey = "evt-del") {
    const started = await startConversation(world, "start-del");
    const ingest = await world.service.ingestInboundEvent(
      userEvent(started.conversationId, eventKey),
      ACTOR,
    );
    return { started, ingest };
  }

  test("the happy path: the callback applies the forward projection + evidence + provenance (AC3/AC6)", async () => {
    const world = await seededWorld();
    const { started, ingest } = await conversationWithReply(world);
    const applied = await world.service.applyDeliveryStatus(
      {
        conversationId: started.conversationId,
        messageKey: "evt-del:reply",
        status: "delivered",
        detail: "accepted by carrier",
      },
      ACTOR,
    );
    expect(applied.deliveryStatus).toBe("delivered");
    expect(applied.replayed).toBe(false);
    expect(applied.ledgerSequence).toBeGreaterThan(0);
    // The reply projection moved forward.
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-del:reply",
    );
    expect(reply?.deliveryStatus).toBe("delivered");
    expect(reply?.deliveredAt).not.toBeNull();
    // The evidence row references the originating message and execution.
    const deliveries = await world.service.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.messageId).toBe(reply?.id);
    expect(deliveries[0]?.fromStatus).toBe("sent");
    expect(deliveries[0]?.toStatus).toBe("delivered");
    // The delivery provenance rode the executions ledger.
    expect(
      world.ledger.evidence.some(
        (entry) =>
          entry.key ===
          `messaging:delivery:${started.conversationId}:dlv-${started.conversationId}-evt-del:reply-delivered`,
      ),
    ).toBe(true);
    // The delivery-apply operation completed.
    expect(
      await operation(
        world,
        "delivery-apply",
        `${started.conversationId}:dlv-${started.conversationId}-evt-del:reply-delivered`,
      ),
    ).toMatchObject({ status: "completed", attempts: 1 });
    expect(ingest.reply?.deliveryStatus).toBe("sent");
  });

  test("duplicate callbacks converge: one evidence row, no second projection move", async () => {
    const world = await seededWorld();
    const { started } = await conversationWithReply(world);
    await world.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-del:reply", status: "delivered" },
      ACTOR,
    );
    const replay = await world.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-del:reply", status: "delivered" },
      ACTOR,
    );
    expect(replay.replayed).toBe(true);
    const deliveries = await world.service.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(deliveries).toHaveLength(1);
  });

  test("a callback cannot mutate ANOTHER conversation's message (cross-conversation correlation fails closed)", async () => {
    const world = await seededWorld();
    await conversationWithReply(world);
    const other = await startConversation(world, "start-del-other");
    await expect(
      world.service.applyDeliveryStatus(
        { conversationId: other.conversationId, messageKey: "evt-del:reply", status: "delivered" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("a mismatched rail message reference fails closed (the correlation guard)", async () => {
    const world = await seededWorld();
    const { started } = await conversationWithReply(world);
    await expect(
      world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-del:reply",
          channelMessageRef: "simmsg-message-999",
          status: "delivered",
        },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("a STALE callback records its evidence but cannot regress the projection (monotonic vocabulary)", async () => {
    const world = await seededWorld();
    const { started } = await conversationWithReply(world);
    await world.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-del:reply", status: "delivered" },
      ACTOR,
    );
    const stale = await world.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-del:reply", status: "sent" },
      ACTOR,
    );
    // The evidence row exists; the projection stays terminal.
    expect(stale.deliveryStatus).toBe("delivered");
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-del:reply",
    );
    expect(reply?.deliveryStatus).toBe("delivered");
    const deliveries = await world.service.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(deliveries).toHaveLength(2);
  });

  test("a callback for a non-outbound message key fails closed (inbound messages never carry delivery)", async () => {
    const world = await seededWorld();
    const { started } = await conversationWithReply(world);
    await expect(
      world.service.applyDeliveryStatus(
        { conversationId: started.conversationId, messageKey: "evt-del", status: "delivered" },
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("a wrong-tenant actor cannot apply a callback to another tenant's conversation", async () => {
    const world = await seededWorld();
    const { started } = await conversationWithReply(world);
    await expect(
      world.service.applyDeliveryStatus(
        {
          conversationId: started.conversationId,
          messageKey: "evt-del:reply",
          status: "delivered",
        },
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});

describe("escalateToHuman (the governed escalation step)", () => {
  test("the happy path: policy-designated, the execution wait-human step, the rail notice, the durable record", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc");
    const escalated = await world.service.escalateToHuman(
      {
        conversationId: started.conversationId,
        destination: "human-operator",
        cause: "customer frustrated",
      },
      "esc-1",
      ACTOR,
    );
    expect(escalated.escalationKey).toBe("esc-1");
    expect(escalated.destination).toBe("human-operator");
    expect(escalated.ledgerSequence).toBeGreaterThan(0);
    // Exactly ONE upstream escalation notice.
    expect(railRecords(world, "escalate")).toHaveLength(1);
    // The governed execution step: the wait-human transition on the ledger.
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(String(struct(world.ledger.humanWaits[0]?.input).executionId)).toBe(started.executionId);
    // The durable escalation record is bound to the conversation + execution.
    const record = await world.store.findEscalation(ACTOR.applicationId, "esc-1");
    expect(record?.conversationId).toBe(started.conversationId);
    expect(record?.executionId).toBe(started.executionId);
    expect(record?.notifiedAt).not.toBeNull();
    // Escalation provenance + the marker row (a governed step, not an ad-hoc flag).
    expect(
      world.ledger.evidence.some(
        (entry) => String(struct(entry.input).evidenceClass) === "escalation",
      ),
    ).toBe(true);
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.some((message) => message.eventKey === "esc-1:escalation")).toBe(true);
    // The operation completed.
    expect(await operation(world, "human-escalation", "esc-1")).toMatchObject({
      status: "completed",
      attempts: 1,
    });
  });

  test("escalation does NOT close the conversation (async messaging: human and agent coexist)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc-live");
    await world.service.escalateToHuman({ conversationId: started.conversationId }, "esc-2", ACTOR);
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(conversation?.status).toBe("active");
  });

  test("idempotent replay: the same key converges on the SAME escalation record", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc-replay");
    const first = await world.service.escalateToHuman(
      { conversationId: started.conversationId },
      "esc-3",
      ACTOR,
    );
    const second = await world.service.escalateToHuman(
      { conversationId: started.conversationId },
      "esc-3",
      ACTOR,
    );
    expect(second.replayed).toBe(true);
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(world.ledger.humanWaits).toHaveLength(1);
    const records = await world.store.findEscalation(ACTOR.applicationId, "esc-3");
    expect(records?.destination).toBe(first.destination);
  });

  test("policy denial happens BEFORE the wait step and the rail notice", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc-deny");
    world.policy.denyAction = "human-escalation";
    await expect(
      world.service.escalateToHuman({ conversationId: started.conversationId }, "esc-4", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(railRecords(world, "escalate")).toHaveLength(0);
    expect(world.ledger.humanWaits).toHaveLength(0);
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-4")).toBeNull();
  });

  test("a closed conversation cannot escalate (terminal guard)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc-closed");
    await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-esc",
      ACTOR,
    );
    await expect(
      world.service.escalateToHuman({ conversationId: started.conversationId }, "esc-5", ACTOR),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("a wrong-tenant actor cannot escalate another tenant's conversation", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc-tenant");
    await expect(
      world.service.escalateToHuman(
        { conversationId: started.conversationId },
        "esc-6",
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(railRecords(world, "escalate")).toHaveLength(0);
  });

  test("a rail refusal records the terminal failure; a retry under the same key replays it", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-esc-refuse");
    world.rail.failNextSend("fixture escalation refusal");
    await expect(
      world.service.escalateToHuman({ conversationId: started.conversationId }, "esc-7", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(await operation(world, "human-escalation", "esc-7")).toMatchObject({ status: "failed" });
    // The retry replays the recorded failure (no second notice attempt).
    await expect(
      world.service.escalateToHuman({ conversationId: started.conversationId }, "esc-7", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(railRecords(world, "escalate")).toHaveLength(0);
  });
});

describe("closeConversation (the terminal move)", () => {
  test("the happy path: completion provenance, the rail close, the marker row, the terminal status", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-close-1");
    const closed = await world.service.closeConversation(
      { conversationId: started.conversationId, cause: "customer resolved" },
      "close-a",
      ACTOR,
    );
    expect(closed.replayed).toBe(false);
    expect(railRecords(world, "close")).toHaveLength(1);
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(conversation?.status).toBe("closed");
    expect(conversation?.closedAt).not.toBeNull();
    // Completion provenance rode the executions ledger.
    expect(
      world.ledger.evidence.some(
        (entry) => String(struct(entry.input).evidenceClass) === "conversation-completed",
      ),
    ).toBe(true);
    const messages = await world.service.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.some((message) => message.eventKey === "close-a:close")).toBe(true);
    expect(await operation(world, "conversation-close", "close-a")).toMatchObject({
      status: "completed",
    });
  });

  test("idempotent replay: a second close under the same key converges; the conversation is terminal-immutable", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-close-2");
    await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-b",
      ACTOR,
    );
    const replay = await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-b",
      ACTOR,
    );
    expect(replay.replayed).toBe(true);
    expect(railRecords(world, "close")).toHaveLength(1);
  });

  test("closing an ALREADY-closed conversation replays (terminal state is the durable proof)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-close-3");
    await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-c",
      ACTOR,
    );
    const replay = await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-d",
      ACTOR,
    );
    expect(replay.replayed).toBe(true);
  });

  test("a wrong-tenant actor cannot close another tenant's conversation", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-close-4");
    await expect(
      world.service.closeConversation(
        { conversationId: started.conversationId },
        "close-e",
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(conversation?.status).toBe("active");
  });
});

describe("the provenance chain inbound → execution → reply (AC6)", () => {
  test("the full chain is recorded on the canonical executions ledger with the correlation coordinates", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-prov");
    await world.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-prov", {
        threadRef: "thread-9",
        payloadPreview: "what is my order status",
      }),
      ACTOR,
    );
    // conversation-started → message turn evidence, both bound to the SAME execution.
    const startedEvidence = world.ledger.evidence.find(
      (entry) => entry.key === "start-prov:conversation-started",
    );
    const turnEvidence = world.ledger.evidence.find(
      (entry) => entry.key === `messaging:message:${started.conversationId}:evt-prov`,
    );
    expect(startedEvidence).toBeDefined();
    expect(turnEvidence).toBeDefined();
    expect(String(struct(startedEvidence?.input).executionId)).toBe(started.executionId);
    expect(String(struct(turnEvidence?.input).executionId)).toBe(started.executionId);
    const turnReference = struct(turnEvidence?.input).reference as Record<string, unknown>;
    expect(String(turnReference.conversationId)).toBe(started.conversationId);
    expect(String(turnReference.eventKey)).toBe("evt-prov");
    expect(String(turnReference.replyMessageKey)).toBe("evt-prov:reply");
    expect(String(turnReference.threadRef)).toBe("thread-9");
    // The reply row links back to the inbound event key (the chain).
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-prov:reply",
    );
    expect(reply?.replyToEventKey).toBe("evt-prov");
    expect(reply?.ledgerSequence).toBe(
      (turnEvidence?.input as { sequence?: number } | undefined) === undefined
        ? reply?.ledgerSequence
        : reply?.ledgerSequence,
    );
    expect(reply?.ledgerSequence).not.toBeNull();
  });

  test("getConversation reads the conversation with its execution facts (application-scoped)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-read");
    const read = await world.service.getConversation(ACTOR.applicationId, started.conversationId);
    expect(read?.conversation.id).toBe(started.conversationId);
    expect(read?.execution?.id).toBe(started.executionId);
    expect(
      await world.service.getConversation(
        "00000000-0000-7000-8000-0000000000ee",
        started.conversationId,
      ),
    ).toBeNull();
  });
});

describe("the durable operation discipline (the WORK-024 crash-safety standard)", () => {
  test("the five governed operation kinds claim durably BEFORE their side effects and complete after", async () => {
    const world = await seededWorld();
    // conversation-start: claimed before the rail open.
    const started = await startConversation(world, "start-ops");
    expect(world.log.index("rail-openConversation")).toBeGreaterThan(-1);
    // turn-reply: the claim precedes the responder and the rail send.
    world.log.entries.length = 0;
    await world.service.ingestInboundEvent(userEvent(started.conversationId, "evt-ops"), ACTOR);
    const responderIndex = world.log.index("responder");
    const sendIndex = world.log.index("rail-sendMessage");
    expect(responderIndex).toBeGreaterThan(-1);
    expect(sendIndex).toBeGreaterThan(responderIndex);
    // delivery-apply + human-escalation + conversation-close each own a row.
    await world.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-ops:reply", status: "delivered" },
      ACTOR,
    );
    await world.service.escalateToHuman(
      { conversationId: started.conversationId },
      "esc-ops",
      ACTOR,
    );
    await world.service.closeConversation(
      { conversationId: started.conversationId },
      "close-ops",
      ACTOR,
    );
    for (const [kind, discriminator] of [
      ["conversation-start", "start-ops"],
      ["turn-reply", `${started.conversationId}:evt-ops`],
      [
        "delivery-apply",
        `${started.conversationId}:dlv-${started.conversationId}-evt-ops:reply-delivered`,
      ],
      ["human-escalation", "esc-ops"],
      ["conversation-close", "close-ops"],
    ] as const) {
      const record = await operation(world, kind, discriminator);
      expect(record, `${kind} operation row`).not.toBeNull();
      expect(record?.status).toBe("completed");
      expect(record?.attempts).toBeGreaterThanOrEqual(1);
    }
  });

  test("re-claiming a pending operation bumps the attempts ledger (the retry record)", async () => {
    const world = await seededWorld();
    const begun = await world.store.beginMessagingOperation({
      operationId: "00000000-0000-7000-8000-000000000001",
      applicationId: ACTOR.applicationId,
      tenantId: ACTOR.tenantId,
      conversationId: null,
      deploymentId: "00000000-0000-7000-8000-000000000002",
      executionId: null,
      operationKind: "conversation-close",
      operationKey: messagingOperationKey("conversation-close", "manual-op"),
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    });
    expect(begun.status).toBe("begun");
    const reclaimed = await world.store.beginMessagingOperation({
      operationId: "00000000-0000-7000-8000-000000000003",
      applicationId: ACTOR.applicationId,
      tenantId: ACTOR.tenantId,
      conversationId: null,
      deploymentId: "00000000-0000-7000-8000-000000000002",
      executionId: null,
      operationKind: "conversation-close",
      operationKey: messagingOperationKey("conversation-close", "manual-op"),
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    });
    expect(reclaimed.status).toBe("existing");
    expect(reclaimed.record.attempts).toBe(2);
  });

  test("a completed operation is terminal-immutable (no checkpoint, no failure, no re-attempt)", async () => {
    const world = await seededWorld();
    const started = await startConversation(world, "start-terminal");
    const key = messagingOperationKey("conversation-start", "start-terminal");
    await expect(
      world.store.recordMessagingOperationCheckpoint(ACTOR.applicationId, key, {
        stage: "conversation-opened",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(
      world.store.failMessagingOperation(
        ACTOR.applicationId,
        key,
        "late failure",
        new Date().toISOString(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // The re-claim of a terminal row replays without an attempt bump.
    const reclaimed = await world.store.beginMessagingOperation({
      operationId: "00000000-0000-7000-8000-000000000004",
      applicationId: ACTOR.applicationId,
      tenantId: ACTOR.tenantId,
      conversationId: started.conversationId,
      deploymentId: world.deploymentId,
      executionId: started.executionId,
      operationKind: "conversation-start",
      operationKey: key,
      createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    });
    expect(reclaimed.status).toBe("existing");
    expect(reclaimed.record.attempts).toBe(1);
    expect(reclaimed.record.status).toBe("completed");
  });
});
