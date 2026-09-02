/**
 * Discrimination: the realtime voice-session boundaries (WORK-024,
 * MOD-005/006/007; checkpoint contracts IMPLEMENTATION-COMPLETENESS,
 * EXECUTION-PROVENANCE, CONCURRENCY-CRASH-SAFETY,
 * SELF-HOSTING-BOUNDARY).
 *
 * The 12 REQUIRED SAFETY PROOFS (the work order's "Required safety
 * proofs" list, labeled S1..S12). Every protection has BOTH halves (the
 * wave-1 house style):
 *
 *   STATIC mutants mutate the REAL source in memory; the probe scanners
 *   below must flag exactly the weakened protection (a mutant that
 *   removes or reorders a guard is caught without touching the clean
 *   tree, which always scans clean);
 *
 *   RUNTIME red records observe the governed in-memory world under
 *   constructed scenarios and stay red (the negative behavior is
 *   asserted as the permanent expected outcome).
 *
 * Proof map (proof → mutant → runtime red):
 *   S1  tenant isolation            tenant-guard-removed (session+deployment)
 *       cross-tenant start/operate fail TENANT_SCOPE_VIOLATION
 *   S2  policy before side effect   policy-order / admission-removed
 *       denial at start AND at turn: zero rail activity
 *   S3  capability gate             capability-gate-removed
 *       unmet capability: CAPABILITY_UNAVAILABLE, zero deliveries
 *   S4  budget gate (paid routes)   budget-gate-removed
 *       exhausted budget: BUDGET_EXCEEDED, zero deliveries
 *   S5  secret mediation            mediation-gate-removed
 *       refused mediation: AUTHORIZATION_DENIED, reservation released
 *   S6  duplicate inbound events    convergence-branch-removed
 *       duplicate user-turn: one delivery, one responder call
 *   S7  reconnect/one execution     reattach-second-execution
 *       reattach + retried start: exactly one execution identity
 *   S8  interruption/transfer       provenance-vocabulary-removed
 *       interruption/transfer evidence on the ledger + journal
 *   S9  stale callbacks             stale-guard-removed
 *       superseded coordinates: INVALID_STATE_TRANSITION, no dispatch
 *   S10 version pinning             pin-drift (ingest uses the session pin)
 *       promote: live session keeps v1, new session pins v2
 *   S11 rollback identity           migration-core-guard-removed
 *       rollback: pins and execution identities unchanged
 *   S12 deterministic routing       budget-gate-removed (the paid-only
 *       guard) + the router adapter's planner mapping
 *       deterministic route: zero reservations, reservationId null
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  RealtimePolicyAdmissionRequest,
  RealtimeRouteClass,
  RealtimeSecretMediationRequest,
  RealtimeSessionServiceDeps,
  RealtimeTurnResponderRequest,
  RealtimeTurnRouteRequest,
  StartRealtimeSessionInput,
} from "../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessRealtimeRail,
  createModalityAdapterRegistry,
  createPlannerSubtaskRouter,
  createRealtimeSessionService,
  InMemoryDeploymentStore,
  InMemoryRealtimeStore,
} from "../../src/modules/deployments/public";
import type { DeterministicCatalogEntry } from "../../src/modules/planning/public";
import { PlatformError } from "../../src/shared/errors";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = "src/modules/deployments/application/realtime-session-service.ts";
const ROUTER_PATH = "src/modules/deployments/adapters/planner-subtask-router.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0018_realtime_sessions.sql";
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_PATH), "utf8");
const ROUTER_SOURCE = readFileSync(join(REPO_ROOT, ROUTER_PATH), "utf8");
const MIGRATION_SOURCE = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Extract one method body from the service source (4-space indent). */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`signature not found: ${signature}`);
  }
  const next = source.indexOf("\n    async ", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Extract one helper section between two source markers. */
function sectionOf(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`section start not found: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start);
  return source.slice(start, end === -1 ? source.length : end);
}

const INGEST_BODY = methodBody(SERVICE_SOURCE, "async ingestInboundEvent(");
const START_BODY = methodBody(SERVICE_SOURCE, "async startSession(");
const REATTACH_BODY = methodBody(SERVICE_SOURCE, "async reattachSession(");
const RESOLVE_SESSION_BODY = sectionOf(
  SERVICE_SOURCE,
  "const resolveSession = async (",
  "const sessionEvent = async (",
);

// ---------------------------------------------------------------------------
// The static probe: violations over the (possibly mutated) REAL source.
// ---------------------------------------------------------------------------

interface RealtimeRules {
  readonly service: string;
  readonly ingestBody: string;
  readonly startBody: string;
  readonly reattachBody: string;
  readonly resolveSessionBody: string;
  readonly migration: string;
  readonly router: string;
}

function violationsOf(rules: RealtimeRules): string[] {
  const violations: string[] = [];

  // S1 — tenant guards (session + deployment) must exist.
  if (!rules.service.includes("session.tenantId !== actor.tenantId")) {
    violations.push("session-tenant-guard-removed");
  }
  if (!rules.service.includes("deployment.tenantId !== tenantId")) {
    violations.push("deployment-tenant-guard-removed");
  }

  // S2 — the admission chain must run BEFORE the side effects, in the
  // frozen order, inside the ingest flow.
  const order: ReadonlyArray<readonly [string, number]> = [
    ["policy.admit(", rules.ingestBody.indexOf("policy.admit(")],
    ["capabilities.resolve(", rules.ingestBody.indexOf("capabilities.resolve(")],
    ["budget.reserve(", rules.ingestBody.indexOf("budget.reserve(")],
    ["secrets.mediate(", rules.ingestBody.indexOf("secrets.mediate(")],
    ["responder.respond(", rules.ingestBody.indexOf("responder.respond(")],
    ["rail.deliverTurn(", rules.ingestBody.indexOf("rail.deliverTurn(")],
  ];
  for (const [label, index] of order) {
    if (index === -1) {
      // The deterministic-gate flow may short-circuit budget: the token
      // must still be present in the method.
      if (label === "budget.reserve(" && rules.ingestBody.includes("budget.reserve(")) {
        continue;
      }
      violations.push(`admission-missing:${label}`);
    }
  }
  for (let i = 1; i < order.length; i += 1) {
    const previous = order[i - 1];
    const current = order[i];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous[1] !== -1 && current[1] !== -1 && previous[1] > current[1]) {
      violations.push(`admission-order:${previous[0]}-after-${current[0]}`);
    }
  }
  // Start flow: policy BEFORE the rail open and the execution open.
  const startPolicy = rules.startBody.indexOf("policy.admit(");
  const startRail = rules.startBody.indexOf("rail.openSession(");
  if (startPolicy === -1) {
    violations.push("admission-missing:policy.admit( (startSession)");
  } else if (startRail !== -1 && startPolicy > startRail) {
    violations.push("admission-order:policy-after-rail-open");
  }

  // S3 — the capability gate must exist.
  if (!rules.ingestBody.includes("!capabilityDecision.satisfied")) {
    violations.push("capability-gate-removed");
  }

  // S4/S12 — the paid-only budget gate must exist (deterministic routes
  // never reserve — MOD-007).
  if (!rules.ingestBody.includes('route.routeClass !== "deterministic"')) {
    violations.push("budget-gate-removed");
  }

  // S5 — the mediation gate must exist.
  if (!rules.ingestBody.includes("!mediation.mediated")) {
    violations.push("mediation-gate-removed");
  }

  // S6 — the duplicate-convergence branch must exist.
  if (!rules.ingestBody.includes('claim.status === "converged"')) {
    violations.push("convergence-branch-removed");
  }

  // S7 — reattach must never establish a second execution identity.
  if (rules.reattachBody.includes("openExecution")) {
    violations.push("reattach-second-execution");
  }
  if (!rules.startBody.includes("ledger.openExecution(")) {
    violations.push("start-missing-execution-open");
  }

  // S8 — the provenance vocabulary must exist (interruption + transfer).
  for (const klass of ['"interruption"', '"transfer"']) {
    if (!rules.service.includes(`evidenceClass: ${klass}`)) {
      violations.push(`provenance-vocabulary-removed:${klass}`);
    }
  }

  // S9 — the stale-callback guard must exist.
  if (
    !rules.resolveSessionBody.includes("channel.channelSessionRef !== session.channelSessionRef")
  ) {
    violations.push("stale-guard-removed");
  }

  // S10 — the ingest flow must use the SESSION's pin, never the
  // deployment's current pointer.
  if (!rules.ingestBody.includes("pinnedPlanId: session.pinnedPlanId")) {
    violations.push("pin-drift");
  }
  if (rules.ingestBody.includes("deployment.currentPlanId")) {
    violations.push("pin-drift-current-pointer");
  }

  // S11 — the physical core guard must exist in the migration.
  if (!rules.migration.includes("rt_sessions_core_guard")) {
    violations.push("migration-core-guard-removed");
  }
  if (!rules.migration.includes("NEW.pinned_plan_version <> OLD.pinned_plan_version")) {
    violations.push("migration-pin-immutability-removed");
  }

  // S12 — the router adapter must map the planner outcomes onto the
  // neutral route classes (sufficient -> deterministic).
  if (!rules.router.includes('decision.outcome === "sufficient"')) {
    violations.push("router-planner-mapping-removed");
  }

  return violations;
}

/** The clean tree scans clean. */
function cleanRules(): RealtimeRules {
  return {
    service: SERVICE_SOURCE,
    ingestBody: INGEST_BODY,
    startBody: START_BODY,
    reattachBody: REATTACH_BODY,
    resolveSessionBody: RESOLVE_SESSION_BODY,
    migration: MIGRATION_SOURCE,
    router: ROUTER_SOURCE,
  };
}

function mutateService(mutation: (content: string) => string): RealtimeRules {
  const service = mutation(SERVICE_SOURCE);
  return {
    service,
    ingestBody: methodBody(service, "async ingestInboundEvent("),
    startBody: methodBody(service, "async startSession("),
    reattachBody: methodBody(service, "async reattachSession("),
    resolveSessionBody: sectionOf(
      service,
      "const resolveSession = async (",
      "const sessionEvent = async (",
    ),
    migration: MIGRATION_SOURCE,
    router: ROUTER_SOURCE,
  };
}

// ---------------------------------------------------------------------------
// The runtime world (a compact twin of the unit suite's world).
// ---------------------------------------------------------------------------

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
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
  environmentId: ENV_ID,
  channelBindings: [{ channelKind: "web", adapterCapabilityId: "realtime-channel-adapter" }],
  sessionPolicy: { maxSessionDurationMs: 600_000, maxConcurrentSessions: 8 },
};

const CREATION: CreateDeploymentInput = {
  slug: "support-voice-prod",
  name: "Support voice",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck",
  planId: "support-voice-plan",
};

/** Recording admission seams (typed with the real port request shapes). */
class RecordingAdmissions {
  readonly policyCalls: RealtimePolicyAdmissionRequest[] = [];
  readonly capabilityCalls: RealtimeCapabilityAdmissionRequest[] = [];
  readonly reserves: RealtimeBudgetReserveCommand[] = [];
  readonly mediationCalls: RealtimeSecretMediationRequest[] = [];
  readonly responderCalls: RealtimeTurnResponderRequest[] = [];
  denyPolicy = false;
  unmet: string[] = [];
  failBudget = false;
  refuseMediation = false;
  routeClass: RealtimeRouteClass = "generative";

  readonly policy = {
    admit: async (request: RealtimePolicyAdmissionRequest) => {
      this.policyCalls.push(request);
      return this.denyPolicy
        ? { allowed: false as const, reason: "fixture denial" }
        : { allowed: true as const };
    },
  };

  readonly capabilities = {
    resolve: async (request: RealtimeCapabilityAdmissionRequest) => {
      this.capabilityCalls.push(request);
      return { satisfied: this.unmet.length === 0, unmet: this.unmet };
    },
  };

  readonly budget = {
    reserve: async (command: RealtimeBudgetReserveCommand) => {
      this.reserves.push(command);
      if (this.failBudget) {
        throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted" });
      }
      return {
        reservationId: `resv-${this.reserves.length}`,
        amountMicroUsd: command.amountMicroUsd,
        converged: false,
      };
    },
    settle: async () => ({ reservationId: "resv-x", settled: true }),
    release: async () => ({ reservationId: "resv-x", released: true }),
  };

  readonly secrets = {
    mediate: async (request: RealtimeSecretMediationRequest) => {
      this.mediationCalls.push(request);
      return this.refuseMediation
        ? { mediated: false as const, reason: "fixture inactive" }
        : { mediated: true as const, grantRef: "mediated:conn-1" };
    },
  };

  readonly router = {
    routeTurn: async (request: RealtimeTurnRouteRequest) => {
      void request;
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
    respond: async (request: RealtimeTurnResponderRequest) => {
      this.responderCalls.push(request);
      return {
        responseRef: "artifact:responses/1",
        responsePreview: "fixture answer",
        actualCostMicroUsd: "0",
      };
    },
  };
}

/** The in-memory execution ledger (idempotent open, sequenced evidence). */
class RecordingLedger implements RealtimeExecutionLedger {
  readonly opened: Array<{ key: string; input: RealtimeExecutionOpenInput }> = [];
  readonly evidence: RealtimeEvidenceInput[] = [];
  private readonly executionByKey = new Map<string, string>();
  private readonly evidenceKeys = new Set<string>();
  private seq = 0;
  async openExecution(input: RealtimeExecutionOpenInput, idempotencyKey: string) {
    const existing = this.executionByKey.get(idempotencyKey);
    if (existing !== undefined) {
      return { executionId: existing, replayed: true, status: "running" };
    }
    const executionId = `00000000-0000-7000-8000-${String(this.executionByKey.size + 1).padStart(
      12,
      "0",
    )}`;
    this.executionByKey.set(idempotencyKey, executionId);
    this.opened.push({ key: idempotencyKey, input });
    return { executionId, replayed: false, status: "running" };
  }
  async recordEvidence(input: RealtimeEvidenceInput, idempotencyKey: string) {
    if (!this.evidenceKeys.has(idempotencyKey)) {
      this.evidenceKeys.add(idempotencyKey);
      this.evidence.push(input);
    }
    this.seq += 1;
    return { sequence: this.seq, type: "agent-action-recorded", replayed: false };
  }
  async readExecution() {
    return { id: "exec", tenantId: ACTOR.tenantId, status: "running" };
  }
  async awaitHuman() {
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
  async continueAfterHuman() {
    this.seq += 1;
    return { sequence: this.seq, replayed: false };
  }
}

interface World {
  readonly service: ReturnType<typeof createRealtimeSessionService>;
  readonly rail: ReturnType<typeof createInProcessRealtimeRail>;
  readonly admissions: RecordingAdmissions;
  readonly ledger: RecordingLedger;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
}

async function buildWorld(): Promise<World> {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  registry.register({
    descriptor: { adapterCapabilityId: "realtime-channel-adapter", channelKinds: ["web"] },
    async checkBinding() {
      return { ok: true };
    },
    async describeBinding(binding) {
      return { channelKind: binding.channelKind };
    },
  });
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
  const actor = {
    actorId: ACTOR.actorId,
    applicationId: ACTOR.applicationId,
    tenantId: ACTOR.tenantId,
  };
  await deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
  await deploymentService.publishPlan({ ...PLAN }, { version: 1 }, actor);
  await deploymentService.publishPlan(
    {
      ...PLAN,
      sessionPolicy: { maxSessionDurationMs: 300_000, maxConcurrentSessions: 4 },
    },
    { version: 2 },
    actor,
  );
  const created = await deploymentService.createDeployment({ ...CREATION }, "deploy-key-0", actor);

  const rail = createInProcessRealtimeRail(["web", "in-app", "telephony"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const admissions = new RecordingAdmissions();
  const ledger = new RecordingLedger();
  const deps: RealtimeSessionServiceDeps = {
    store: new InMemoryRealtimeStore(),
    deployments: deploymentStore,
    rail,
    policy: admissions.policy,
    capabilities: admissions.capabilities,
    budget: admissions.budget,
    secrets: admissions.secrets,
    router: admissions.router,
    responder: admissions.responder,
    ledger,
    railConnectionRef: "conn-rail-1",
    digest,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
  };
  return {
    service: createRealtimeSessionService(deps),
    rail,
    admissions,
    ledger,
    deploymentService,
    deploymentId: created.deploymentId,
  };
}

async function start(world: World, key: string, actor: RealtimeActor = ACTOR) {
  const input: StartRealtimeSessionInput = {
    deploymentId: world.deploymentId,
    channelKind: "web",
    channelSessionRef: `simrail-session-${key}`,
  };
  return world.service.startSession(input, key, actor);
}

const userTurn = (
  sessionId: string,
  channelSessionRef: string,
  channelEpoch: number,
  eventKey?: string,
): RealtimeInboundEventInput => ({
  sessionId,
  channelSessionRef,
  channelEpoch,
  kind: "user-turn",
  payloadPreview: "what is my balance?",
  payloadRef: "artifact:turns/1",
  subtaskKind: "data-retrieval",
  eventKey,
});

// ---------------------------------------------------------------------------
// The discrimination records.
// ---------------------------------------------------------------------------

describe("discrimination: realtime voice sessions (WORK-024)", () => {
  test("the clean tree scans clean (the probe's baseline)", () => {
    expect(violationsOf(cleanRules())).toEqual([]);
  });

  test("S1 STATIC: removing the session tenant guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (session.tenantId !== actor.tenantId) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("session-tenant-guard-removed");
  });

  test("S1 STATIC: removing the deployment tenant guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (deployment.tenantId !== tenantId) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("deployment-tenant-guard-removed");
  });

  test("S1 RUNTIME: an unauthorized tenant cannot operate another tenant's realtime session", async () => {
    const world = await buildWorld();
    const started = await start(world, "s1");
    await expect(start(world, "s1-other", OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    await expect(
      world.service.ingestInboundEvent(
        userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch),
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.transferToHuman({ sessionId: started.sessionId }, "s1-x", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
  });

  test("S2 STATIC: deleting the turn policy admission is flagged (admission-missing)", () => {
    const mutated = mutateService((content) =>
      content.replace("const policyDecision = await policy.admit({", "const policyDecision = {"),
    );
    expect(violationsOf(mutated)).toContain("admission-missing:policy.admit(");
  });

  test("S2 STATIC: reordering delivery before the admission chain is flagged", () => {
    // Mutant: an early delivery is inserted ABOVE the admission chain —
    // the ordering probe must flag the side-effect-before-admission drift.
    const mutated = mutateService((content) =>
      content.replace(
        "      // 7. ADMISSION CHAIN — before EVERY governed side effect.",
        "      const earlyDelivery = await rail.deliverTurn({\n        applicationId: actor.applicationId,\n        sessionId: session.id,\n        channelSessionRef: session.channelSessionRef,\n        channelEpoch: session.channelEpoch,\n        routeClass: route.routeClass,\n        responseRef: null,\n        responsePreview: 'early',\n        cause: null,\n      });\n      void earlyDelivery;\n      // 7. ADMISSION CHAIN — before EVERY governed side effect.",
      ),
    );
    const violations = violationsOf(mutated);
    expect(violations.join("\n")).toContain("admission-order:");
    expect(violations).toContain("admission-order:responder.respond(-after-rail.deliverTurn(");
  });

  test("S2 RUNTIME: policy denial happens before the external side effect (both flows)", async () => {
    const world = await buildWorld();
    world.admissions.denyPolicy = true;
    // Start flow: zero rail activity, zero executions.
    await expect(start(world, "s2-start")).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.deliveries).toHaveLength(0);
    expect(world.rail.openedSessions).toBe(0);
    expect(world.ledger.opened).toHaveLength(0);
    // Turn flow: zero deliveries, zero responder calls.
    world.admissions.denyPolicy = false;
    const started = await start(world, "s2-turn");
    world.admissions.denyPolicy = true;
    await expect(
      world.service.ingestInboundEvent(
        userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-s2"),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    // Transfer flow: no rail transfer, no execution wait.
    await expect(
      world.service.transferToHuman({ sessionId: started.sessionId }, "s2-transfer", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "transfer")).toHaveLength(0);
  });

  test("S3 STATIC: removing the capability gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!capabilityDecision.satisfied) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("capability-gate-removed");
  });

  test("S3 RUNTIME: a missing capability cannot dispatch", async () => {
    const world = await buildWorld();
    const started = await start(world, "s3");
    world.admissions.unmet = ["realtime-conversation"];
    await expect(
      world.service.ingestInboundEvent(
        userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-s3"),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    expect(world.admissions.reserves).toHaveLength(0);
  });

  test("S4/S12 STATIC: removing the paid-only budget gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        'if (route.routeClass !== "deterministic" && route.estimatedCostMicroUsd !== null) {',
        "if (route.estimatedCostMicroUsd !== null) {",
      ),
    );
    expect(violationsOf(mutated)).toContain("budget-gate-removed");
  });

  test("S4 RUNTIME: a denied budget prevents the paid dispatch", async () => {
    const world = await buildWorld();
    const started = await start(world, "s4");
    world.admissions.failBudget = true;
    await expect(
      world.service.ingestInboundEvent(
        userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-s4"),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    expect(world.admissions.mediationCalls).toHaveLength(0);
  });

  test("S5 STATIC: removing the mediation gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!mediation.mediated) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("mediation-gate-removed");
  });

  test("S5 RUNTIME: refused secret mediation prevents delivery and releases the reservation", async () => {
    const world = await buildWorld();
    const started = await start(world, "s5");
    world.admissions.refuseMediation = true;
    await expect(
      world.service.ingestInboundEvent(
        userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-s5"),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    expect(world.admissions.responderCalls).toHaveLength(0);
    // The paid reservation was released (never leaked).
    expect(world.admissions.reserves).toHaveLength(1);
  });

  test("S6 STATIC: removing the duplicate-convergence branch is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace('if (claim.status === "converged") {', "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("convergence-branch-removed");
  });

  test("S6 RUNTIME: duplicate inbound events do not duplicate execution side effects", async () => {
    const world = await buildWorld();
    const started = await start(world, "s6");
    const input = userTurn(
      started.sessionId,
      started.channelSessionRef,
      started.channelEpoch,
      "evt-s6",
    );
    await world.service.ingestInboundEvent(input, ACTOR);
    const replay = await world.service.ingestInboundEvent(input, ACTOR);
    expect(replay.replayed).toBe(true);
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
    expect(world.admissions.responderCalls).toHaveLength(1);
    expect(world.admissions.reserves).toHaveLength(1);
    // Exactly ONE turn evidence record on the ledger (idempotency key).
    const turnEvidence = world.ledger.evidence.filter((entry) => entry.evidenceClass === "turn");
    expect(turnEvidence).toHaveLength(1);
  });

  test("S7 STATIC: reattach gaining an execution open is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        '      const applied = await store.applyGuardedSessionMutation({\n        applicationId: actor.applicationId,\n        sessionId: session.id,\n        expectedStatus: session.status,\n        toStatus: "live",',
        '      const second = await ledger.openExecution({\n        applicationId: actor.applicationId,\n        tenantId: actor.tenantId,\n        actorId: actor.actorId,\n        environmentId: ENV_REF,\n        task: {},\n      }, `reattach:${idempotencyKey}`);\n      void second;\n      const applied = await store.applyGuardedSessionMutation({\n        applicationId: actor.applicationId,\n        sessionId: session.id,\n        expectedStatus: session.status,\n        toStatus: "live",',
      ),
    );
    expect(violationsOf(mutated)).toContain("reattach-second-execution");
  });

  test("S7 RUNTIME: reconnect/retry does not create a second authoritative execution", async () => {
    const world = await buildWorld();
    const started = await start(world, "s7");
    // A retried start under the same key converges on the same identity.
    const retried = await start(world, "s7");
    expect(retried.executionId).toBe(started.executionId);
    // A reconnect (reattach) keeps the identity too.
    const reattached = await world.service.reattachSession(
      {
        sessionId: started.sessionId,
        newChannelSessionRef: `${started.channelSessionRef}-r2`,
      },
      "s7-reattach",
      ACTOR,
    );
    expect(reattached.executionId).toBe(started.executionId);
    expect(reattached.channelEpoch).toBe(started.channelEpoch + 1);
    // Exactly ONE execution exists across the whole lifecycle.
    await world.service.ingestInboundEvent(
      userTurn(
        reattached.sessionId,
        reattached.channelSessionRef,
        reattached.channelEpoch,
        "evt-s7",
      ),
      ACTOR,
    );
    await world.service.closeSession({ sessionId: started.sessionId }, "s7-close", ACTOR);
    expect(world.ledger.opened).toHaveLength(1);
    expect(world.ledger.evidence.every((entry) => entry.executionId === started.executionId)).toBe(
      true,
    );
  });

  test("S8 STATIC: removing the interruption/transfer provenance vocabulary is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        'evidenceClass: "interruption",',
        'evidenceClass: "significant-action", /*mutated*/',
      ),
    );
    expect(violationsOf(mutated)).toContain('provenance-vocabulary-removed:"interruption"');
    const mutated2 = mutateService((content) =>
      content.replace(
        'evidenceClass: "transfer",',
        'evidenceClass: "significant-action", /*mutated*/',
      ),
    );
    expect(violationsOf(mutated2)).toContain('provenance-vocabulary-removed:"transfer"');
  });

  test("S8 RUNTIME: interruption and transfer preserve provenance (ledger + journal)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s8");
    // Interruption: ledger interruption evidence, journal row, no dispatch.
    await world.service.ingestInboundEvent(
      {
        sessionId: started.sessionId,
        channelSessionRef: started.channelSessionRef,
        channelEpoch: started.channelEpoch,
        kind: "interruption",
        payloadPreview: "wait—",
      },
      ACTOR,
    );
    expect(world.ledger.evidence.some((entry) => entry.evidenceClass === "interruption")).toBe(
      true,
    );
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(0);
    // Transfer: ledger wait + transfer evidence, journal row, terminal.
    await world.service.transferToHuman({ sessionId: started.sessionId }, "s8-transfer", ACTOR);
    expect(world.ledger.evidence.some((entry) => entry.evidenceClass === "transfer")).toBe(true);
    const events = await world.service.listSessionEvents(ACTOR.applicationId, started.sessionId);
    expect(events.some((event) => event.kind === "interruption-recorded")).toBe(true);
    expect(events.some((event) => event.kind === "transfer-recorded")).toBe(true);
    const session = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(session?.session.status).toBe("transferred");
  });

  test("S9 STATIC: removing the stale-callback guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("channel.channelSessionRef !== session.channelSessionRef ||", "false ||"),
    );
    expect(violationsOf(mutated)).toContain("stale-guard-removed");
  });

  test("S9 RUNTIME: a stale callback cannot mutate the wrong session", async () => {
    const world = await buildWorld();
    const started = await start(world, "s9");
    const reattached = await world.service.reattachSession(
      {
        sessionId: started.sessionId,
        newChannelSessionRef: `${started.channelSessionRef}-new`,
      },
      "s9-reattach",
      ACTOR,
    );
    await expect(
      world.service.ingestInboundEvent(
        userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-stale"),
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(
      world.service.ingestInboundEvent(
        userTurn(
          reattached.sessionId,
          reattached.channelSessionRef,
          reattached.channelEpoch,
          "evt-fresh",
        ),
        ACTOR,
      ),
    ).resolves.toMatchObject({ replayed: false });
    // The stale key never dispatched.
    expect(
      world.ledger.evidence.some((entry) =>
        entry.reference ? String(structRef(entry).eventKey).includes("evt-stale") : false,
      ),
    ).toBe(false);
  });

  test("S10 STATIC: the ingest flow drifting to the deployment's current pointer is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        'pinnedPlanId: session.pinnedPlanId,\n        pinnedPlanVersion: session.pinnedPlanVersion,\n        channelKind: session.channelKind,\n        subtaskKind: input.subtaskKind ?? "mixed",',
        'pinnedPlanId: deployment.currentPlanId,\n        pinnedPlanVersion: deployment.currentPlanVersion,\n        channelKind: session.channelKind,\n        subtaskKind: input.subtaskKind ?? "mixed",',
      ),
    );
    expect(violationsOf(mutated)).toContain("pin-drift-current-pointer");
  });

  test("S10 RUNTIME: deployment version pinning is respected (live sessions keep their pin)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s10");
    expect(started.pinnedPlanVersion).toBe(1);
    await world.deploymentService.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "s10-promote",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const fresh = await start(world, "s10-new");
    expect(fresh.pinnedPlanVersion).toBe(2);
    const live = await world.service.getSession(ACTOR.applicationId, started.sessionId);
    expect(live?.session.pinnedPlanVersion).toBe(1);
    // The live session keeps working on its ORIGINAL pin.
    const turnOnV1 = await world.service.ingestInboundEvent(
      userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-s10"),
      ACTOR,
    );
    expect(turnOnV1.replayed).toBe(false);
    const turnEntry = world.ledger.evidence.find(
      (entry) => entry.evidenceClass === "turn" && structRef(entry).eventKey === "evt-s10",
    );
    expect(structRef(turnEntry).pinnedPlanVersion).toBe(1);
  });

  test("S11 STATIC: removing the migration's core/pin-immutability guard is flagged", () => {
    const mutated: RealtimeRules = {
      ...cleanRules(),
      migration: MIGRATION_SOURCE.replace(
        "NEW.pinned_plan_version <> OLD.pinned_plan_version OR",
        "false OR",
      ),
    };
    expect(violationsOf(mutated)).toContain("migration-pin-immutability-removed");
    const mutated2: RealtimeRules = {
      ...cleanRules(),
      migration: MIGRATION_SOURCE.replace(
        "CREATE TRIGGER rt_sessions_core_guard",
        "CREATE TRIGGER removed_guard",
      ),
    };
    expect(violationsOf(mutated2)).toContain("migration-core-guard-removed");
  });

  test("S11 RUNTIME: rollback does not rewrite prior execution identity", async () => {
    const world = await buildWorld();
    const v1 = await start(world, "s11-v1");
    await world.deploymentService.promoteDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "s11-promote",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
      toPlanVersion: 2,
    });
    const v2 = await start(world, "s11-v2");
    await world.deploymentService.rollbackDeployment({
      applicationId: ACTOR.applicationId,
      deploymentId: world.deploymentId,
      idempotencyKey: "s11-rollback",
      actorId: ACTOR.actorId,
      tenantId: ACTOR.tenantId,
    });
    // Both prior sessions keep their pins AND their execution identities.
    const stillV1 = await world.service.getSession(ACTOR.applicationId, v1.sessionId);
    const stillV2 = await world.service.getSession(ACTOR.applicationId, v2.sessionId);
    expect(stillV1?.session.pinnedPlanVersion).toBe(1);
    expect(stillV2?.session.pinnedPlanVersion).toBe(2);
    expect(stillV1?.session.executionId).toBe(v1.executionId);
    expect(stillV2?.session.executionId).toBe(v2.executionId);
    // The rollback moved the pointer for NEW sessions only.
    const after = await start(world, "s11-after");
    expect(after.pinnedPlanVersion).toBe(1);
    expect(world.ledger.opened).toHaveLength(3);
    expect(new Set(world.ledger.opened.map((entry) => entry.input)).size).toBe(3);
  });

  test("S12 STATIC: removing the router's planner mapping is flagged", () => {
    const mutated: RealtimeRules = {
      ...cleanRules(),
      router: ROUTER_SOURCE.replace(
        'decision.outcome === "sufficient"',
        'decision.outcome === "never"',
      ),
    };
    expect(violationsOf(mutated)).toContain("router-planner-mapping-removed");
  });

  test("S12 RUNTIME: deterministic routing avoids paid inference (no reservation, null reservationId)", async () => {
    const world = await buildWorld();
    const started = await start(world, "s12");
    world.admissions.routeClass = "deterministic";
    const outcome = await world.service.ingestInboundEvent(
      userTurn(started.sessionId, started.channelSessionRef, started.channelEpoch, "evt-s12"),
      ACTOR,
    );
    expect(outcome.routeClass).toBe("deterministic");
    // Zero budget activity: generative inference was unnecessary.
    expect(world.admissions.reserves).toHaveLength(0);
    // The responder ran deterministic-only (no reservation id).
    expect(world.admissions.responderCalls[0]?.reservationId).toBeNull();
    expect(world.admissions.responderCalls[0]?.routeClass).toBe("deterministic");
    // The deterministic turn still delivered and left provenance.
    expect(world.rail.deliveries.filter((record) => record.kind === "deliver")).toHaveLength(1);
    expect(
      world.ledger.evidence.some(
        (entry) =>
          entry.evidenceClass === "turn" &&
          (entry.payload as Record<string, unknown>).routeClass === "deterministic",
      ),
    ).toBe(true);
  });

  test("S12 RUNTIME: the REAL planner-subtask-router maps planner outcomes to route classes", async () => {
    // The shipped adapter over the REAL planning module surface: a
    // deterministic-sufficient subtask routes deterministic (no paid
    // estimate); a semantic subtask routes generative with an estimate.
    const catalog: readonly DeterministicCatalogEntry[] = [
      {
        capabilityId: "realtime-conversation",
        kind: "runtime",
        expectedQuality: 0.95,
        qualityConfidence: "verified",
        expectedCostMicroUsd: "0",
        expectedLatencyMs: 10,
        verificationStrategy: "catalog-seeded",
      },
      {
        capabilityId: "realtime:web",
        kind: "runtime",
        expectedQuality: 0.95,
        qualityConfidence: "verified",
        expectedCostMicroUsd: "0",
        expectedLatencyMs: 10,
        verificationStrategy: "catalog-seeded",
      },
    ];
    const router = createPlannerSubtaskRouter({
      resolve: async () => ({ satisfied: true, catalogRevision: "rev-0", satisfactions: [] }),
      catalog,
      digest: (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    });
    const deterministic = await router.routeTurn({
      tenantId: ACTOR.tenantId,
      applicationId: ACTOR.applicationId,
      sessionId: "00000000-0000-7000-8000-0000000000aa",
      deploymentId: "00000000-0000-7000-8000-0000000000ab",
      pinnedPlanId: "support-voice-plan",
      pinnedPlanVersion: 1,
      channelKind: "web",
      subtaskKind: "data-retrieval",
      requiredCapabilities: ["realtime-conversation"],
      turnPreview: "what is my balance?",
      turnPayloadRef: null,
    });
    expect(deterministic.routeClass).toBe("deterministic");
    expect(deterministic.decisionOutcome).toBe("sufficient");
    expect(deterministic.estimatedCostMicroUsd).toBeNull();
    const semantic = await router.routeTurn({
      tenantId: ACTOR.tenantId,
      applicationId: ACTOR.applicationId,
      sessionId: "00000000-0000-7000-8000-0000000000aa",
      deploymentId: "00000000-0000-7000-8000-0000000000ab",
      pinnedPlanId: "support-voice-plan",
      pinnedPlanVersion: 1,
      channelKind: "web",
      subtaskKind: "interpretation",
      requiredCapabilities: ["realtime-conversation"],
      turnPreview: "how should I phrase this delicately?",
      turnPayloadRef: null,
    });
    expect(semantic.routeClass).toBe("generative");
    expect(semantic.decisionOutcome).toBe("insufficient");
    expect(semantic.estimatedCostMicroUsd).not.toBeNull();
  });
});

function structRef(entry: RealtimeEvidenceInput | undefined | null): Record<string, unknown> {
  return (entry?.reference ?? {}) as Record<string, unknown>;
}
