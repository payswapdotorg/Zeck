/**
 * Unit tests — the realtime session service over the in-memory world
 * (WORK-024, MOD-005/006/007; the runtime halves of the acceptance
 * criteria and the required safety proofs).
 *
 * The world: the REAL deployment fabric (InMemoryDeploymentStore +
 * createDeploymentService) + the REAL in-memory realtime store + the REAL
 * in-process simulated rail + recording fakes for the five admission
 * seams (policy/capability/budget/secrets/router) and the responder, and
 * an in-memory execution-ledger fake that models the executions public
 * seam's contract (idempotent open, sequenced evidence, wait-human
 * transitions). The fakes record every call so the ordering proofs
 * (admission BEFORE side effects) are mechanically observable.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  RealtimeActor,
  RealtimeInboundEventInput,
  RealtimeRouteClass,
  RealtimeSessionServiceDeps,
  StartRealtimeSessionInput,
} from "../../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessRealtimeRail,
  createModalityAdapterRegistry,
  createRealtimeSessionService,
  InMemoryDeploymentStore,
  InMemoryRealtimeStore,
} from "../../../src/modules/deployments/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const ACTOR: RealtimeActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const OTHER_TENANT_ACTOR: RealtimeActor = {
  actorId: "00000000-0000-7000-8000-0000000000f1",
  applicationId: ACTOR.applicationId,
  tenantId: "00000000-0000-7000-8000-0000000000f3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

const PROFILE = {
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

const planInput = (overrides: Record<string, unknown> = {}) => ({
  planId: "support-voice-plan",
  profileRef: { profileId: "support-voice", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" },
    { channelKind: "telephony", adapterCapabilityId: "telephony-channel-adapter" },
  ],
  sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
  ...overrides,
});

const CREATION = {
  slug: "support-voice-prod",
  name: "Support voice",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck",
  planId: "support-voice-plan",
};

/** Recording fake: the policy admission seam. */
class FakePolicyAdmission {
  readonly calls: Array<Record<string, unknown>> = [];
  deny = false;
  constructor(private readonly onCall: (call: Record<string, unknown>) => void = () => {}) {}
  async admit(request: Record<string, unknown>) {
    this.calls.push(request);
    this.onCall(request);
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

/** Recording fake: the capability admission seam. */
class FakeCapabilityAdmission {
  readonly calls: Array<Record<string, unknown>> = [];
  unmet: string[] = [];
  constructor(private readonly onCall: (call: Record<string, unknown>) => void = () => {}) {}
  async resolve(request: Record<string, unknown>) {
    this.calls.push(request);
    this.onCall(request);
    return { satisfied: this.unmet.length === 0, unmet: this.unmet };
  }
}

/** Recording fake: the budget admission seam. */
class FakeBudgetAdmission {
  readonly reserves: Array<Record<string, unknown>> = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly releases: Array<Record<string, unknown>> = [];
  failReserve = false;
  private seq = 0;
  async reserve(command: Record<string, unknown>) {
    this.reserves.push(command);
    if (this.failReserve) {
      throw new PlatformError({
        code: "BUDGET_EXCEEDED",
        message: "fixture exhausted budget",
      });
    }
    this.seq += 1;
    return {
      reservationId: `resv-${this.seq}`,
      amountMicroUsd: String(command.amountMicroUsd ?? "0"),
      converged: false,
    };
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

/** Recording fake: the secret mediation seam. */
class FakeSecretMediation {
  readonly calls: Array<Record<string, unknown>> = [];
  refuse = false;
  constructor(private readonly onCall: (call: Record<string, unknown>) => void = () => {}) {}
  async mediate(request: Record<string, unknown>) {
    this.calls.push(request);
    this.onCall(request);
    if (this.refuse) {
      return { mediated: false as const, reason: "fixture connection inactive" };
    }
    return { mediated: true as const, grantRef: "mediated:conn-1:cred" };
  }
}

/** Recording fake: the planner-decided subtask router. */
class FakeRouter {
  readonly calls: Array<Record<string, unknown>> = [];
  routeClass: RealtimeRouteClass = "generative";
  constructor(private readonly onCall: (call: Record<string, unknown>) => void = () => {}) {}
  async routeTurn(request: Record<string, unknown>) {
    this.calls.push(request);
    this.onCall(request);
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

/** Recording fake: the deployed agent's turn responder. */
class FakeResponder {
  readonly calls: Array<Record<string, unknown>> = [];
  constructor(private readonly onCall: (call: Record<string, unknown>) => void = () => {}) {}
  async respond(request: Record<string, unknown>) {
    this.calls.push(request);
    this.onCall(request);
    return {
      responseRef: "artifact:responses/1",
      responsePreview: "fixture deterministic answer",
      actualCostMicroUsd: "0",
    };
  }
}

/** In-memory model of the executions public seam (the ledger port). */
class FakeExecutionLedger {
  readonly opened: Array<{ key: string; input: Record<string, unknown> }> = [];
  readonly evidence: Array<{ key: string; input: Record<string, unknown> }> = [];
  readonly humanWaits: Array<{ key: string; input: Record<string, unknown> }> = [];
  readonly resumes: Array<{ key: string; input: Record<string, unknown> }> = [];
  private seq = 0;
  private nextExecution = 0;
  async openExecution(input: Record<string, unknown>, idempotencyKey: string) {
    const existing = this.opened.find((entry) => entry.key === idempotencyKey);
    if (existing !== undefined) {
      const executionId = String(existing.input.task && "x");
      void executionId;
      const first = this.executions.get(idempotencyKey);
      if (first !== undefined) {
        return { executionId: first, replayed: true, status: "running" };
      }
    }
    this.nextExecution += 1;
    const executionId = `00000000-0000-7000-8000-${String(this.nextExecution).padStart(12, "0")}`;
    this.executions.set(idempotencyKey, executionId);
    this.opened.push({ key: idempotencyKey, input });
    return { executionId, replayed: false, status: "running" };
  }
  private readonly executions = new Map<string, string>();
  private readonly evidenceKeys = new Set<string>();
  async recordEvidence(input: Record<string, unknown>, idempotencyKey: string) {
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
    this.humanWaits.push({ key: idempotencyKey, input });
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
  async continueAfterHuman(input: Record<string, unknown>, idempotencyKey: string) {
    this.resumes.push({ key: idempotencyKey, input });
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
}

interface RealtimeWorld {
  readonly service: ReturnType<typeof createRealtimeSessionService>;
  readonly store: InMemoryRealtimeStore;
  readonly rail: ReturnType<typeof createInProcessRealtimeRail>;
  readonly policy: FakePolicyAdmission;
  readonly capabilities: FakeCapabilityAdmission;
  readonly budget: FakeBudgetAdmission;
  readonly secrets: FakeSecretMediation;
  readonly router: FakeRouter;
  readonly responder: FakeResponder;
  readonly ledger: FakeExecutionLedger;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
}

function buildWorld(): RealtimeWorld {
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

  const store = new InMemoryRealtimeStore();
  const rail = createInProcessRealtimeRail(["web", "in-app", "telephony"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const policy = new FakePolicyAdmission();
  const capabilities = new FakeCapabilityAdmission();
  const budget = new FakeBudgetAdmission();
  const secrets = new FakeSecretMediation();
  const router = new FakeRouter();
  const responder = new FakeResponder();
  const ledger = new FakeExecutionLedger();

  const deps: RealtimeSessionServiceDeps = {
    store,
    deployments: deploymentStore,
    rail,
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
  const service = createRealtimeSessionService(deps);
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
    deploymentService,
    deploymentId: "",
  };
}

async function seededWorld(): Promise<RealtimeWorld> {
  const world = buildWorld();
  const actor = {
    actorId: ACTOR.actorId,
    applicationId: ACTOR.applicationId,
    tenantId: ACTOR.tenantId,
  };
  await world.deploymentService.publishProfile(
    { ...PROFILE } as never,
    { version: 1 },
    actor as never,
  );
  await world.deploymentService.publishPlan(planInput() as never, { version: 1 }, actor as never);
  const created = await world.deploymentService.createDeployment(
    { ...CREATION },
    "deploy-key-0",
    actor as never,
  );
  world.deploymentId = created.deploymentId;
  // Plan v2 exists (for promotion/pinning proofs).
  await world.deploymentService.publishPlan(
    planInput({
      sessionPolicy: { maxSessionDurationMs: 300_000, maxConcurrentSessions: 4 },
    }) as never,
    { version: 2 },
    actor as never,
  );
  return world;
}

const startInput = (overrides: Record<string, unknown> = {}): StartRealtimeSessionInput =>
  ({
    deploymentId: "00000000-0000-0000-0000-000000000000", // replaced per-world below
    channelKind: "web",
    channelSessionRef: "simrail-session-1",
    ...overrides,
  }) as StartRealtimeSessionInput;

async function startSession(
  world: RealtimeWorld,
  key = "start-1",
  actor: RealtimeActor = ACTOR,
  overrides: Record<string, unknown> = {},
) {
  return world.service.startSession(
    { ...startInput(overrides), deploymentId: world.deploymentId },
    key,
    actor,
  );
}

const turn = (
  sessionId: string,
  channelSessionRef: string,
  channelEpoch: number,
  overrides: Record<string, unknown> = {},
): RealtimeInboundEventInput =>
  ({
    sessionId,
    channelSessionRef,
    channelEpoch,
    kind: "user-turn",
    payloadPreview: "what is my balance?",
    payloadRef: "artifact:turns/1",
    subtaskKind: "data-retrieval",
    ...overrides,
  }) as RealtimeInboundEventInput;

describe("realtime session service: startSession (AC1/AC3)", () => {
  test("a happy start binds tenant, deployment, pinned plan version and execution identity", async () => {
    const world = await seededWorld();
    const outcome = await startSession(world, "start-1");
    expect(outcome.replayed).toBe(false);
    expect(outcome.channelEpoch).toBe(1);
    const session = await world.service.getSession(ACTOR.applicationId, outcome.sessionId);
    expect(session).not.toBeNull();
    expect(session?.session.tenantId).toBe(ACTOR.tenantId);
    expect(session?.session.applicationId).toBe(ACTOR.applicationId);
    expect(session?.session.deploymentId).toBe(world.deploymentId);
    expect(session?.session.pinnedPlanId).toBe("support-voice-plan");
    expect(session?.session.pinnedPlanVersion).toBe(1);
    expect(session?.session.executionId).toBe(outcome.executionId);
    expect(session?.session.status).toBe("live");
    // The rail opened exactly one channel session (AC2 — the adapter path).
    expect(world.rail.openedSessions).toBe(1);
    // Provenance: session-started on the execution ledger + the journal.
    expect(
      world.ledger.evidence.some(
        (entry) =>
          String((entry.input as Record<string, unknown>).evidenceClass) === "session-started",
      ),
    ).toBe(true);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, outcome.sessionId);
    expect(events.map((event) => event.kind)).toContain("session-started");
    expect(
      events.find((event) => event.kind === "session-started")?.ledgerSequence,
    ).toBeGreaterThan(0);
  });

  test("a telephony-style channel starts through the same neutral contract (AC1)", async () => {
    const world = await seededWorld();
    const outcome = await startSession(world, "start-tele", ACTOR, {
      channelKind: "telephony",
      channelSessionRef: "simrail-call-9",
      callerRef: "+15550100",
    });
    const session = await world.service.getSession(ACTOR.applicationId, outcome.sessionId);
    expect(session?.session.channelKind).toBe("telephony");
    expect(session?.session.callerRef).toBe("+15550100");
    expect(session?.session.channelSessionRef).toBe("simrail-call-9");
  });

  test("an idempotent replay returns the SAME session and execution (AC7)", async () => {
    const world = await seededWorld();
    const first = await startSession(world, "start-1");
    const second = await startSession(world, "start-1");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    // No second rail allocation, no second execution open.
    expect(world.rail.openedSessions).toBe(1);
    expect(world.ledger.opened).toHaveLength(1);
  });

  test("a reused start key with a different body fails closed (IDEMPOTENCY_KEY_REUSED)", async () => {
    const world = await seededWorld();
    await startSession(world, "start-1");
    await expect(
      startSession(world, "start-1", ACTOR, { channelSessionRef: "simrail-session-2" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("S1: an unauthorized tenant cannot start or operate another tenant's session", async () => {
    const world = await seededWorld();
    // The deployment belongs to ACTOR's tenant; the other-tenant actor
    // resolves deployment facts through the application and is refused
    // by the tenant guard.
    await expect(startSession(world, "start-x", OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    const started = await startSession(world, "start-1");
    // Reads are application-scoped (the repo's read convention — the API
    // layer derives applicationId from the authenticated membership);
    // another APPLICATION sees nothing.
    await expect(
      world.service.listSessionEvents("00000000-0000-7000-8000-0000000000ee", started.sessionId),
    ).resolves.toEqual([]);
    // OPERATIONS carry the actor and fail closed across tenants.
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch),
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.closeSession({ sessionId: started.sessionId }, "close-x", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.transferToHuman(
        { sessionId: started.sessionId },
        "transfer-x",
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.reattachSession(
        { sessionId: started.sessionId, newChannelSessionRef: "simrail-session-hijack" },
        "reattach-x",
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("S2: policy denial happens BEFORE any side effect (session start)", async () => {
    const world = await seededWorld();
    world.policy.deny = true;
    await expect(startSession(world, "start-denied")).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    // ZERO rail activity and ZERO execution identity establishment.
    expect(world.rail.deliveries).toHaveLength(0);
    expect(world.rail.openedSessions).toBe(0);
    expect(world.ledger.opened).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(1);
    expect((world.policy.calls[0] as Record<string, unknown>).action).toBe("session-start");
  });

  test("a suspended deployment refuses session starts (state gate)", async () => {
    const world = await seededWorld();
    const actor = {
      actorId: ACTOR.actorId,
      applicationId: ACTOR.applicationId,
      tenantId: ACTOR.tenantId,
    };
    await world.deploymentService.suspendDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "suspend-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    void actor;
    await expect(startSession(world, "start-suspended")).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
    });
  });

  test("fail-closed input validation (malformed starts)", async () => {
    const world = await seededWorld();
    await expect(
      startSession(world, "start-bad", ACTOR, { channelKind: "sms" }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await expect(
      startSession(world, "start-bad", ACTOR, { channelSessionRef: "" }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await expect(
      world.service.startSession(
        { ...startInput(), deploymentId: world.deploymentId },
        "not a printable key!",
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    await expect(
      world.service.startSession(
        {
          ...startInput(),
          deploymentId: "00000000-0000-7000-8000-0000000000ee",
        },
        "start-unknown-deployment",
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

describe("realtime session service: ingestInboundEvent (user turns)", () => {
  test("a generative turn runs the FULL admission chain then delivers on the rail", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-1");
    const outcome = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        eventKey: "evt-1",
      }),
      ACTOR,
    );
    expect(outcome.routeClass).toBe("generative");
    expect(outcome.responsePreview).toBe("fixture deterministic answer");
    expect(outcome.replayed).toBe(false);
    // Exactly ONE rail delivery.
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
    // The admission chain ran in order: policy → capability → budget → secret.
    expect(world.policy.calls).toHaveLength(2); // start + turn
    expect((world.policy.calls[1] as Record<string, unknown>).action).toBe("turn-dispatch");
    expect(world.capabilities.calls).toHaveLength(1);
    expect(world.budget.reserves).toHaveLength(1);
    expect(world.budget.settles).toHaveLength(1);
    expect(world.secrets.calls).toHaveLength(1);
    // The responder saw the reservation id and the mediated grant ref.
    expect((world.responder.calls[0] as Record<string, unknown>).reservationId).toBe("resv-1");
    expect((world.responder.calls[0] as Record<string, unknown>).channelGrantRef).toBe(
      "mediated:conn-1:cred",
    );
    // Turn provenance rode the execution ledger and the journal.
    expect(
      world.ledger.evidence.some(
        (entry) => String((entry.input as Record<string, unknown>).evidenceClass) === "turn",
      ),
    ).toBe(true);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    const outboundTurn = events.find(
      (event) => event.kind === "turn-recorded" && event.direction === "outbound",
    );
    expect(outboundTurn?.routeClass).toBe("generative");
    expect(outboundTurn?.ledgerSequence).toBeGreaterThan(0);
    expect(outboundTurn?.payloadRef).toBe("artifact:responses/1");
  });

  test("S12: a DETERMINISTIC route needs NO budget reservation (no paid dispatch)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-det");
    world.router.routeClass = "deterministic";
    const outcome = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        eventKey: "evt-det",
        subtaskKind: "data-retrieval",
      }),
      ACTOR,
    );
    expect(outcome.routeClass).toBe("deterministic");
    expect(world.budget.reserves).toHaveLength(0);
    expect(world.budget.settles).toHaveLength(0);
    // The deterministic turn still delivers on the rail (the governed
    // side effect) and records provenance.
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
    expect(
      world.ledger.evidence.some((entry) => {
        const input = entry.input as Record<string, unknown>;
        return (
          input.evidenceClass === "turn" &&
          (input.payload as Record<string, unknown>).routeClass === "deterministic"
        );
      }),
    ).toBe(true);
  });

  test("a HYBRID route reserves budget (the paid remainder is admissible)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-hyb");
    world.router.routeClass = "hybrid";
    const outcome = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        eventKey: "evt-hyb",
      }),
      ACTOR,
    );
    expect(outcome.routeClass).toBe("hybrid");
    expect(world.budget.reserves).toHaveLength(1);
  });

  test("S2: policy denial at turn dispatch happens BEFORE delivery, responder and budget", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-deny");
    world.policy.deny = true;
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-denied",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(0);
    // The denial is durably recorded (journal-then-fail) on both ledgers.
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(
      events.some(
        (event) => event.kind === "failure-recorded" && event.eventKey.startsWith("denial:"),
      ),
    ).toBe(true);
    expect(
      world.ledger.evidence.some(
        (entry) =>
          String((entry.input as Record<string, unknown>).evidenceClass) === "significant-action",
      ),
    ).toBe(true);
  });

  test("S3: a missing capability cannot dispatch (before delivery and responder)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-cap");
    world.capabilities.unmet = ["realtime-conversation"];
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-cap",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(0);
  });

  test("S4: a denied budget prevents the paid dispatch (before delivery, responder settles nothing)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-budget");
    world.budget.failReserve = true;
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-budget",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    expect(world.secrets.calls).toHaveLength(0);
  });

  test("S5: refused secret mediation prevents the delivery and RELEASES the reservation", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-secret");
    world.secrets.refuse = true;
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-secret",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    // The paid reservation was reserved then released (no leak).
    expect(world.budget.reserves).toHaveLength(1);
    expect(world.budget.releases).toHaveLength(1);
    expect(world.budget.settles).toHaveLength(0);
  });

  test("a failed rail delivery records failure provenance and releases the reservation", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-railfail");
    world.rail.failNextDelivery("fixture rail outage");
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-railfail",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(world.budget.releases).toHaveLength(1);
    expect(
      world.ledger.evidence.some(
        (entry) => String((entry.input as Record<string, unknown>).evidenceClass) === "failure",
      ),
    ).toBe(true);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.some((event) => event.kind === "failure-recorded")).toBe(true);
  });

  test("S6: duplicate inbound events do NOT duplicate execution side effects", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-dup");
    const input = turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
      eventKey: "evt-dup",
    });
    const first = await world.service.ingestInboundEvent(input, ACTOR);
    const second = await world.service.ingestInboundEvent(input, ACTOR);
    expect(second.replayed).toBe(true);
    expect(second.eventKey).toBe(first.eventKey);
    expect(second.routeClass).toBe(first.routeClass);
    expect(second.responsePreview).toBe(first.responsePreview);
    // EXACTLY ONE delivery, ONE responder call, ONE reserve, ONE settle.
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
    expect(world.responder.calls).toHaveLength(1);
    expect(world.budget.reserves).toHaveLength(1);
    expect(world.budget.settles).toHaveLength(1);
    // The journal holds ONE inbound claim row for the key.
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.filter((event) => event.eventKey === "evt-dup")).toHaveLength(1);
  });

  test("the deterministic substitute key: same coordinates+ordinal converges; distinct ordinals do not", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-subst");
    // No upstream event id: the substitute derives from coordinates +
    // kind + occurrence ordinal.
    const a = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        occurrenceOrdinal: 1,
      }),
      ACTOR,
    );
    const b = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        occurrenceOrdinal: 1,
      }),
      ACTOR,
    );
    expect(b.replayed).toBe(true);
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
    // A distinct ordinal is a DISTINCT event (a second turn).
    const c = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        occurrenceOrdinal: 2,
      }),
      ACTOR,
    );
    expect(c.replayed).toBe(false);
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(2);
    expect(a.eventKey).not.toBe(c.eventKey);
  });

  test("a same-key/different-body inbound claim fails closed (poisoned replay)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-poison");
    await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        eventKey: "evt-poison",
      }),
      ACTOR,
    );
    // Same key, different body → the idempotency ledger refuses.
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-poison",
          payloadPreview: "a completely different turn body",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("raw-secret-looking turn payloads are rejected (validation)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-secretish");
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-secretish",
          payloadPreview: "api_key: supersecretvalue",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});

describe("realtime session service: interruption, hangup, transfer (AC4)", () => {
  test("an interruption records provenance and performs NO dispatch", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-int");
    const outcome = await world.service.ingestInboundEvent(
      {
        sessionId: started.sessionId,
        channelSessionRef: started.channelSessionRef,
        channelEpoch: started.channelEpoch,
        kind: "interruption",
        payloadPreview: "wait, actually—",
      },
      ACTOR,
    );
    expect(outcome.kind).toBe("interruption");
    expect(outcome.routeClass).toBeNull();
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.responder.calls).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(1); // only the session-start admission
    expect(
      world.ledger.evidence.some(
        (entry) =>
          String((entry.input as Record<string, unknown>).evidenceClass) === "interruption",
      ),
    ).toBe(true);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.some((event) => event.kind === "interruption-recorded")).toBe(true);
    // The session is still live (an interruption is not terminal).
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("live");
  });

  test("a caller hangup closes the session terminally with completion provenance", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-hangup");
    const outcome = await world.service.ingestInboundEvent(
      {
        sessionId: started.sessionId,
        channelSessionRef: started.channelSessionRef,
        channelEpoch: started.channelEpoch,
        kind: "caller-hangup",
      },
      ACTOR,
    );
    expect(outcome.kind).toBe("caller-hangup");
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("closed");
    expect(session?.session.closedAt).not.toBeNull();
    expect(
      world.ledger.evidence.some(
        (entry) =>
          String((entry.input as Record<string, unknown>).evidenceClass) === "session-completed",
      ),
    ).toBe(true);
    // The rail saw the channel close.
    expect(world.rail.deliveries.filter((record) => record.kind === "close")).toHaveLength(1);
    // Terminal sessions reject further inbound events.
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-after-close",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("S8: a governed transfer moves the execution to wait-human, transfers on the rail, and is terminal", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-transfer");
    const outcome = await world.service.transferToHuman(
      { sessionId: started.sessionId, destination: "support-tier-2", cause: "caller request" },
      "transfer-1",
      ACTOR,
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.executionId).toBe(started.executionId);
    // Policy was consulted for the human-transfer action (the
    // policy-designated escalation) and the execution moved to the
    // auditable human wait; the rail transferred exactly once.
    const transferCall = world.policy.calls.find(
      (call) => (call as Record<string, unknown>).action === "human-transfer",
    );
    expect(transferCall).toBeDefined();
    expect(world.ledger.humanWaits).toHaveLength(1);
    expect(world.rail.deliveries.filter((record) => record.kind === "transfer")).toHaveLength(1);
    // Transfer provenance on the ledger + journal; terminal status.
    expect(
      world.ledger.evidence.some(
        (entry) => String((entry.input as Record<string, unknown>).evidenceClass) === "transfer",
      ),
    ).toBe(true);
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("transferred");
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.some((event) => event.kind === "transfer-recorded")).toBe(true);
  });

  test("a transfer replay under the SAME key converges on the committed outcome", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-transfer2");
    const first = await world.service.transferToHuman(
      { sessionId: started.sessionId },
      "transfer-1",
      ACTOR,
    );
    const second = await world.service.transferToHuman(
      { sessionId: started.sessionId },
      "transfer-1",
      ACTOR,
    );
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    expect(world.rail.deliveries.filter((record) => record.kind === "transfer")).toHaveLength(1);
    expect(world.ledger.humanWaits).toHaveLength(1);
  });

  test("S2: a policy-denied transfer performs NO rail transfer and NO execution wait", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-transfer-denied");
    world.policy.deny = true;
    await expect(
      world.service.transferToHuman({ sessionId: started.sessionId }, "transfer-x", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "transfer")).toHaveLength(0);
    expect(world.ledger.humanWaits).toHaveLength(0);
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("live");
  });

  test("a rail-refused transfer records failure provenance and stays non-terminal", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-transfer-fail");
    world.rail.failNextDelivery("fixture transfer outage");
    await expect(
      world.service.transferToHuman({ sessionId: started.sessionId }, "transfer-f", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(
      world.ledger.evidence.some(
        (entry) =>
          String((entry.input as Record<string, unknown>).evidenceClass) === "failure" &&
          String((entry.input as Record<string, unknown>).cause).includes("human transfer failed"),
      ),
    ).toBe(true);
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("live");
  });

  test("a terminal transferred session under a different key refuses a second transfer", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-transfer3");
    await world.service.transferToHuman({ sessionId: started.sessionId }, "transfer-a", ACTOR);
    await expect(
      world.service.transferToHuman({ sessionId: started.sessionId }, "transfer-b", ACTOR),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
});

describe("realtime session service: reconnect and close (AC7)", () => {
  test("S7: reattach binds a new channel coordinate WITHOUT a second execution", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-reattach");
    const reattached = await world.service.reattachSession(
      { sessionId: started.sessionId, newChannelSessionRef: "simrail-session-1-reconnected" },
      "reattach-1",
      ACTOR,
    );
    expect(reattached.sessionId).toBe(started.sessionId);
    expect(reattached.executionId).toBe(started.executionId);
    expect(reattached.channelEpoch).toBe(started.channelEpoch + 1);
    expect(reattached.channelSessionRef).toBe("simrail-session-1-reconnected");
    // No new execution identity was established.
    expect(world.ledger.opened).toHaveLength(1);
    // Reconnect provenance is a significant action on the SAME execution.
    const reattachEvidence = world.ledger.evidence.find(
      (entry) => entry.key === "realtime:reattach:reattach-1",
    );
    expect(reattachEvidence).toBeDefined();
    expect((reattachEvidence?.input as Record<string, unknown>).executionId).toBe(
      started.executionId,
    );
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.some((event) => event.kind === "session-reattached")).toBe(true);
    // The session continues to work on the NEW coordinates.
    const after = await world.service.ingestInboundEvent(
      turn(started.sessionId, "simrail-session-1-reconnected", started.channelEpoch + 1, {
        eventKey: "evt-after-reattach",
      }),
      ACTOR,
    );
    expect(after.replayed).toBe(false);
  });

  test("S9: a stale callback on superseded coordinates cannot mutate the session", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-stale");
    await world.service.reattachSession(
      { sessionId: started.sessionId, newChannelSessionRef: "simrail-session-1-new" },
      "reattach-1",
      ACTOR,
    );
    // The OLD coordinate (pre-reattach epoch) is permanently superseded.
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
          eventKey: "evt-stale",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // And an event on the right ref but the WRONG epoch is also stale.
    await expect(
      world.service.ingestInboundEvent(
        turn(started.sessionId, "simrail-session-1-new", started.channelEpoch, {
          eventKey: "evt-stale-2",
        }),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    // Nothing was dispatched and nothing was journaled for the stale keys.
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.filter((event) => event.eventKey.startsWith("evt-stale"))).toHaveLength(0);
  });

  test("an epoch regression via a guarded mutation is refused (monotonic epoch)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-epoch");
    await world.service.reattachSession(
      { sessionId: started.sessionId, newChannelSessionRef: "simrail-session-1-e2" },
      "reattach-1",
      ACTOR,
    );
    // A direct store-level attempt to regress the epoch fails closed.
    await expect(
      world.store.applyGuardedSessionMutation({
        applicationId: ACTOR.applicationId,
        sessionId: started.sessionId,
        expectedStatus: "live",
        toStatus: "live",
        expectedChannelRef: "simrail-session-1-e2",
        expectedChannelEpoch: 2,
        toChannelRef: "simrail-session-1-e2",
        toChannelEpoch: 1,
        closedAt: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("closeSession is idempotent and terminal", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-close");
    const first = await world.service.closeSession(
      { sessionId: started.sessionId, cause: "done" },
      "close-1",
      ACTOR,
    );
    const second = await world.service.closeSession(
      { sessionId: started.sessionId },
      "close-2",
      ACTOR,
    );
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(
      world.ledger.evidence.filter(
        (entry) =>
          String((entry.input as Record<string, unknown>).evidenceClass) === "session-completed",
      ),
    ).toHaveLength(1);
  });

  test("failSession records failure provenance and is terminal", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-fail");
    await world.service.failSession(
      { sessionId: started.sessionId, cause: "rail session irrecoverable" },
      "fail-1",
      ACTOR,
    );
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("failed");
    expect(
      world.ledger.evidence.some(
        (entry) => String((entry.input as Record<string, unknown>).evidenceClass) === "failure",
      ),
    ).toBe(true);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.some((event) => event.kind === "session-failed")).toBe(true);
  });
});

describe("realtime session service: version pinning and rollback (AC7)", () => {
  test("S10: promotion moves the pointer for NEW sessions only — the live session keeps its pin", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-pin");
    expect(started.pinnedPlanVersion).toBe(1);
    // Promote the deployment to plan v2.
    await world.deploymentService.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "promote-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    // A NEW session pins v2.
    const fresh = await startSession(world, "start-pin-2", ACTOR, {
      channelSessionRef: "simrail-session-2",
    });
    expect(fresh.pinnedPlanVersion).toBe(2);
    // The LIVE session keeps v1 (and keeps working on it).
    const live = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(live?.session.pinnedPlanVersion).toBe(1);
    const turnOutcome = await world.service.ingestInboundEvent(
      turn(started.sessionId, started.channelSessionRef, started.channelEpoch, {
        eventKey: "evt-on-v1",
      }),
      ACTOR,
    );
    expect(turnOutcome.replayed).toBe(false);
    // The turn's provenance records the ORIGINAL pin.
    const turnEntry = world.ledger.evidence.find(
      (entry) => entry.key === "realtime:turn:evt-on-v1",
    );
    expect(
      (turnEntry?.input as Record<string, unknown> | undefined)?.reference &&
        ((turnEntry?.input as Record<string, unknown>).reference as Record<string, unknown>)
          .pinnedPlanVersion,
    ).toBe(1);
  });

  test("S11: rollback moves the deployment back but NEVER rewrites prior execution identity", async () => {
    const world = await seededWorld();
    const v1Session = await startSession(world, "start-rollback-1");
    await world.deploymentService.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "promote-rb",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const v2Session = await startSession(world, "start-rollback-2", ACTOR, {
      channelSessionRef: "simrail-session-rb2",
    });
    // Roll the deployment back to v1.
    await world.deploymentService.rollbackDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "rollback-1",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    // The v2 session keeps its pin and its ORIGINAL execution identity.
    const stillV2 = await world.service.getSession(ACTOR.applicationId, v2Session.sessionId);
    expect(stillV2?.session.pinnedPlanVersion).toBe(2);
    expect(stillV2?.session.executionId).toBe(v2Session.executionId);
    const stillV1 = await world.service.getSession(ACTOR.applicationId, v1Session.sessionId);
    expect(stillV1?.session.pinnedPlanVersion).toBe(1);
    expect(stillV1?.session.executionId).toBe(v1Session.executionId);
    // A NEW session after the rollback pins v1 again.
    const afterRollback = await startSession(world, "start-rollback-3", ACTOR, {
      channelSessionRef: "simrail-session-rb3",
    });
    expect(afterRollback.pinnedPlanVersion).toBe(1);
    // No execution identity was ever rewritten: exactly 3 executions.
    expect(world.ledger.opened).toHaveLength(3);
    expect(new Set(world.ledger.opened.map((entry) => entry.key)).size).toBe(3);
  });

  test("S7 (runtime): a reattached session never re-opens an execution across a full lifecycle", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-lifecycle");
    const reattached = await world.service.reattachSession(
      { sessionId: started.sessionId, newChannelSessionRef: "simrail-session-lc2" },
      "reattach-lc",
      ACTOR,
    );
    await world.service.ingestInboundEvent(
      turn(reattached.sessionId, reattached.channelSessionRef, reattached.channelEpoch, {
        eventKey: "evt-lc",
      }),
      ACTOR,
    );
    await world.service.closeSession({ sessionId: reattached.sessionId }, "close-lc", ACTOR);
    expect(world.ledger.opened).toHaveLength(1);
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.executionId).toBe(started.executionId);
  });
});

describe("the in-memory store's own arbitration (the SQL store's twin)", () => {
  test("a second session on the same channel coordinate is refused", async () => {
    const world = await seededWorld();
    await startSession(world, "start-coord");
    await expect(
      startSession(world, "start-coord-2", ACTOR, { channelSessionRef: "simrail-session-1" }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  test("a stale inbound journal append is refused at the store level too", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-jstale");
    await expect(
      world.store.appendChannelEvent({
        eventId: "00000000-0000-7000-8000-00000000js01",
        applicationId: ACTOR.applicationId,
        tenantId: ACTOR.tenantId,
        sessionId: started.sessionId,
        deploymentId: world.deploymentId,
        kind: "turn-recorded",
        direction: "inbound",
        eventKey: "evt-js",
        channelSessionRef: "other-ref",
        channelEpoch: started.channelEpoch,
        executionId: started.executionId,
        ledgerSequence: null,
        routeClass: null,
        cause: null,
        payloadRef: null,
        payloadPreview: null,
        actorId: ACTOR.actorId,
        bodyDigest: digest("x"),
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("an event with a foreign execution id is refused (identity binding)", async () => {
    const world = await seededWorld();
    const started = await startSession(world, "start-execbind");
    await expect(
      world.store.appendChannelEvent({
        eventId: "00000000-0000-7000-8000-00000000js02",
        applicationId: ACTOR.applicationId,
        tenantId: ACTOR.tenantId,
        sessionId: started.sessionId,
        deploymentId: world.deploymentId,
        kind: "turn-recorded",
        direction: "outbound",
        eventKey: "evt-xbind",
        channelSessionRef: started.channelSessionRef,
        channelEpoch: started.channelEpoch,
        executionId: "00000000-0000-7000-8000-00000000ffff",
        ledgerSequence: null,
        routeClass: null,
        cause: null,
        payloadRef: null,
        payloadPreview: null,
        actorId: ACTOR.actorId,
        bodyDigest: digest("x"),
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
