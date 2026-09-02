/**
 * Crash-injection proofs — the durable, recoverable operation state and
 * the STABLE rail-level idempotency keys (WORK-024; the architect's
 * crash-safety correction for PR #46; checkpoint contract
 * CONCURRENCY-CRASH-SAFETY).
 *
 * THE CRASH MODEL (kill/restart at the durable boundaries): a Zeck
 * process dies mid-operation. What survives a process crash:
 *   - the DURABLE STATE (the realtime store — sessions, the append-only
 *     journal, and the new realtime_operations ledger);
 *   - the EXECUTIONS LEDGER (its own durable module);
 *   - the UPSTREAM RAIL (the external provider — it keeps its
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
 * THE PROOF RECORDS (the four required lifecycle points):
 *   START              C1 claim | C2 rail-open | C3 checkpoint |
 *                      C4 durable insert | C5 evidence | C18 double crash
 *   INBOUND DELIVERY   C6 inbound claim | C7 responded checkpoint |
 *                      C8 rail delivery | C9 turn evidence
 *   TRANSFER           C10 rail transfer | C11 rail-issued checkpoint |
 *                      C12 terminal move
 *   CLOSE              C13 evidence | C14 journal | C15 terminal |
 *   (caller hangup)    C16 inbound claim | C17 hangup evidence
 *
 * Every record asserts the SAME invariants: EXACTLY ONE upstream rail
 * side effect per stable key (the rail `deliveries` observable — never
 * a second record, a retry converges through `replays`), the operation
 * row reaches COMPLETED with the honest attempts ledger, the durable
 * rows (session/journal/evidence) exist exactly once, and — for the
 * past-checkpoint recoveries — the paid-inference and admission seams
 * are NEVER re-invoked (the checkpoint's facts complete the durable
 * tail).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentPlanInput,
  DeploymentProfileInput,
  RealtimeActor,
  RealtimeBudgetReserveCommand,
  RealtimeCapabilityAdmissionRequest,
  RealtimeEvidenceInput,
  RealtimeExecutionLedger,
  RealtimeExecutionOpenInput,
  RealtimeInboundEventInput,
  RealtimeOperationKind,
  RealtimePolicyAdmissionRequest,
  RealtimeRouteClass,
  RealtimeSecretMediationRequest,
  RealtimeTurnResponderRequest,
  RealtimeTurnRouteRequest,
  StartRealtimeSessionInput,
} from "../../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessRealtimeRail,
  createModalityAdapterRegistry,
  createRealtimeSessionService,
  InMemoryDeploymentStore,
  InMemoryRealtimeStore,
  realtimeOperationKey,
} from "../../../src/modules/deployments/public";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");
const ACTOR: RealtimeActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

const PROFILE: DeploymentProfileInput = {
  profileId: "support-voice",
  modality: "realtime-voice",
  channelKinds: ["web", "telephony"],
  requiredCapabilities: ["realtime-conversation"],
  latencyClass: "realtime",
  resourceClass: "standard",
  sideEffectClass: "read-only",
  inputModalities: ["audio"],
  outputModalities: ["audio"],
};

const PLAN: DeploymentPlanInput = {
  planId: "support-voice-plan",
  profileRef: { profileId: "support-voice", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" as const },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" },
    { channelKind: "telephony", adapterCapabilityId: "telephony-channel-adapter" },
  ],
  sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
};

const CREATION: CreateDeploymentInput = {
  slug: "support-voice-prod",
  name: "Support voice",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck" as const,
  planId: "support-voice-plan",
};

// ---------------------------------------------------------------------------
// The recording fakes (the five admission seams + the responder; the
// executions-ledger in-memory model with key convergence on EVERY
// idempotent command — openExecution, recordEvidence, awaitHuman).
// ---------------------------------------------------------------------------

class FakePolicyAdmission {
  readonly calls: RealtimePolicyAdmissionRequest[] = [];
  deny = false;
  async admit(request: RealtimePolicyAdmissionRequest) {
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
  readonly calls: RealtimeCapabilityAdmissionRequest[] = [];
  unmet: string[] = [];
  async resolve(request: RealtimeCapabilityAdmissionRequest) {
    this.calls.push(request);
    return { satisfied: this.unmet.length === 0, unmet: this.unmet };
  }
}

class FakeBudgetAdmission {
  readonly reserves: RealtimeBudgetReserveCommand[] = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly releases: Array<Record<string, unknown>> = [];
  private seq = 0;
  private readonly reservationsByOperation = new Map<string, string>();
  async reserve(command: RealtimeBudgetReserveCommand) {
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
  readonly calls: RealtimeSecretMediationRequest[] = [];
  refuse = false;
  async mediate(request: RealtimeSecretMediationRequest) {
    this.calls.push(request);
    if (this.refuse) {
      return { mediated: false as const, reason: "fixture connection inactive" };
    }
    return { mediated: true as const, grantRef: "mediated:conn-1:cred" };
  }
}

class FakeRouter {
  readonly calls: RealtimeTurnRouteRequest[] = [];
  routeClass: RealtimeRouteClass = "generative";
  async routeTurn(request: RealtimeTurnRouteRequest) {
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
  readonly calls: RealtimeTurnResponderRequest[] = [];
  async respond(request: RealtimeTurnResponderRequest) {
    this.calls.push(request);
    return {
      responseRef: "artifact:responses/1",
      responsePreview: "fixture generative answer",
      actualCostMicroUsd: "10000",
    };
  }
}

/** The executions-ledger model: every command is key-idempotent. */
class FakeExecutionLedger implements RealtimeExecutionLedger {
  readonly opened: Array<{ key: string; input: RealtimeExecutionOpenInput }> = [];
  readonly evidence: Array<{ key: string; input: RealtimeEvidenceInput }> = [];
  readonly humanWaits: Array<{ key: string; input: Record<string, unknown> }> = [];
  private readonly executions = new Map<string, string>();
  private readonly evidenceKeys = new Set<string>();
  private readonly humanWaitKeys = new Set<string>();
  private seq = 0;
  private nextExecution = 0;
  async openExecution(input: RealtimeExecutionOpenInput, idempotencyKey: string) {
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
  async recordEvidence(input: RealtimeEvidenceInput, idempotencyKey: string) {
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
  readonly store: InMemoryRealtimeStore;
  readonly rail: ReturnType<typeof createInProcessRealtimeRail>;
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
    service: ReturnType<typeof createRealtimeSessionService>;
    crashed: () => boolean;
  };
}

async function buildWorld(): Promise<World> {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  for (const [capability, kinds] of [
    ["realtime-channel-adapter", ["web", "in-app"]],
    ["telephony-channel-adapter", ["telephony"]],
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

  const store = new InMemoryRealtimeStore();
  const rail = createInProcessRealtimeRail(["web", "in-app", "telephony"], { now });
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
    const service = createRealtimeSessionService({
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

const startInput = (world: World, callRef: string): StartRealtimeSessionInput => ({
  deploymentId: world.deploymentId,
  channelKind: "web",
  channelSessionRef: `call-${callRef}`,
  callerRef: `caller-${callRef}`,
});

const userTurn = (
  started: { sessionId: string; channelSessionRef: string; channelEpoch: number },
  eventKey: string,
): RealtimeInboundEventInput => ({
  sessionId: started.sessionId,
  channelSessionRef: started.channelSessionRef,
  channelEpoch: started.channelEpoch,
  kind: "user-turn",
  eventKey,
  payloadRef: "artifact:turns/1",
  payloadPreview: "customer question",
});

const hangup = (
  started: { sessionId: string; channelSessionRef: string; channelEpoch: number },
  eventKey: string,
): RealtimeInboundEventInput => ({
  sessionId: started.sessionId,
  channelSessionRef: started.channelSessionRef,
  channelEpoch: started.channelEpoch,
  kind: "caller-hangup",
  eventKey,
});

const railRecords = (world: World, kind: string) =>
  world.rail.deliveries.filter((record) => record.kind === kind);

const operation = (world: World, kind: RealtimeOperationKind, discriminator: string) =>
  world.store.findRealtimeOperation(ACTOR.applicationId, realtimeOperationKey(kind, discriminator));

describe("crash-injection proofs: durable operation state + stable rail keys (PR #46 correction)", () => {
  // ---- START ---------------------------------------------------------------

  test("C1 START: crash AFTER the durable operation claim — the retry completes; the claim-pinned identity survives", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "store", method: "beginRealtimeOperation", when: "after" });
    await diesDuring(
      () => dying.service.startSession(startInput(world, "c1"), "start-c1", ACTOR),
      dying.crashed,
    );
    // The claim committed and pinned the session identity BEFORE the crash.
    const claimed = await operation(world, "session-start", "start-c1");
    expect(claimed?.status).toBe("pending");
    const pinnedSessionId = claimed?.sessionId;
    expect(pinnedSessionId).toBeDefined();
    // RESTART: the same logical start completes with the pinned identity.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startSession(
      startInput(world, "c1"),
      "start-c1",
      ACTOR,
    );
    expect(outcome.sessionId).toBe(pinnedSessionId);
    expect(outcome.channelEpoch).toBe(1);
    // Exactly ONE upstream channel (the rail ledger has one open record).
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.openedSessions).toBe(1);
    expect(world.rail.replays).toHaveLength(0);
    // The operation completed with the honest attempts ledger (claimed, re-claimed).
    const completed = await operation(world, "session-start", "start-c1");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    expect(completed?.sessionId).toBe(pinnedSessionId);
    // One session row, one execution identity, one admission pass.
    expect(await world.store.findSessionByStartKey(ACTOR.applicationId, "start-c1")).not.toBeNull();
    expect(world.ledger.opened).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(1);
  });

  test("C2 START: crash AFTER the rail open (before the checkpoint) — the retry re-opens under the SAME key and the rail converges", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "rail", method: "openSession", when: "after" });
    await diesDuring(
      () => dying.service.startSession(startInput(world, "c2"), "start-c2", ACTOR),
      dying.crashed,
    );
    // The rail performed the upstream side effect; the session row does NOT exist.
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(await world.store.findSessionByStartKey(ACTOR.applicationId, "start-c2")).toBeNull();
    const allocated = railRecords(world, "open")[0]?.channelSessionRef;
    // RESTART: the retry runs the full pipeline; the rail open converges
    // on the SAME channel coordinates under the same stable key.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startSession(
      startInput(world, "c2"),
      "start-c2",
      ACTOR,
    );
    expect(outcome.channelSessionRef).toBe(allocated);
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.openedSessions).toBe(1);
    expect(world.rail.replays).toHaveLength(1);
    expect(world.rail.replays[0]?.kind).toBe("open");
    const completed = await operation(world, "session-start", "start-c2");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    // One execution identity (the ledger command converged by key).
    expect(world.ledger.opened).toHaveLength(1);
  });

  test("C3 START: crash AFTER the session-opened checkpoint — the retry resumes WITHOUT re-admission and WITHOUT a second rail call", async () => {
    const world = await buildWorld();
    const dying = world.boot({
      target: "store",
      method: "recordRealtimeOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dying.service.startSession(startInput(world, "c3"), "start-c3", ACTOR),
      dying.crashed,
    );
    const claimed = await operation(world, "session-start", "start-c3");
    expect(claimed?.status).toBe("pending");
    expect(claimed?.checkpoint?.stage).toBe("session-opened");
    expect(railRecords(world, "open")).toHaveLength(1);
    // RESTART: the recovery branch completes the durable tail from the
    // checkpoint — admission is NOT re-run, the rail is NOT re-called.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startSession(
      startInput(world, "c3"),
      "start-c3",
      ACTOR,
    );
    expect(outcome.sessionId).toBe(claimed?.sessionId);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(1);
    expect(world.ledger.opened).toHaveLength(1);
    const completed = await operation(world, "session-start", "start-c3");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    const session = await restarted.service.getSession(ACTOR.applicationId, outcome.sessionId);
    expect(session?.session.status).toBe("live");
    expect(session?.session.pinnedPlanVersion).toBe(1);
  });

  test("C4 START: crash AFTER the durable session insert — the replay fast path completes the provenance tail", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "store", method: "insertSession", when: "after" });
    const dyingOutcome = await dying.service
      .startSession(startInput(world, "c4"), "start-c4", ACTOR)
      .then(
        () => undefined,
        () => undefined,
      );
    expect(dying.crashed()).toBe(true);
    expect(dyingOutcome).toBeUndefined();
    // The session row exists; the operation is still PENDING.
    const persisted = await world.store.findSessionByStartKey(ACTOR.applicationId, "start-c4");
    expect(persisted).not.toBeNull();
    const pending = await operation(world, "session-start", "start-c4");
    expect(pending?.status).toBe("pending");
    // RESTART: the fast path completes the lost provenance tail.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startSession(
      startInput(world, "c4"),
      "start-c4",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.sessionId).toBe(persisted?.id);
    const completed = await operation(world, "session-start", "start-c4");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(1);
    // Exactly one session-started evidence record (the recovered tail).
    expect(
      world.ledger.evidence.filter((entry) => entry.key === "start-c4:session-started"),
    ).toHaveLength(1);
    expect(railRecords(world, "open")).toHaveLength(1);
  });

  test("C5 START: crash AFTER the start evidence — the retry converges the journal tail and completes", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "ledger", method: "recordEvidence", when: "after" });
    await diesDuring(
      () => dying.service.startSession(startInput(world, "c5"), "start-c5", ACTOR),
      dying.crashed,
    );
    // The evidence committed; the journal row and completion did not.
    expect(
      world.ledger.evidence.filter((entry) => entry.key === "start-c5:session-started"),
    ).toHaveLength(1);
    const pending = await operation(world, "session-start", "start-c5");
    expect(pending?.status).toBe("pending");
    // RESTART.
    const restarted = world.boot(null);
    const outcome = await restarted.service.startSession(
      startInput(world, "c5"),
      "start-c5",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    const events = await restarted.service.listSessionEvents(
      ACTOR.applicationId,
      outcome.sessionId,
    );
    expect(events.filter((event) => event.kind === "session-started")).toHaveLength(1);
    const completed = await operation(world, "session-start", "start-c5");
    expect(completed?.status).toBe("completed");
    expect(railRecords(world, "open")).toHaveLength(1);
  });

  test("C18 START: DOUBLE crash (claim, then checkpoint) — the third invocation converges (recovery of the recovery)", async () => {
    const world = await buildWorld();
    const first = world.boot({ target: "store", method: "beginRealtimeOperation", when: "after" });
    await diesDuring(
      () => first.service.startSession(startInput(world, "c18"), "start-c18", ACTOR),
      first.crashed,
    );
    const second = world.boot({
      target: "store",
      method: "recordRealtimeOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => second.service.startSession(startInput(world, "c18"), "start-c18", ACTOR),
      second.crashed,
    );
    // Two crash windows survived; the rail opened exactly once.
    expect(railRecords(world, "open")).toHaveLength(1);
    const claimed = await operation(world, "session-start", "start-c18");
    expect(claimed?.checkpoint?.stage).toBe("session-opened");
    // THIRD process: pure recovery from the checkpoint.
    const third = world.boot(null);
    const outcome = await third.service.startSession(startInput(world, "c18"), "start-c18", ACTOR);
    expect(outcome.sessionId).toBe(claimed?.sessionId);
    expect(railRecords(world, "open")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(1);
    const completed = await operation(world, "session-start", "start-c18");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(3);
  });

  // ---- INBOUND DELIVERY (user turns) ----------------------------------------

  async function startedWorld(suffix: string) {
    const world = await buildWorld();
    const boot = world.boot(null);
    const started = await boot.service.startSession(
      startInput(world, suffix),
      `start-${suffix}`,
      ACTOR,
    );
    return { world, started };
  }

  test("C6 TURN: crash AFTER the inbound claim — the retry runs the pipeline and delivers exactly once", async () => {
    const { world, started } = await startedWorld("c6");
    const dying = world.boot({ target: "store", method: "appendChannelEvent", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userTurn(started, "evt-c6"), ACTOR),
      dying.crashed,
    );
    // The inbound journal row committed; nothing else did.
    const events = await world.store.listEvents(ACTOR.applicationId, started.sessionId);
    expect(events.filter((event) => event.eventKey === "evt-c6")).toHaveLength(1);
    expect(railRecords(world, "deliver")).toHaveLength(0);
    // RESTART: the converged claim resumes the pipeline fresh.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(userTurn(started, "evt-c6"), ACTOR);
    expect(outcome.eventKey).toBe("evt-c6");
    expect(outcome.responsePreview).toBe("fixture generative answer");
    expect(railRecords(world, "deliver")).toHaveLength(1);
    expect(world.responder.calls).toHaveLength(1);
    expect(world.responder.calls[0]?.turnKey).toBe(`${started.sessionId}:evt-c6`);
    const completed = await operation(world, "turn-delivery", `${started.sessionId}:evt-c6`);
    expect(completed?.status).toBe("completed");
    // One inbound + one outbound journal row for the turn.
    const final = await world.store.listEvents(ACTOR.applicationId, started.sessionId);
    expect(final.filter((event) => event.eventKey === "evt-c6")).toHaveLength(1);
    expect(final.filter((event) => event.eventKey === "evt-c6:turn")).toHaveLength(1);
  });

  test("C7 TURN: crash AFTER the responded checkpoint — the retry delivers with the checkpointed facts and NEVER re-invokes the paid-inference seam", async () => {
    const { world, started } = await startedWorld("c7");
    const dying = world.boot({
      target: "store",
      method: "recordRealtimeOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userTurn(started, "evt-c7"), ACTOR),
      dying.crashed,
    );
    // Process 1 ran the FULL pipeline (admission + responder) and checkpointed.
    expect(world.responder.calls).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(2); // start + turn-dispatch
    expect(world.budget.reserves).toHaveLength(1);
    expect(railRecords(world, "deliver")).toHaveLength(0);
    // RESTART: the resumed delivery uses the checkpoint facts.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(userTurn(started, "evt-c7"), ACTOR);
    expect(outcome.responsePreview).toBe("fixture generative answer");
    expect(outcome.routeClass).toBe("generative");
    // The paid-inference seam was NOT re-invoked; admission was NOT re-run.
    expect(world.responder.calls).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(2);
    expect(world.router.calls).toHaveLength(1);
    expect(world.budget.reserves).toHaveLength(1); // no second reservation
    expect(world.budget.settles).toHaveLength(1); // the checkpointed reservation settled once
    // The rail delivered EXACTLY once (first call — process 1 never reached it).
    expect(railRecords(world, "deliver")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    const delivered = railRecords(world, "deliver")[0];
    expect(delivered?.cause).toBe("fixture planner decision"); // the checkpointed route rationale
    expect(delivered?.idempotencyKey).toBe(`rtrail:deliver:${started.sessionId}:evt-c7`);
    const completed = await operation(world, "turn-delivery", `${started.sessionId}:evt-c7`);
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
  });

  test("C8 TURN: crash AFTER the rail delivery (the external effect is issued) — the retry converges through the rail key, never a second delivery", async () => {
    const { world, started } = await startedWorld("c8");
    const dying = world.boot({ target: "rail", method: "deliverTurn", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userTurn(started, "evt-c8"), ACTOR),
      dying.crashed,
    );
    // The upstream delivery HAPPENED; nothing durable followed it.
    expect(railRecords(world, "deliver")).toHaveLength(1);
    const pending = await operation(world, "turn-delivery", `${started.sessionId}:evt-c8`);
    expect(pending?.status).toBe("pending");
    expect(pending?.checkpoint?.stage).toBe("responded");
    // RESTART: the retry re-delivers under the SAME key — the rail replays.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(userTurn(started, "evt-c8"), ACTOR);
    expect(outcome.responsePreview).toBe("fixture generative answer");
    expect(railRecords(world, "deliver")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(1);
    expect(world.rail.replays[0]?.kind).toBe("deliver");
    expect(world.rail.replays[0]?.idempotencyKey).toBe(
      `rtrail:deliver:${started.sessionId}:evt-c8`,
    );
    // The paid-inference seam was NOT re-invoked (checkpointed facts).
    expect(world.responder.calls).toHaveLength(1);
    expect(world.budget.settles).toHaveLength(1);
    const completed = await operation(world, "turn-delivery", `${started.sessionId}:evt-c8`);
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    const events = await world.store.listEvents(ACTOR.applicationId, started.sessionId);
    expect(events.filter((event) => event.eventKey === "evt-c8:turn")).toHaveLength(1);
  });

  test("C9 TURN: crash AFTER the turn evidence — the retry converges the journal and completes", async () => {
    const { world, started } = await startedWorld("c9");
    const dying = world.boot({ target: "ledger", method: "recordEvidence", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(userTurn(started, "evt-c9"), ACTOR),
      dying.crashed,
    );
    expect(
      world.ledger.evidence.filter(
        (entry) => entry.key === `realtime:turn:${started.sessionId}:evt-c9`,
      ),
    ).toHaveLength(1);
    const pending = await operation(world, "turn-delivery", `${started.sessionId}:evt-c9`);
    expect(pending?.status).toBe("pending");
    // RESTART.
    const restarted = world.boot(null);
    await restarted.service.ingestInboundEvent(userTurn(started, "evt-c9"), ACTOR);
    expect(railRecords(world, "deliver")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(1);
    expect(
      world.ledger.evidence.filter(
        (entry) => entry.key === `realtime:turn:${started.sessionId}:evt-c9`,
      ),
    ).toHaveLength(1);
    const events = await world.store.listEvents(ACTOR.applicationId, started.sessionId);
    expect(events.filter((event) => event.eventKey === "evt-c9:turn")).toHaveLength(1);
    const completed = await operation(world, "turn-delivery", `${started.sessionId}:evt-c9`);
    expect(completed?.status).toBe("completed");
  });

  // ---- TRANSFER -------------------------------------------------------------

  test("C10 TRANSFER: crash AFTER the rail transfer (before the checkpoint) — the retry re-transfers under the SAME key and the rail converges", async () => {
    const { world, started } = await startedWorld("c10");
    const dying = world.boot({ target: "rail", method: "transferCall", when: "after" });
    await diesDuring(
      () =>
        dying.service.transferToHuman(
          { sessionId: started.sessionId, destination: "support-tier-2", cause: "caller request" },
          "transfer-c10",
          ACTOR,
        ),
      dying.crashed,
    );
    // The upstream transfer HAPPENED; the session is NOT terminal yet.
    expect(railRecords(world, "transfer")).toHaveLength(1);
    const session = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(session?.status).toBe("live");
    // RESTART: the retry re-runs the wait and the transfer — the rail
    // converges on the original acknowledgment under the same key.
    const restarted = world.boot(null);
    const outcome = await restarted.service.transferToHuman(
      { sessionId: started.sessionId, destination: "support-tier-2", cause: "caller request" },
      "transfer-c10",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "transfer")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(1);
    expect(world.rail.replays[0]?.kind).toBe("transfer");
    const final = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(final?.status).toBe("transferred");
    const completed = await operation(world, "human-transfer", "transfer-c10");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
  });

  test("C11 TRANSFER: crash AFTER the rail-issued checkpoint — the retry completes WITHOUT re-admission and WITHOUT a second rail transfer", async () => {
    const { world, started } = await startedWorld("c11");
    const dying = world.boot({
      target: "store",
      method: "recordRealtimeOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.transferToHuman(
          { sessionId: started.sessionId, cause: "caller request" },
          "transfer-c11",
          ACTOR,
        ),
      dying.crashed,
    );
    expect(railRecords(world, "transfer")).toHaveLength(1);
    const claimed = await operation(world, "human-transfer", "transfer-c11");
    expect(claimed?.checkpoint?.stage).toBe("rail-issued");
    expect(claimed?.checkpoint?.deliveredAt).toBeDefined();
    // RESTART: no re-admission, no rail call — the durable tail completes.
    const restarted = world.boot(null);
    const outcome = await restarted.service.transferToHuman(
      { sessionId: started.sessionId, cause: "caller request" },
      "transfer-c11",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "transfer")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(2); // start + the ORIGINAL transfer admission only
    const final = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(final?.status).toBe("transferred");
    const completed = await operation(world, "human-transfer", "transfer-c11");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
  });

  test("C12 TRANSFER: crash AFTER the terminal move — the retry reconciles the pending operation and replays", async () => {
    const { world, started } = await startedWorld("c12");
    const dying = world.boot({
      target: "store",
      method: "applyGuardedSessionMutation",
      when: "after",
    });
    await diesDuring(
      () => dying.service.transferToHuman({ sessionId: started.sessionId }, "transfer-c12", ACTOR),
      dying.crashed,
    );
    // The terminal status IS the durable proof; the operation is PENDING.
    const terminal = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(terminal?.status).toBe("transferred");
    const pending = await operation(world, "human-transfer", "transfer-c12");
    expect(pending?.status).toBe("pending");
    // RESTART: the transferred-status reconciliation completes the op.
    const restarted = world.boot(null);
    const outcome = await restarted.service.transferToHuman(
      { sessionId: started.sessionId },
      "transfer-c12",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "transfer")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    const completed = await operation(world, "human-transfer", "transfer-c12");
    expect(completed?.status).toBe("completed");
  });

  // ---- CLOSE (graceful close) ------------------------------------------------

  test("C13 CLOSE: crash AFTER the completion evidence — the retry closes exactly once", async () => {
    const { world, started } = await startedWorld("c13");
    const dying = world.boot({ target: "ledger", method: "recordEvidence", when: "after" });
    await diesDuring(
      () => dying.service.closeSession({ sessionId: started.sessionId }, "close-c13", ACTOR),
      dying.crashed,
    );
    expect(
      world.ledger.evidence.filter((entry) => entry.key === "realtime:completion:close-c13"),
    ).toHaveLength(1);
    expect(railRecords(world, "close")).toHaveLength(0);
    // RESTART: the close completes (the rail close fires for the first time).
    const restarted = world.boot(null);
    await restarted.service.closeSession({ sessionId: started.sessionId }, "close-c13", ACTOR);
    expect(railRecords(world, "close")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    const final = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(final?.status).toBe("closed");
    const completed = await operation(world, "session-close", "close-c13");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
  });

  test("C14 CLOSE: crash AFTER the rail close (the journal committed) — the retry converges through the rail key", async () => {
    const { world, started } = await startedWorld("c14");
    const dying = world.boot({ target: "store", method: "appendChannelEvent", when: "after" });
    await diesDuring(
      () => dying.service.closeSession({ sessionId: started.sessionId }, "close-c14", ACTOR),
      dying.crashed,
    );
    // The rail close was issued (once); the terminal move did NOT commit.
    expect(railRecords(world, "close")).toHaveLength(1);
    const live = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(live?.status).toBe("live");
    // RESTART: the retry re-closes under the SAME key — the rail replays.
    const restarted = world.boot(null);
    await restarted.service.closeSession({ sessionId: started.sessionId }, "close-c14", ACTOR);
    expect(railRecords(world, "close")).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(1);
    expect(world.rail.replays[0]?.kind).toBe("close");
    expect(world.rail.replays[0]?.idempotencyKey).toBe("rtrail:close:close-c14");
    const final = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(final?.status).toBe("closed");
    const completed = await operation(world, "session-close", "close-c14");
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
  });

  test("C15 CLOSE: crash AFTER the terminal move — the retry reconciles and replays", async () => {
    const { world, started } = await startedWorld("c15");
    const dying = world.boot({
      target: "store",
      method: "applyGuardedSessionMutation",
      when: "after",
    });
    await diesDuring(
      () => dying.service.closeSession({ sessionId: started.sessionId }, "close-c15", ACTOR),
      dying.crashed,
    );
    const terminal = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(terminal?.status).toBe("closed");
    const pending = await operation(world, "session-close", "close-c15");
    expect(pending?.status).toBe("pending");
    // RESTART.
    const restarted = world.boot(null);
    const outcome = await restarted.service.closeSession(
      { sessionId: started.sessionId },
      "close-c15",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(railRecords(world, "close")).toHaveLength(1);
    const completed = await operation(world, "session-close", "close-c15");
    expect(completed?.status).toBe("completed");
  });

  // ---- CLOSE (caller hangup through the inbound path) -------------------------

  test("C16 HANGUP: crash AFTER the inbound hangup claim — the retry recovers the close through the converged claim", async () => {
    const { world, started } = await startedWorld("c16");
    const dying = world.boot({ target: "store", method: "appendChannelEvent", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(hangup(started, "hangup-c16"), ACTOR),
      dying.crashed,
    );
    // The inbound session-completed row committed; the close did not.
    const events = await world.store.listEvents(ACTOR.applicationId, started.sessionId);
    expect(
      events.filter((event) => event.direction === "inbound" && event.eventKey === "hangup-c16"),
    ).toHaveLength(1);
    expect(railRecords(world, "close")).toHaveLength(0);
    // RESTART: the converged claim path recovers (no terminal rejection).
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      hangup(started, "hangup-c16"),
      ACTOR,
    );
    expect(outcome.kind).toBe("caller-hangup");
    expect(railRecords(world, "close")).toHaveLength(1);
    const final = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(final?.status).toBe("closed");
    // The hangup close operation completed (discriminated by the
    // SESSION-SCOPED inbound event key — the same hangup retry derives
    // the same key).
    const completed = await operation(
      world,
      "session-close",
      `${started.sessionId}:hangup-c16:hangup`,
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.operationKey).toBe(
      realtimeOperationKey("session-close", `${started.sessionId}:hangup-c16:hangup`),
    );
  });

  test("C17 HANGUP: crash AFTER the hangup completion evidence — the retry closes exactly once", async () => {
    const { world, started } = await startedWorld("c17");
    const dying = world.boot({ target: "ledger", method: "recordEvidence", when: "after" });
    await diesDuring(
      () => dying.service.ingestInboundEvent(hangup(started, "hangup-c17"), ACTOR),
      dying.crashed,
    );
    // The hangup close operation was claimed; the evidence committed; the
    // rail close and the terminal move did not.
    const pending = await operation(
      world,
      "session-close",
      `${started.sessionId}:hangup-c17:hangup`,
    );
    expect(pending?.status).toBe("pending");
    expect(railRecords(world, "close")).toHaveLength(0);
    // RESTART: the hangup retry recovers through the converged inbound claim.
    const restarted = world.boot(null);
    const outcome = await restarted.service.ingestInboundEvent(
      hangup(started, "hangup-c17"),
      ACTOR,
    );
    expect(outcome.kind).toBe("caller-hangup");
    expect(railRecords(world, "close")).toHaveLength(1);
    const final = await world.store.findSession(ACTOR.applicationId, started.sessionId);
    expect(final?.status).toBe("closed");
    const completed = await operation(
      world,
      "session-close",
      `${started.sessionId}:hangup-c17:hangup`,
    );
    expect(completed?.status).toBe("completed");
  });

  // ---- The stable-key discipline across the whole lifecycle -------------------

  test("C19: the rail keys are DISTINCT per operation kind, session-scoped for event keys, and stable across restarts", async () => {
    const { world, started } = await startedWorld("c19");
    const first = world.boot(null);
    // start (already done) + turn + transfer under explicit keys.
    await first.service.ingestInboundEvent(userTurn(started, "evt-c19"), ACTOR);
    await first.service.transferToHuman({ sessionId: started.sessionId }, "transfer-c19", ACTOR);
    const keys = new Set(world.rail.deliveries.map((record) => record.idempotencyKey));
    // The event-derived deliver key is SESSION-SCOPED (event keys are
    // unique per session, not per application).
    expect(keys.has(`rtrail:deliver:${started.sessionId}:evt-c19`)).toBe(true);
    expect(keys.has("rtrail:transfer:transfer-c19")).toBe(true);
    expect(railRecords(world, "open")[0]?.idempotencyKey).toBe("rtrail:open:start-c19");
    // A SECOND session may legitimately REUSE the same upstream event key:
    // the session-scoped discriminators make them DISTINCT operations and
    // DISTINCT rail deliveries (never a collision, never a false replay).
    const second = world.boot(null);
    const started2 = await second.service.startSession(
      startInput(world, "c19b"),
      "start-c19b",
      ACTOR,
    );
    const outcome2 = await second.service.ingestInboundEvent(userTurn(started2, "evt-c19"), ACTOR);
    expect(outcome2.replayed).toBe(false);
    expect(railRecords(world, "deliver")).toHaveLength(2);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(2);
    const opA = await operation(world, "turn-delivery", `${started.sessionId}:evt-c19`);
    const opB = await operation(world, "turn-delivery", `${started2.sessionId}:evt-c19`);
    expect(opA?.id).not.toBe(opB?.id);
    expect(opA?.status).toBe("completed");
    expect(opB?.status).toBe("completed");
    // The executions-ledger evidence keys are session-scoped too: both
    // turns carry their own provenance records.
    expect(
      world.ledger.evidence.filter(
        (entry) => entry.key === `realtime:turn:${started.sessionId}:evt-c19`,
      ),
    ).toHaveLength(1);
    expect(
      world.ledger.evidence.filter(
        (entry) => entry.key === `realtime:turn:${started2.sessionId}:evt-c19`,
      ),
    ).toHaveLength(1);
  });
});
