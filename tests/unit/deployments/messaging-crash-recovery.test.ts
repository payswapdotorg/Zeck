/**
 * Crash-injection proofs — the durable, recoverable messaging operation
 * state and the STABLE rail-level idempotency keys (WORK-025; checkpoint
 * contract CONCURRENCY-CRASH-SAFETY; the WORK-024 crash-safety standard
 * from the PR #46 review round, applied to messaging).
 *
 * THE CRASH MODEL (kill/restart at the durable boundaries): a Zeck
 * process dies mid-operation. What survives a process crash:
 *   - the DURABLE STATE (the messaging store — conversations, the
 *     append-only message ledger, the delivery evidence, the escalation
 *     records, and the messaging_operations ledger);
 *   - the EXECUTIONS LEDGER (its own durable module);
 *   - the UPSTREAM RAIL (the external messaging provider — it keeps its
 *     idempotency-key ledger, exactly as a real provider would).
 * What dies: the in-flight service process (its closure, its unwritten
 * intents). A "restart" is a NEW service instance booted over the
 * surviving world (`boot()`).
 *
 * The injector arms ONE durable-boundary crash point per process (a
 * method on store/rail/ledger, before/after its durable commit) and
 * THROWS a ProcessCrashError through the awaited call — every armed
 * point below is OUTSIDE the service's best-effort `.catch()` regions,
 * so the crash always propagates and the process genuinely dies
 * mid-flight. The test then reboots (a fresh process, no plan) and
 * re-issues the SAME logical operation under the SAME idempotency
 * coordinates.
 *
 * THE PROOF RECORDS (the required lifecycle points):
 *   CONVERSATION START  C1 claim | C2 rail open | C3 checkpoint |
 *                       C4 durable insert | C5 evidence | C6 double crash
 *   INBOUND TURN        C7 inbound claim | C8 execution identity |
 *                       C9 responded checkpoint (after) |
 *                       C10 pre-checkpoint responder crash |
 *                       C11 rail send | C12 turn evidence | C13 reply row
 *   DELIVERY STATUS     C14 claim | C15 evidence row | C16 projection
 *   HUMAN ESCALATION    C17 wait step | C18 rail notice |
 *                       C19 rail-issued checkpoint | C20 escalation record
 *   CONVERSATION CLOSE  C21 completion evidence | C22 terminal move
 *   KEY DISCIPLINE      C23 conversation-scoped keys
 *
 * Every record asserts the SAME invariants: EXACTLY ONE upstream rail
 * side effect per stable key (the rail `sends` observable — never a
 * second record, a retry converges through `replays`), the operation
 * row reaches COMPLETED with the honest attempts ledger, the durable
 * rows (conversation/messages/deliveries/escalations/evidence) exist
 * exactly once, and — for the past-checkpoint recoveries — the
 * paid-inference and admission seams are NEVER re-invoked (the
 * checkpoint's facts complete the durable tail).
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

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");
const ACTOR: MessagingActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
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

const PLAN: DeploymentPlanInput = {
  planId: "support-chat-plan",
  profileRef: { profileId: "support-chat", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" as const },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "messaging-channel-adapter" },
    { channelKind: "sms", adapterCapabilityId: "messaging-channel-adapter" },
  ],
  sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
};

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
// executions-ledger in-memory model with key convergence on EVERY
// idempotent command — openExecution, recordEvidence, awaitHuman).
// ---------------------------------------------------------------------------

class FakePolicyAdmission {
  readonly calls: MessagingPolicyAdmissionRequest[] = [];
  deny = false;
  async admit(request: MessagingPolicyAdmissionRequest) {
    this.calls.push(request);
    if (this.deny) {
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
  async resolve(request: MessagingCapabilityAdmissionRequest) {
    this.calls.push(request);
    return { satisfied: this.unmet.length === 0, unmet: this.unmet };
  }
}

class FakeBudgetAdmission {
  readonly reserves: MessagingBudgetReserveCommand[] = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly releases: Array<Record<string, unknown>> = [];
  private seq = 0;
  private readonly reservationsByOperation = new Map<string, string>();
  async reserve(command: MessagingBudgetReserveCommand) {
    this.reserves.push(command);
    // Key-convergent reservation (the REAL budgets module treats
    // operationId as the idempotency discriminator: a retried or
    // concurrent duplicate converges on the SAME reservation).
    const existing = this.reservationsByOperation.get(command.operationId);
    if (existing !== undefined) {
      return { reservationId: existing, amountMicroUsd: "10000", converged: true };
    }
    this.seq += 1;
    const reservationId = `resv-${this.seq}`;
    this.reservationsByOperation.set(command.operationId, reservationId);
    return { reservationId, amountMicroUsd: "10000", converged: false };
  }
  async settle(input: Record<string, unknown>) {
    this.settles.push(input);
    return { reservationId: "resv-latest", settled: true };
  }
  async release(input: Record<string, unknown>) {
    this.releases.push(input);
    return { reservationId: "resv-latest", released: true };
  }
}

class FakeSecretMediation {
  readonly calls: MessagingSecretMediationRequest[] = [];
  refuse = false;
  async mediate(request: MessagingSecretMediationRequest) {
    this.calls.push(request);
    if (this.refuse) {
      return { mediated: false as const, reason: "fixture connection inactive" };
    }
    return { mediated: true as const, grantRef: "mediated:conn-1:cred" };
  }
}

class FakeRouter {
  readonly calls: MessagingTurnRouteRequest[] = [];
  routeClass: MessagingRouteClass = "generative";
  async routeTurn(request: MessagingTurnRouteRequest) {
    this.calls.push(request);
    return {
      routeClass: this.routeClass,
      decisionOutcome: "insufficient" as const,
      reasonCodes: ["fixture"],
      rationale: "fixture planner decision",
      estimatedCostMicroUsd: "10000",
    };
  }
}

class FakeResponder {
  readonly calls: MessagingTurnResponderRequest[] = [];
  async respond(request: MessagingTurnResponderRequest) {
    this.calls.push(request);
    return {
      responseRef: "artifact:responses/1",
      responsePreview: "fixture generative answer",
      responseAttachments: [],
      actualCostMicroUsd: "10000",
    };
  }
}

/** The executions-ledger model: every command is key-idempotent. */
class FakeExecutionLedger implements MessagingExecutionLedger {
  readonly opened: Array<{ key: string; input: MessagingExecutionOpenInput }> = [];
  readonly evidence: Array<{ key: string; input: MessagingEvidenceInput }> = [];
  readonly humanWaits: Array<{ key: string; input: Record<string, unknown> }> = [];
  private readonly executions = new Map<string, string>();
  private readonly evidenceKeys = new Set<string>();
  private readonly humanWaitKeys = new Set<string>();
  private seq = 0;
  private nextExecution = 0;
  async openExecution(input: MessagingExecutionOpenInput, idempotencyKey: string) {
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
    const replayed = this.evidenceKeys.has(idempotencyKey);
    this.evidenceKeys.add(idempotencyKey);
    this.seq += 1;
    if (!replayed) {
      this.evidence.push({ key: idempotencyKey, input });
    }
    return { sequence: this.seq, type: "agent-action-recorded", replayed };
  }
  async readExecution() {
    return { id: "exec", tenantId: ACTOR.tenantId, status: "running" };
  }
  async awaitHuman(input: Record<string, unknown>, idempotencyKey: string) {
    const replayed = this.humanWaitKeys.has(idempotencyKey);
    this.humanWaitKeys.add(idempotencyKey);
    if (!replayed) {
      this.humanWaits.push({ key: idempotencyKey, input });
    }
    this.seq += 1;
    return { sequence: this.seq, replayed };
  }
  async continueAfterHuman(_input: Record<string, unknown>, _idempotencyKey: string) {
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
}

// ---------------------------------------------------------------------------
// The crash injector.
// ---------------------------------------------------------------------------

/** The simulated process death (never a typed service error). */
class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per process). */
interface CrashPoint {
  readonly target: "store" | "rail" | "ledger";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable/external seam so the process dies at the planned
 * point. `before` = the durable commit did NOT happen; `after` = the
 * commit (or the external side effect) DID happen and the process died
 * immediately after. The wrapper records the firing so a vacuous test
 * (a point the service never reaches) fails its `crashed()` assertion.
 */
function crashing<T extends object>(target: T, label: string, point: CrashPoint | null) {
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

// ---------------------------------------------------------------------------
// The surviving world (durable store + executions ledger + upstream
// rail + admission seams + the deployment fabric) and the process boot.
// ---------------------------------------------------------------------------

interface World {
  readonly store: InMemoryMessagingStore;
  readonly rail: ReturnType<typeof createInProcessMessagingRail>;
  readonly ledger: FakeExecutionLedger;
  readonly policy: FakePolicyAdmission;
  readonly capabilities: FakeCapabilityAdmission;
  readonly budget: FakeBudgetAdmission;
  readonly secrets: FakeSecretMediation;
  readonly router: FakeRouter;
  readonly responder: FakeResponder;
  readonly deploymentStore: InMemoryDeploymentStore;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
  /** Boot one Zeck process over the surviving world (the restart primitive). */
  boot(plan: CrashPoint | null): {
    service: MessagingConversationService;
    crashed: () => boolean;
  };
}

async function buildWorld(): Promise<World> {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  registry.register({
    descriptor: {
      adapterCapabilityId: "messaging-channel-adapter",
      channelKinds: ["web", "in-app", "sms", "email"],
    },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind };
    },
  });
  let idSeq = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++idSeq).padStart(12, "0")}`;
  const now = () => new Date("2026-01-01T00:00:00Z");
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
    now,
  });

  const store = new InMemoryMessagingStore();
  const rail = createInProcessMessagingRail(["web", "in-app", "sms", "email"], { now });
  const ledger = new FakeExecutionLedger();
  const policy = new FakePolicyAdmission();
  const capabilities = new FakeCapabilityAdmission();
  const budget = new FakeBudgetAdmission();
  const secrets = new FakeSecretMediation();
  const router = new FakeRouter();
  const responder = new FakeResponder();

  const actor = {
    actorId: ACTOR.actorId,
    applicationId: ACTOR.applicationId,
    tenantId: ACTOR.tenantId,
  };
  await deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
  await deploymentService.publishPlan(PLAN, { version: 1 }, actor);
  const created = await deploymentService.createDeployment({ ...CREATION }, "deploy-key-0", actor);

  const boot = (plan: CrashPoint | null) => {
    const storeProcess = crashing(store, "store", plan);
    const railProcess = crashing(rail, "rail", plan);
    const ledgerProcess = crashing(ledger, "ledger", plan);
    const service = createMessagingConversationService({
      store: storeProcess.proxy,
      deployments: deploymentStore,
      rail: railProcess.proxy,
      policy,
      capabilities,
      budget,
      secrets,
      router,
      responder,
      ledger: ledgerProcess.proxy,
      railConnectionRef: "conn-rail-1",
      digest,
      generateId,
      now,
    });
    return {
      service,
      crashed: () => storeProcess.crashed() || railProcess.crashed() || ledgerProcess.crashed(),
    };
  };

  return {
    store,
    rail,
    ledger,
    policy,
    capabilities,
    budget,
    secrets,
    router,
    responder,
    deploymentStore,
    deploymentService,
    deploymentId: created.deploymentId,
    boot,
  };
}

// ---------------------------------------------------------------------------
// Scenario helpers.
// ---------------------------------------------------------------------------

/**
 * Run one operation in a DYING process: the armed crash point kills it
 * mid-flight (the promise's terminal state is irrelevant — the process
 * is gone; only the durable world matters).
 */
async function diesDuring<T>(run: () => Promise<T>, crashed: () => boolean): Promise<void> {
  await run().then(
    () => undefined,
    () => undefined,
  );
  expect(crashed()).toBe(true);
}

const startInput = (world: World, callRef: string): StartMessagingConversationInput => ({
  deploymentId: world.deploymentId,
  channelKind: "web",
  channelConversationRef: `channel-thread-${callRef}`,
});

const userEvent = (conversationId: string, eventKey: string): MessagingInboundEventInput => ({
  conversationId,
  eventKey,
  payloadRef: "artifact:inbound/1",
  payloadPreview: "customer question",
});

const railRecords = (world: World, kind: string) =>
  world.rail.sends.filter((record) => record.kind === kind);

const operation = (world: World, kind: MessagingOperationKind, discriminator: string) =>
  world.store.findMessagingOperation(
    ACTOR.applicationId,
    messagingOperationKey(kind, discriminator),
  );

describe("crash-injection proofs: durable operation state + stable rail keys (WORK-025)", () => {
  // ---- CONVERSATION START ---------------------------------------------------

  test("C1 START: crash AFTER the durable operation claim — the retry completes; the claim-pinned identity survives", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "store", method: "beginMessagingOperation", when: "after" });
    await diesDuring(
      () => dying.service.startConversation(startInput(world, "c1"), "start-c1", ACTOR),
      dying.crashed,
    );
    // The claim committed and pinned the conversation identity BEFORE the crash.
    const claimed = await operation(world, "conversation-start", "start-c1");
    expect(claimed?.status).toBe("pending");
    const pinnedConversationId = claimed?.conversationId;
    expect(pinnedConversationId).toBeDefined();
    // RESTART: the same logical start completes with the pinned identity.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startConversation(
      startInput(world, "c1"),
      "start-c1",
      ACTOR,
    );
    expect(outcome.conversationId).toBe(pinnedConversationId);
    // Exactly ONE upstream conversation (the rail ledger has one open record).
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.openedConversations).toBe(1);
    expect(world.rail.replays).toHaveLength(0);
    // The operation completed with the honest attempts ledger (claimed, re-claimed).
    const completed = await operation(world, "conversation-start", "start-c1");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    expect(completed?.conversationId).toBe(pinnedConversationId);
    // One conversation row, one execution identity, one admission pass.
    expect(
      await world.store.findConversationByStartKey(ACTOR.applicationId, "start-c1"),
    ).not.toBeNull();
    expect(world.ledger.opened).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(1);
  });

  test("C2 START: crash AFTER the rail open (before the checkpoint) — the retry re-opens under the SAME key and the rail converges", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "rail", method: "openConversation", when: "after" });
    await diesDuring(
      () => dying.service.startConversation(startInput(world, "c2"), "start-c2", ACTOR),
      dying.crashed,
    );
    // The rail performed the upstream side effect; the conversation row does NOT exist.
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(await world.store.findConversationByStartKey(ACTOR.applicationId, "start-c2")).toBeNull();
    // RESTART: the retry runs the full pipeline; the rail open converges
    // on the SAME channel coordinates under the same stable key.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startConversation(
      startInput(world, "c2"),
      "start-c2",
      ACTOR,
    );
    expect(outcome.channelConversationRef).toBe("channel-thread-c2");
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.openedConversations).toBe(1);
    expect(world.rail.replays).toHaveLength(1);
    expect(world.rail.replays[0]?.kind).toBe("open");
    const completed = await operation(world, "conversation-start", "start-c2");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    // One execution identity (the ledger command converged by key).
    expect(world.ledger.opened).toHaveLength(1);
  });

  test("C3 START: crash AFTER the conversation-opened checkpoint — the retry resumes WITHOUT re-admission and WITHOUT a second rail call", async () => {
    const world = await buildWorld();
    const dying = world.boot({
      target: "store",
      method: "recordMessagingOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dying.service.startConversation(startInput(world, "c3"), "start-c3", ACTOR),
      dying.crashed,
    );
    // The checkpoint committed; the conversation row does not exist yet.
    const pending = await operation(world, "conversation-start", "start-c3");
    expect(pending?.status).toBe("pending");
    expect(pending?.checkpoint?.stage).toBe("conversation-opened");
    expect(await world.store.findConversationByStartKey(ACTOR.applicationId, "start-c3")).toBeNull();
    // RESTART: the durable tail completes from the checkpoint facts.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startConversation(
      startInput(world, "c3"),
      "start-c3",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true); // the resumed claim IS a replay (the honest marker)
    // EXACTLY ONE rail open; NO second admission pass; NO second execution.
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(1);
    expect(world.ledger.opened).toHaveLength(1);
    const completed = await operation(world, "conversation-start", "start-c3");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    // The durable rows exist exactly once with the provenance tail.
    const messages = await world.store.listMessages(ACTOR.applicationId, outcome.conversationId);
    expect(
      messages.filter((message) => message.eventKey === "start-c3:conversation-started"),
    ).toHaveLength(1);
    expect(world.ledger.evidence).toHaveLength(1);
  });

  test("C4 START: crash AFTER the durable conversation insert (before the provenance tail) — the replay fast path completes the tail", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "store", method: "insertConversation", when: "after" });
    await diesDuring(
      () => dying.service.startConversation(startInput(world, "c4"), "start-c4", ACTOR),
      dying.crashed,
    );
    // The conversation row exists; the provenance tail does not.
    const conversation = await world.store.findConversationByStartKey(
      ACTOR.applicationId,
      "start-c4",
    );
    expect(conversation).not.toBeNull();
    expect(await operation(world, "conversation-start", "start-c4")).toMatchObject({
      status: "pending",
    });
    // RESTART: the fast path recovers the provenance tail and completes.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startConversation(
      startInput(world, "c4"),
      "start-c4",
      ACTOR,
    );
    expect(outcome.conversationId).toBe(conversation?.id);
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(1);
    expect(world.ledger.opened).toHaveLength(1);
    expect(
      world.ledger.evidence.some((entry) => entry.key === "start-c4:conversation-started"),
    ).toBe(true);
    const messages = await world.store.listMessages(ACTOR.applicationId, outcome.conversationId);
    expect(
      messages.filter((message) => message.eventKey === "start-c4:conversation-started"),
    ).toHaveLength(1);
    expect(await operation(world, "conversation-start", "start-c4")).toMatchObject({
      status: "completed",
    });
  });

  test("C5 START: crash AFTER the conversation-started evidence — the marker row and the completion converge on restart", async () => {
    const world = await buildWorld();
    const dying = world.boot({
      target: "ledger",
      method: "recordEvidence",
      when: "after",
    });
    await diesDuring(
      () => dying.service.startConversation(startInput(world, "c5"), "start-c5", ACTOR),
      dying.crashed,
    );
    // The evidence committed on the executions ledger; the marker row and
    // the operation completion did not.
    expect(
      world.ledger.evidence.some((entry) => entry.key === "start-c5:conversation-started"),
    ).toBe(true);
    expect(await operation(world, "conversation-start", "start-c5")).toMatchObject({
      status: "pending",
    });
    // RESTART: the fast path converges everything exactly once.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startConversation(
      startInput(world, "c5"),
      "start-c5",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.ledger.evidence).toHaveLength(1);
    const messages = await world.store.listMessages(ACTOR.applicationId, outcome.conversationId);
    expect(
      messages.filter((message) => message.eventKey === "start-c5:conversation-started"),
    ).toHaveLength(1);
    expect(await operation(world, "conversation-start", "start-c5")).toMatchObject({
      status: "completed",
    });
  });

  test("C6 START: DOUBLE crash (claim → crash; restart → crash after the rail open; restart → complete) — still exactly one upstream conversation", async () => {
    const world = await buildWorld();
    const first = world.boot({ target: "store", method: "beginMessagingOperation", when: "after" });
    await diesDuring(
      () => first.service.startConversation(startInput(world, "c6"), "start-c6", ACTOR),
      first.crashed,
    );
    const second = world.boot({ target: "rail", method: "openConversation", when: "after" });
    await diesDuring(
      () => second.service.startConversation(startInput(world, "c6"), "start-c6", ACTOR),
      second.crashed,
    );
    // Two crashes later: the rail opened exactly once, nothing durable past it.
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(await world.store.findConversationByStartKey(ACTOR.applicationId, "start-c6")).toBeNull();
    const third = world.boot(null);
    const outcome = await third.service.startConversation(
      startInput(world, "c6"),
      "start-c6",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(1);
    const completed = await operation(world, "conversation-start", "start-c6");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(3);
    // One execution identity across all three processes.
    expect(world.ledger.opened).toHaveLength(1);
  });

  // ---- INBOUND TURN ---------------------------------------------------------

  async function liveConversation(world: World, suffix: string) {
    const booted = world.boot(null);
    return booted.service.startConversation(
      startInput(world, suffix),
      `start-${suffix}`,
      ACTOR,
    );
  }

  test("C7 TURN: crash AFTER the inbound claim — the restart resumes the reply pipeline; exactly one send", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t7");
    const dying = world.boot({ target: "store", method: "appendMessage", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c7"), ACTOR),
      dying.crashed,
    );
    // The inbound row committed (the idempotency ledger); nothing else.
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "evt-c7")).toHaveLength(1);
    expect(railRecords(world, "send")).toHaveLength(0);
    // RESTART: the converged claim resumes the pipeline.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c7"),
      ACTOR,
    );
    expect(outcome.reply?.messageKey).toBe("evt-c7:reply");
    expect(railRecords(world, "send")).toHaveLength(1);
    const completed = await operation(world, "turn-reply", `${started.conversationId}:evt-c7`);
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBeGreaterThanOrEqual(1);
  });

  test("C8 TURN: crash AFTER the durable turn claim — the restart completes the turn with the SAME reply key", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t8");
    // The inbound claim and the operation claim both commit; the crash
    // lands after the operation claim (beginMessagingOperation is the
    // second store write of the turn).
    const dying = world.boot({
      target: "store",
      method: "beginMessagingOperation",
      when: "after",
    });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c8"), ACTOR),
      dying.crashed,
    );
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c8`)).toMatchObject({
      status: "pending",
      checkpoint: null,
    });
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c8"),
      ACTOR,
    );
    expect(outcome.reply?.messageKey).toBe("evt-c8:reply");
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.responder.calls).toHaveLength(1);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c8`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C9 TURN: crash AFTER the responded checkpoint — the send resumes with the CHECKPOINTED facts; admission and the responder are NEVER re-invoked", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t9");
    const dying = world.boot({
      target: "store",
      method: "recordMessagingOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c9"), ACTOR),
      dying.crashed,
    );
    // The checkpoint committed with the responded facts.
    const pending = await operation(world, "turn-reply", `${started.conversationId}:evt-c9`);
    expect(pending?.status).toBe("pending");
    expect(pending?.checkpoint?.stage).toBe("responded");
    expect(railRecords(world, "send")).toHaveLength(0);
    // RESTART: the send resumes from the checkpoint — no admission, no responder.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c9"),
      ACTOR,
    );
    expect(outcome.reply?.messageKey).toBe("evt-c9:reply");
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.responder.calls).toHaveLength(1);
    // The admission seams were consulted exactly ONCE (the pre-crash pass).
    expect(world.policy.calls.filter((call) => call.action === "message-send")).toHaveLength(1);
    expect(world.capabilities.calls).toHaveLength(1);
    expect(world.budget.reserves).toHaveLength(1);
    // The reply row exists exactly once and the operation completed.
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "evt-c9:reply")).toHaveLength(1);
    expect(
      world.ledger.evidence.some(
        (entry) => entry.key === `messaging:message:${started.conversationId}:evt-c9`,
      ),
    ).toBe(true);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c9`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C10 TURN: crash BEFORE the responded checkpoint (mid-respond, pre-no-return) — the admission re-runs honestly and the send STILL converges by key", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t10");
    // The responder ran, the checkpoint write dies BEFORE the commit: no
    // point of no return was passed — the crash window is bounded by the
    // turn-key contract (the responder seam's documented residual risk).
    const dying = world.boot({
      target: "store",
      method: "recordMessagingOperationCheckpoint",
      when: "before",
    });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c10"), ACTOR),
      dying.crashed,
    );
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c10`)).toMatchObject({
      status: "pending",
      checkpoint: null,
    });
    expect(world.responder.calls).toHaveLength(1);
    // RESTART: the full pipeline re-runs (the decision had not passed
    // no-return) — and the rail STILL performs exactly one send.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c10"),
      ACTOR,
    );
    expect(outcome.reply?.messageKey).toBe("evt-c10:reply");
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    // The responder ran twice (the residual pre-checkpoint window); the
    // rail send and the durable rows exist EXACTLY ONCE.
    expect(world.responder.calls).toHaveLength(2);
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "evt-c10:reply")).toHaveLength(1);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c10`)).toMatchObject({
      status: "completed",
    });
  });

  test("C11 TURN: crash AFTER the rail send — the upstream send happened; the restart converges (replay), never double-sends", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t11");
    const dying = world.boot({ target: "rail", method: "sendMessage", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c11"), ACTOR),
      dying.crashed,
    );
    // THE upstream side effect happened; no durable reply row.
    expect(railRecords(world, "send")).toHaveLength(1);
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "evt-c11:reply")).toHaveLength(0);
    // RESTART: the send converges by the stable key (replayed: true), the
    // durable tail completes, and the rail still holds ONE send record.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c11"),
      ACTOR,
    );
    expect(outcome.reply?.channelMessageRef).toBe(railRecords(world, "send")[0]?.messageKey === null ? null : outcome.reply?.channelMessageRef);
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.rail.acceptedSends).toBe(1);
    expect(world.rail.replays.filter((replay) => replay.kind === "send")).toHaveLength(1);
    // The responder was NOT re-invoked (the responded checkpoint held).
    expect(world.responder.calls).toHaveLength(1);
    const final = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(final.filter((message) => message.eventKey === "evt-c11:reply")).toHaveLength(1);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c11`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C12 TURN: crash AFTER the turn evidence — the reply row and the completion converge on restart", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t12");
    // recordEvidence is called for the turn AFTER the send; arm the
    // SECOND occurrence (the first evidence call is the marker append
    // which... none precedes: the ingest path's first recordEvidence IS
    // the turn evidence).
    const dying = world.boot({ target: "ledger", method: "recordEvidence", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c12"), ACTOR),
      dying.crashed,
    );
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(
      world.ledger.evidence.some(
        (entry) => entry.key === `messaging:message:${started.conversationId}:evt-c12`,
      ),
    ).toBe(true);
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "evt-c12:reply")).toHaveLength(0);
    // RESTART: converge.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c12"),
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(world.rail.replays.filter((replay) => replay.kind === "send")).toHaveLength(1);
    const final = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(final.filter((message) => message.eventKey === "evt-c12:reply")).toHaveLength(1);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c12`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C13 TURN: crash AFTER the reply row — only the operation completion is missing; the restart completes and replays", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t13");
    // The reply row is appended with the send's channelMessageRef; arm
    // the THIRD appendMessage occurrence (inbound claim = 1, reply row = 2).
    const dying = world.boot({
      target: "store",
      method: "appendMessage",
      when: "after",
      occurrence: 2,
    });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userEvent(started.conversationId, "evt-c13"), ACTOR),
      dying.crashed,
    );
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "evt-c13:reply")).toHaveLength(1);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c13`)).toMatchObject({
      status: "pending",
    });
    // RESTART: the completed-tail convergence.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      userEvent(started.conversationId, "evt-c13"),
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "send")).toHaveLength(1);
    expect(await operation(world, "turn-reply", `${started.conversationId}:evt-c13`)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  // ---- DELIVERY STATUS APPLICATION ------------------------------------------

  async function conversationWithReply(world: World, suffix: string, eventKey: string) {
    const started = await liveConversation(world, suffix);
    const booted = world.boot(null);
    await booted.service.ingestInboundEvent(userEvent(started.conversationId, eventKey), ACTOR);
    return started;
  }

  test("C14 DELIVERY: crash AFTER the delivery claim — the restart applies the callback exactly once", async () => {
    const world = await buildWorld();
    const started = await conversationWithReply(world, "t14", "evt-c14");
    const dying = world.boot({
      target: "store",
      method: "beginMessagingOperation",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.applyDeliveryStatus(
          { conversationId: started.conversationId, messageKey: "evt-c14:reply", status: "delivered" },
          ACTOR,
        ),
      dying.crashed,
    );
    expect(
      await operation(
        world,
        "delivery-apply",
        `${started.conversationId}:dlv-${started.conversationId}-evt-c14:reply-delivered`,
      ),
    ).toMatchObject({ status: "pending" });
    // RESTART: the same callback applies.
    const restarted = world.boot(null);
    const applied = await restarted.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-c14:reply", status: "delivered" },
      ACTOR,
    );
    expect(applied.deliveryStatus).toBe("delivered");
    const deliveries = await world.store.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(deliveries).toHaveLength(1);
    expect(
      await operation(
        world,
        "delivery-apply",
        `${started.conversationId}:dlv-${started.conversationId}-evt-c14:reply-delivered`,
      ),
    ).toMatchObject({ status: "completed", attempts: 2 });
  });

  test("C15 DELIVERY: crash AFTER the evidence row (before the projection) — the restart converges the projection once", async () => {
    const world = await buildWorld();
    const started = await conversationWithReply(world, "t15", "evt-c15");
    const dying = world.boot({ target: "store", method: "appendDelivery", when: "after" });
    await diesDuring(
      () =>
        dying.service.applyDeliveryStatus(
          { conversationId: started.conversationId, messageKey: "evt-c15:reply", status: "delivered" },
          ACTOR,
        ),
      dying.crashed,
    );
    // The evidence row committed; the projection did not move.
    const deliveries = await world.store.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(deliveries).toHaveLength(1);
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-c15:reply",
    );
    expect(reply?.deliveryStatus).toBe("sent");
    // RESTART: the projection moves (or has already moved) exactly once.
    const restarted = world.boot(null);
    const applied = await restarted.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-c15:reply", status: "delivered" },
      ACTOR,
    );
    expect(applied.deliveryStatus).toBe("delivered");
    const finalDeliveries = await world.store.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(finalDeliveries).toHaveLength(1);
    expect(
      await operation(
        world,
        "delivery-apply",
        `${started.conversationId}:dlv-${started.conversationId}-evt-c15:reply-delivered`,
      ),
    ).toMatchObject({ status: "completed", attempts: 2 });
  });

  test("C16 DELIVERY: crash AFTER the projection move — the restart replays the outcome with no second evidence row", async () => {
    const world = await buildWorld();
    const started = await conversationWithReply(world, "t16", "evt-c16");
    const dying = world.boot({
      target: "store",
      method: "applyGuardedDeliveryStatusUpdate",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.applyDeliveryStatus(
          { conversationId: started.conversationId, messageKey: "evt-c16:reply", status: "delivered" },
          ACTOR,
        ),
      dying.crashed,
    );
    const reply = await world.store.findMessage(
      ACTOR.applicationId,
      started.conversationId,
      "evt-c16:reply",
    );
    expect(reply?.deliveryStatus).toBe("delivered");
    // RESTART: replay, no duplicate evidence, completed.
    const restarted = world.boot(null);
    const applied = await restarted.service.applyDeliveryStatus(
      { conversationId: started.conversationId, messageKey: "evt-c16:reply", status: "delivered" },
      ACTOR,
    );
    expect(applied.replayed).toBe(true);
    expect(applied.deliveryStatus).toBe("delivered");
    const deliveries = await world.store.listDeliveries(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(deliveries).toHaveLength(1);
    expect(
      await operation(
        world,
        "delivery-apply",
        `${started.conversationId}:dlv-${started.conversationId}-evt-c16:reply-delivered`,
      ),
    ).toMatchObject({ status: "completed", attempts: 2 });
  });

  // ---- HUMAN ESCALATION -----------------------------------------------------

  test("C17 ESCALATION: crash AFTER the governed wait step (before the rail notice) — the restart issues the notice exactly once", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t17");
    const dying = world.boot({ target: "ledger", method: "awaitHuman", when: "after" });
    await diesDuring(
      () =>
        dying.service.escalateToHuman(
          { conversationId: started.conversationId, cause: "fixture escalation" },
          "esc-c17",
          ACTOR,
        ),
      dying.crashed,
    );
    // The governed wait committed; no notice, no record.
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(railRecords(world, "escalate")).toHaveLength(0);
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-c17")).toBeNull();
    // RESTART: the notice happens now (exactly once), the record lands.
    const restarted = world.boot(null);
    const escalated = await restarted.service.escalateToHuman(
      { conversationId: started.conversationId, cause: "fixture escalation" },
      "esc-c17",
      ACTOR,
    );
    expect(escalated.escalationKey).toBe("esc-c17");
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-c17")).not.toBeNull();
    expect(await operation(world, "human-escalation", "esc-c17")).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C18 ESCALATION: crash AFTER the rail notice (before the checkpoint) — the restart re-issues under the SAME key and the rail converges", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t18");
    const dying = world.boot({ target: "rail", method: "escalate", when: "after" });
    await diesDuring(
      () =>
        dying.service.escalateToHuman(
          { conversationId: started.conversationId, cause: "fixture escalation" },
          "esc-c18",
          ACTOR,
        ),
      dying.crashed,
    );
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-c18")).toBeNull();
    // RESTART: the notice converges by key; the record + completion land.
    const restarted = world.boot(null);
    const escalated = await restarted.service.escalateToHuman(
      { conversationId: started.conversationId, cause: "fixture escalation" },
      "esc-c18",
      ACTOR,
    );
    expect(escalated.escalationKey).toBe("esc-c18");
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(world.rail.replays.filter((replay) => replay.kind === "escalate")).toHaveLength(1);
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-c18")).not.toBeNull();
    expect(await operation(world, "human-escalation", "esc-c18")).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C19 ESCALATION: crash AFTER the rail-issued checkpoint — the restart completes WITHOUT re-admission and WITHOUT a second rail call", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t19");
    const dying = world.boot({
      target: "store",
      method: "recordMessagingOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.escalateToHuman(
          { conversationId: started.conversationId, cause: "fixture escalation" },
          "esc-c19",
          ACTOR,
        ),
      dying.crashed,
    );
    const pending = await operation(world, "human-escalation", "esc-c19");
    expect(pending?.status).toBe("pending");
    expect(pending?.checkpoint?.stage).toBe("rail-issued");
    expect(railRecords(world, "escalate")).toHaveLength(1);
    // RESTART: the recovery path skips policy AND the rail.
    const restarted = world.boot(null);
    const escalated = await restarted.service.escalateToHuman(
      { conversationId: started.conversationId, cause: "fixture escalation" },
      "esc-c19",
      ACTOR,
    );
    expect(escalated.escalationKey).toBe("esc-c19");
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    // The admission seam ran exactly ONCE (the pre-crash pass).
    expect(world.policy.calls.filter((call) => call.action === "human-escalation")).toHaveLength(1);
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-c19")).not.toBeNull();
    expect(await operation(world, "human-escalation", "esc-c19")).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C20 ESCALATION: crash AFTER the escalation record — only the completion is missing; the restart reconciles and replays", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t20");
    const dying = world.boot({ target: "store", method: "insertEscalation", when: "after" });
    await diesDuring(
      () =>
        dying.service.escalateToHuman(
          { conversationId: started.conversationId, cause: "fixture escalation" },
          "esc-c20",
          ACTOR,
        ),
      dying.crashed,
    );
    expect(await world.store.findEscalation(ACTOR.applicationId, "esc-c20")).not.toBeNull();
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(await operation(world, "human-escalation", "esc-c20")).toMatchObject({
      status: "pending",
    });
    // RESTART: the record-reconciliation path completes the operation.
    const restarted = world.boot(null);
    const escalated = await restarted.service.escalateToHuman(
      { conversationId: started.conversationId, cause: "fixture escalation" },
      "esc-c20",
      ACTOR,
    );
    expect(escalated.replayed).toBe(true);
    expect(railRecords(world, "escalate")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(await operation(world, "human-escalation", "esc-c20")).toMatchObject({
      status: "completed",
    });
  });

  // ---- CONVERSATION CLOSE ---------------------------------------------------

  test("C21 CLOSE: crash AFTER the completion evidence — the restart converges (one rail close, one marker row, terminal)", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t21");
    const dying = world.boot({ target: "ledger", method: "recordEvidence", when: "after" });
    await diesDuring(
      () => dying.service.closeConversation({ conversationId: started.conversationId }, "close-c21", ACTOR),
      dying.crashed,
    );
    expect(
      world.ledger.evidence.some((entry) => entry.key === "messaging:completion:close-c21"),
    ).toBe(true);
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(conversation?.status).toBe("active");
    // RESTART: the close converges (the evidence replays by key).
    const restarted = world.boot(null);
    const closed = await restarted.service.closeConversation(
      { conversationId: started.conversationId },
      "close-c21",
      ACTOR,
    );
    expect(closed.replayed).toBe(true); // the resumed claim IS a replay (the honest marker)
    expect(railRecords(world, "close")).toHaveLength(1);
    const final = await world.store.findConversation(ACTOR.applicationId, started.conversationId);
    expect(final?.status).toBe("closed");
    const messages = await world.store.listMessages(ACTOR.applicationId, started.conversationId);
    expect(messages.filter((message) => message.eventKey === "close-c21:close")).toHaveLength(1);
    expect(await operation(world, "conversation-close", "close-c21")).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });

  test("C22 CLOSE: crash AFTER the terminal move (before the completion) — the terminal state IS the durable proof; the restart replays", async () => {
    const world = await buildWorld();
    const started = await liveConversation(world, "t22");
    const dying = world.boot({
      target: "store",
      method: "applyGuardedConversationMutation",
      when: "after",
    });
    await diesDuring(
      () => dying.service.closeConversation({ conversationId: started.conversationId }, "close-c22", ACTOR),
      dying.crashed,
    );
    // The terminal move committed; the operation row is PENDING.
    const conversation = await world.store.findConversation(
      ACTOR.applicationId,
      started.conversationId,
    );
    expect(conversation?.status).toBe("closed");
    expect(await operation(world, "conversation-close", "close-c22")).toMatchObject({
      status: "pending",
    });
    // RESTART: the terminal path reconciles and replays.
    const restarted = world.boot(null);
    const closed = await restarted.service.closeConversation(
      { conversationId: started.conversationId },
      "close-c22",
      ACTOR,
    );
    expect(closed.replayed).toBe(true);
    expect(railRecords(world, "close")).toHaveLength(1);
    expect(await operation(world, "conversation-close", "close-c22")).toMatchObject({
      status: "completed",
    });
  });

  // ---- KEY DISCIPLINE -------------------------------------------------------

  test("C23 KEY DISCIPLINE: the SAME event key on ANOTHER conversation is a different logical turn (no false convergence across crashes)", async () => {
    const world = await buildWorld();
    const startedA = await liveConversation(world, "t23a");
    const startedB = await liveConversation(world, "t23b");
    // Crash A mid-turn (after the responded checkpoint).
    const dyingA = world.boot({
      target: "store",
      method: "recordMessagingOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dyingA.service.ingestInboundEvent(userEvent(startedA.conversationId, "evt-same"), ACTOR),
      dyingA.crashed,
    );
    // Process B (a fresh boot) completes its turn with the SAME event key.
    const booted = world.boot(null);
    const outcomeB = await booted.service.ingestInboundEvent(
      userEvent(startedB.conversationId, "evt-same"),
      ACTOR,
    );
    expect(outcomeB.reply).not.toBeNull();
    // RESTART A: the recovery completes A's turn — a DIFFERENT durable
    // operation, a DIFFERENT send (no cross-conversation key collision).
    const restarted = world.boot(null);
    const outcomeA = await restarted.service.ingestInboundEvent(
      userEvent(startedA.conversationId, "evt-same"),
      ACTOR,
    );
    expect(outcomeA.reply?.messageKey).toBe("evt-same:reply");
    expect(railRecords(world, "send")).toHaveLength(2);
    expect(
      await operation(world, "turn-reply", `${startedA.conversationId}:evt-same`),
    ).toMatchObject({ status: "completed" });
    expect(
      await operation(world, "turn-reply", `${startedB.conversationId}:evt-same`),
    ).toMatchObject({ status: "completed" });
    // B's responder ran once; A's responder ran once (the pre-crash pass).
    expect(world.responder.calls).toHaveLength(2);
  });
});
