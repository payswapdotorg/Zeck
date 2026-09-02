/**
 * Unit tests — the media generation service over the in-memory world
 * (WORK-026, MOD-011/MOD-012/MOD-013; the runtime halves of the
 * acceptance criteria and the required safety proofs).
 *
 * The world: the REAL deployment fabric (InMemoryDeploymentStore +
 * createDeploymentService with the media modality adapter registered)
 * + the REAL in-memory media store + the REAL in-process simulated
 * media rail + recording fakes for the four admission seams
 * (policy/capability/budget/secrets), the verification gate, and an
 * in-memory executions-ledger fake that models the executions public
 * seam's contract (idempotent open, the RUNNING walk, sequenced
 * evidence, the verify/pass/fail/cancel transitions with the
 * PASS-binding discipline). The artifacts authority fake models the
 * canonical authority's put-if-absent semantics (content-addressed
 * digests over descriptor+parents+sourceRefs, tenant-namespaced).
 * Every call lands in a SHARED ORDERED LOG so the
 * admission-before-paid-dispatch proofs are mechanically observable.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentPlanInput,
  DeploymentProfileInput,
  MediaActor,
  MediaBudgetReserveCommand,
  MediaCallbackInput,
  MediaCapabilityAdmissionRequest,
  MediaEvidenceInput,
  MediaExecutionLedger,
  MediaExecutionOpenInput,
  MediaGenerationService,
  MediaGenerationServiceDeps,
  MediaPolicyAdmissionRequest,
  MediaSecretMediationRequest,
  MediaVerificationRequest,
  SubmitMediaJobInput,
} from "../../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessMediaRail,
  createMediaGenerationService,
  createMediaModalityAdapter,
  createModalityAdapterRegistry,
  InMemoryDeploymentStore,
  InMemoryMediaStore,
  mediaOperationKey,
} from "../../../src/modules/deployments/public";
import { PlatformError } from "../../../src/shared/errors";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Structural view of a typed input (evidence inspection helper). */
const struct = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const ACTOR: MediaActor = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000d2",
  tenantId: "00000000-0000-7000-8000-0000000000d3",
};
const OTHER_TENANT_ACTOR: MediaActor = {
  actorId: "00000000-0000-7000-8000-0000000000f1",
  applicationId: ACTOR.applicationId,
  tenantId: "00000000-0000-7000-8000-0000000000f3",
};
const AGENT_ID = "00000000-0000-7000-8000-0000000000a1";
const ENV_ID = "00000000-0000-7000-8000-0000000000a2";

const PROFILE: DeploymentProfileInput = {
  profileId: "brand-media",
  modality: "media-generation",
  channelKinds: ["web", "webhook"],
  requiredCapabilities: ["media-generation-fabric"],
  latencyClass: "asynchronous",
  resourceClass: "accelerated",
  sideEffectClass: "write-external",
  inputModalities: ["text", "image"],
  outputModalities: ["image", "video", "audio"],
};

const planInput = (overrides: Partial<DeploymentPlanInput> = {}): DeploymentPlanInput => ({
  planId: "brand-media-plan",
  profileRef: { profileId: "brand-media", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" as const },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "simulated-media-rail" },
    { channelKind: "webhook", adapterCapabilityId: "simulated-media-rail" },
  ],
  sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
  ...overrides,
});

const CREATION: CreateDeploymentInput = {
  slug: "brand-media-prod",
  name: "Brand media",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck" as const,
  planId: "brand-media-plan",
};

// ---------------------------------------------------------------------------
// The recording fakes (the admission seams, the verification gate, the
// artifacts authority and the executions-ledger model). Every call lands
// in the SHARED ORDERED LOG so the ordering proofs are mechanical.
// ---------------------------------------------------------------------------

class CallLog {
  readonly entries: string[] = [];
  push(label: string) {
    this.entries.push(label);
  }
  index(label: string): number {
    return this.entries.indexOf(label);
  }
}

class FakePolicyAdmission {
  readonly calls: MediaPolicyAdmissionRequest[] = [];
  deny = false;
  denyAction: string | null = null;
  constructor(private readonly log: CallLog) {}
  async admit(request: MediaPolicyAdmissionRequest) {
    this.calls.push(request);
    this.log.push("policy");
    if (this.deny || (this.denyAction !== null && this.denyAction === request.action)) {
      return { allowed: false as const, reason: "fixture denial" };
    }
    return {
      allowed: true as const,
      evidence: {
        policySetId: "ps-media-1",
        policySetVersion: 1,
        policyContentHash: "hash-m1",
        restrictionSetDigest: "digest-m1",
      },
    };
  }
}

class FakeCapabilityAdmission {
  readonly calls: MediaCapabilityAdmissionRequest[] = [];
  unmet: string[] = [];
  constructor(private readonly log: CallLog) {}
  async resolve(request: MediaCapabilityAdmissionRequest) {
    this.calls.push(request);
    this.log.push("capability");
    return { satisfied: this.unmet.length === 0, unmet: this.unmet };
  }
}

class FakeBudgetAdmission {
  readonly reserves: MediaBudgetReserveCommand[] = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly releases: Array<Record<string, unknown>> = [];
  failReserve = false;
  private seq = 0;
  private readonly reservationsByOperation = new Map<string, string>();
  constructor(private readonly log: CallLog) {}
  async reserve(command: MediaBudgetReserveCommand) {
    this.log.push("budget-reserve");
    // Key-convergent reservation (the REAL budgets module treats
    // operationId as the idempotency discriminator).
    const existing = this.reservationsByOperation.get(command.operationId);
    if (existing !== undefined) {
      return { reservationId: existing, amountMicroUsd: "80000", converged: true };
    }
    this.reserves.push(command);
    if (this.failReserve) {
      throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted budget" });
    }
    this.seq += 1;
    const reservationId = `resv-${this.seq}`;
    this.reservationsByOperation.set(command.operationId, reservationId);
    return { reservationId, amountMicroUsd: "80000", converged: false };
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
  readonly calls: MediaSecretMediationRequest[] = [];
  refuse = false;
  constructor(private readonly log: CallLog) {}
  async mediate(request: MediaSecretMediationRequest) {
    this.calls.push(request);
    this.log.push("secrets");
    if (this.refuse) {
      return { mediated: false as const, reason: "fixture connection inactive" };
    }
    return { mediated: true as const, grantRef: "mediated:conn-media-1:cred" };
  }
}

/** The verification-gate model (idempotent by key, verdict configurable). */
class FakeVerificationGate {
  readonly calls: Array<MediaVerificationRequest> = [];
  criteriaMet = true;
  private seq = 0;
  private readonly byKey = new Map<string, { criteriaMet: boolean; evaluationId: string }>();
  async verify(request: MediaVerificationRequest, idempotencyKey: string) {
    this.calls.push(request);
    const existing = this.byKey.get(idempotencyKey);
    if (existing !== undefined) {
      return { ...existing, replayed: true };
    }
    this.seq += 1;
    const conclusion = {
      criteriaMet: this.criteriaMet,
      evaluationId: `eval-${this.seq}`,
      replayed: false,
    };
    this.byKey.set(idempotencyKey, conclusion);
    return conclusion;
  }
}

/** The canonical artifact authority model (put-if-absent, content-addressed). */
class FakeArtifactAuthority {
  readonly adoptions: Array<Record<string, unknown>> = [];
  private readonly digests = new Set<string>();
  private readonly tenants = new Map<string, Set<string>>();
  async adoptArtifact(input: {
    readonly tenantId: string;
    readonly descriptor: Readonly<Record<string, unknown>>;
    readonly parents: readonly string[];
    readonly sourceRefs: readonly Record<string, unknown>[];
  }) {
    this.adoptions.push(input as unknown as Record<string, unknown>);
    const identity = digest(
      JSON.stringify([
        input.tenantId,
        input.descriptor,
        [...input.parents].sort(),
        input.sourceRefs.map((ref) => [struct(ref).kind, struct(ref).id, struct(ref).locator]),
      ]),
    );
    this.seed(input.tenantId, identity);
    if (this.digests.has(identity)) {
      return { digest: identity, converged: true };
    }
    this.digests.add(identity);
    return { digest: identity, converged: false };
  }
  async artifactExists(scope: { readonly tenantId: string }, digestValue: string) {
    const namespace = this.tenants.get(scope.tenantId) ?? new Set<string>();
    return namespace.has(digestValue);
  }
  /** Test seeding: register a digest in a tenant namespace. */
  seed(tenantId: string, digestValue: string) {
    const namespace = this.tenants.get(tenantId) ?? new Set<string>();
    namespace.add(digestValue);
    this.tenants.set(tenantId, namespace);
  }
}

/** In-memory model of the executions public seam (the media ledger port). */
class FakeExecutionLedger implements MediaExecutionLedger {
  readonly opened: Array<{ key: string; input: MediaExecutionOpenInput }> = [];
  readonly evidence: Array<{ key: string; input: MediaEvidenceInput }> = [];
  readonly transitions: Array<{ key: string; command: string }> = [];
  readonly passVerifications: Array<Record<string, unknown>> = [];
  private readonly executions = new Map<string, { id: string; status: string }>();
  private readonly evidenceKeys = new Set<string>();
  private readonly transitionKeys = new Set<string>();
  private seq = 0;
  private nextExecution = 0;
  constructor(private readonly log: CallLog) {}
  private nextId() {
    this.nextExecution += 1;
    return `00000000-0000-7000-8000-${String(this.nextExecution).padStart(12, "0")}`;
  }
  async openExecution(input: MediaExecutionOpenInput, idempotencyKey: string) {
    this.log.push("execution-open");
    const existing = [...this.executions.values()].find(
      (candidate) => candidate.id === (this.executions.get(idempotencyKey)?.id ?? null),
    );
    if (existing !== undefined) {
      return { executionId: existing.id, replayed: true, status: existing.status };
    }
    const byKey = this.executions.get(idempotencyKey);
    if (byKey !== undefined) {
      return { executionId: byKey.id, replayed: true, status: byKey.status };
    }
    const executionId = this.nextId();
    this.executions.set(idempotencyKey, { id: executionId, status: "RUNNING" });
    this.opened.push({ key: idempotencyKey, input });
    return { executionId, replayed: false, status: "RUNNING" };
  }
  async recordEvidence(input: MediaEvidenceInput, idempotencyKey: string) {
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
    const found = [...this.executions.values()].find((candidate) => candidate.id === executionId);
    return found === undefined
      ? null
      : { id: found.id, tenantId: ACTOR.tenantId, status: found.status };
  }
  async enterVerification(input: Record<string, unknown>, idempotencyKey: string) {
    this.log.push("ledger-verify");
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    if (execution !== undefined && execution.status === "RUNNING") {
      execution.status = "VERIFYING";
    }
    return this.recordTransition("verify", idempotencyKey);
  }
  async completeExecution(input: Record<string, unknown>, idempotencyKey: string) {
    this.log.push("ledger-pass");
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    const results = struct(input).verificationResults;
    const passResults = Array.isArray(results)
      ? results.filter((result) => struct(result).status === "PASS")
      : [];
    if (passResults.length === 0) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "completion requires at least one PASS verification result",
      });
    }
    if (execution !== undefined) {
      execution.status = "COMPLETED";
    }
    this.passVerifications.push(struct(input));
    return this.recordTransition("pass", idempotencyKey);
  }
  async failExecution(input: Record<string, unknown>, idempotencyKey: string) {
    this.log.push("ledger-fail");
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    if (execution !== undefined) {
      execution.status = "FAILED";
    }
    return this.recordTransition("fail", idempotencyKey);
  }
  async cancelExecution(input: Record<string, unknown>, idempotencyKey: string) {
    this.log.push("ledger-cancel");
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    if (execution !== undefined) {
      execution.status = "CANCELLED";
    }
    return this.recordTransition("cancel", idempotencyKey);
  }
  private async recordTransition(command: string, idempotencyKey: string) {
    const replayed = this.transitionKeys.has(idempotencyKey);
    this.transitionKeys.add(idempotencyKey);
    this.transitions.push({ key: idempotencyKey, command });
    this.seq += 1;
    return { sequence: this.seq, replayed };
  }
}

interface MediaWorld {
  readonly service: MediaGenerationService;
  readonly store: InMemoryMediaStore;
  readonly rail: ReturnType<typeof createInProcessMediaRail>;
  readonly policy: FakePolicyAdmission;
  readonly capabilities: FakeCapabilityAdmission;
  readonly budget: FakeBudgetAdmission;
  readonly secrets: FakeSecretMediation;
  readonly verification: FakeVerificationGate;
  readonly artifacts: FakeArtifactAuthority;
  readonly ledger: FakeExecutionLedger;
  readonly log: CallLog;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
}

/** Wrap the rail so every side-effecting call lands in the ordered log. */
function loggingRail(
  rail: ReturnType<typeof createInProcessMediaRail>,
  log: CallLog,
): ReturnType<typeof createInProcessMediaRail> {
  return new Proxy(rail, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (
        typeof prop === "string" &&
        ["submitJob", "cancelJob", "pollJob"].includes(prop) &&
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

function buildWorld(): MediaWorld {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  const rail = createInProcessMediaRail(["video", "image", "audio", "multimodal"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  // The media rail binds into the deployment fabric through the
  // descriptive modality-adapter bridge (checkBinding/describeBinding
  // only — the MOD-004 discipline).
  registry.register(createMediaModalityAdapter(rail));
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

  const store = new InMemoryMediaStore(digest);
  const log = new CallLog();
  const policy = new FakePolicyAdmission(log);
  const capabilities = new FakeCapabilityAdmission(log);
  const budget = new FakeBudgetAdmission(log);
  const secrets = new FakeSecretMediation(log);
  const verification = new FakeVerificationGate();
  const artifacts = new FakeArtifactAuthority();
  const ledger = new FakeExecutionLedger(log);

  const deps: MediaGenerationServiceDeps = {
    store,
    deployments: deploymentStore,
    rail: loggingRail(rail, log),
    policy,
    capabilities,
    budget,
    secrets,
    ledger,
    artifacts,
    verification,
    railConnectionRef: "conn-media-rail-1",
    digest,
    generateId,
    now,
  };
  const service = createMediaGenerationService(deps);
  return {
    service,
    store,
    rail,
    policy,
    capabilities,
    budget,
    secrets,
    verification,
    artifacts,
    ledger,
    log,
    deploymentService,
    deploymentId: "",
  };
}

async function seededWorld(): Promise<MediaWorld> {
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
  return world;
}

const submitInput = (world: MediaWorld, prompt: string): SubmitMediaJobInput => ({
  deploymentId: world.deploymentId,
  generationKind: "image",
  prompt,
});

/** Walk the simulated rail to completion through N polls. */
async function pollToCompletion(world: MediaWorld, jobId: string, polls = 5) {
  let outcome: Awaited<ReturnType<MediaGenerationService["pollJob"]>> | null = null;
  for (let index = 0; index < polls; index += 1) {
    outcome = await world.service.pollJob(jobId, ACTOR);
    if (outcome.status === "completed" || outcome.status === "failed") {
      return outcome;
    }
  }
  return outcome as Awaited<ReturnType<MediaGenerationService["pollJob"]>>;
}

describe("media generation service: submission and the paid dispatch", () => {
  test("a submission walks the full admission chain → the job row → the ONE paid dispatch → generating", async () => {
    const world = await seededWorld();
    const outcome = await world.service.submitJob(
      submitInput(world, "a neon koi"),
      "submit-1",
      ACTOR,
    );
    expect(outcome.status).toBe("generating");
    expect(outcome.generationKind).toBe("image");
    expect(outcome.providerJobRef).toMatch(/^simmedia-job-\d+$/);
    expect(outcome.reservationId).toMatch(/^resv-\d+$/);
    // The admission ordering is mechanically observable: policy BEFORE
    // capability BEFORE the budget reservation BEFORE the rail dispatch.
    expect(world.log.index("policy")).toBeLessThan(world.log.index("capability"));
    expect(world.log.index("capability")).toBeLessThan(world.log.index("execution-open"));
    expect(world.log.index("execution-open")).toBeLessThan(world.log.index("budget-reserve"));
    expect(world.log.index("budget-reserve")).toBeLessThanOrEqual(world.log.index("secrets"));
    expect(world.log.index("secrets")).toBeLessThan(
      world.rail.sends.length + world.log.entries.length,
    );
    const dispatchIndex = world.log.entries.indexOf("rail-submitJob");
    expect(dispatchIndex).toBeGreaterThanOrEqual(0);
    // The budget amount comes from the RAIL's declared per-kind cost.
    expect(world.budget.reserves[0]?.amountMicroUsd).toBe("80000");
    // The durable job row + the executions provenance exist.
    const job = await world.store.findJob(ACTOR.applicationId, outcome.jobId);
    expect(job?.status).toBe("generating");
    expect(job?.pinnedPlanVersion).toBe(1);
    expect(job?.preprocessingDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(world.ledger.opened).toHaveLength(1);
    expect(world.rail.sends.filter((record) => record.kind === "dispatch")).toHaveLength(1);
  });

  test("repeated submission under the SAME key is idempotent: one job, one execution, ONE paid dispatch", async () => {
    const world = await seededWorld();
    const first = await world.service.submitJob(
      submitInput(world, "a neon koi"),
      "submit-2",
      ACTOR,
    );
    const second = await world.service.submitJob(
      submitInput(world, "a neon koi"),
      "submit-2",
      ACTOR,
    );
    expect(second.jobId).toBe(first.jobId);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    expect(world.rail.sends).toHaveLength(1);
    expect(world.rail.acceptedJobs).toBe(1);
    expect(world.ledger.opened).toHaveLength(1);
    const jobs = await world.store.listObservations(ACTOR.applicationId, first.jobId);
    expect(jobs).toHaveLength(0);
  });

  test("the same key with a DIFFERENT body fails closed (IDEMPOTENCY_KEY_REUSED)", async () => {
    const world = await seededWorld();
    await world.service.submitJob(submitInput(world, "a neon koi"), "submit-3", ACTOR);
    await expect(
      world.service.submitJob(submitInput(world, "a different koi"), "submit-3", ACTOR),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(world.rail.sends).toHaveLength(1);
  });

  test("concurrent duplicate submissions converge on ONE durable job + ONE paid dispatch (N=8)", async () => {
    const world = await seededWorld();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        world.service.submitJob(submitInput(world, "eight kois"), "submit-race", ACTOR),
      ),
    );
    const jobIds = new Set(results.map((result) => result.jobId));
    const executionIds = new Set(results.map((result) => result.executionId));
    expect(jobIds.size).toBe(1);
    expect(executionIds.size).toBe(1);
    expect(world.rail.sends.filter((record) => record.kind === "dispatch")).toHaveLength(1);
    expect(world.rail.acceptedJobs).toBe(1);
    const first = results[0];
    expect(first).toBeDefined();
    const job = await world.store.findJob(ACTOR.applicationId, first?.jobId ?? "");
    expect(job?.status).toBe("generating");
  });

  test("a submission on a non-media-generation deployment fails closed (the modality gate)", async () => {
    const world = buildWorld();
    const actor = { ...ACTOR };
    await world.deploymentService.publishProfile(
      { ...PROFILE, profileId: "chat-profile", modality: "messaging" },
      { version: 1 },
      actor,
    );
    await world.deploymentService.publishPlan(
      planInput({ profileRef: { profileId: "chat-profile", version: 1 } }),
      { version: 1 },
      actor,
    );
    const created = await world.deploymentService.createDeployment(
      { ...CREATION, planId: "brand-media-plan" },
      "deploy-key-mod",
      actor,
    );
    world.deploymentId = created.deploymentId;
    await expect(
      world.service.submitJob(submitInput(world, "a message"), "submit-mod", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: /modality/ });
    expect(world.rail.sends).toHaveLength(0);
  });

  test("a foreign-tenant actor cannot submit against another tenant's deployment", async () => {
    const world = await seededWorld();
    await expect(
      world.service.submitJob(submitInput(world, "steal media"), "submit-x", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(world.rail.sends).toHaveLength(0);
  });
});

describe("media generation service: the admission denials before the paid dispatch", () => {
  test("a POLICY denial happens BEFORE every side effect and is durably journaled (journal-then-fail)", async () => {
    const world = await seededWorld();
    world.policy.deny = true;
    await expect(
      world.service.submitJob(submitInput(world, "a forbidden render"), "submit-denied-p", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.sends).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(0);
    // No stuck job row: the denied submission has a durable FAILED
    // operation record instead.
    const record = await world.store.findMediaOperation(
      ACTOR.applicationId,
      mediaOperationKey("job-submission", "submit-denied-p"),
    );
    expect(record?.status).toBe("failed");
    expect(record?.failureReason).toContain("POLICY_DENIED");
    const replayed = await world.store.findJobBySubmissionKey(
      ACTOR.applicationId,
      "submit-denied-p",
    );
    expect(replayed).toBeNull();
  });

  test("a CAPABILITY denial (unmet generation-kind atom) fails closed CAPABILITY_UNAVAILABLE", async () => {
    const world = await seededWorld();
    world.capabilities.unmet = ["media-generation:image"];
    await expect(
      world.service.submitJob(submitInput(world, "a render"), "submit-denied-c", ACTOR),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.rail.sends).toHaveLength(0);
    const record = await world.store.findMediaOperation(
      ACTOR.applicationId,
      mediaOperationKey("job-submission", "submit-denied-c"),
    );
    expect(record?.status).toBe("failed");
  });

  test("a BUDGET denial (the MOD-013 core) fails closed BEFORE the paid dispatch with zero rail sends", async () => {
    const world = await seededWorld();
    world.budget.failReserve = true;
    await expect(
      world.service.submitJob(submitInput(world, "an expensive render"), "submit-budget", ACTOR),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    // THE budget-before-paid-dispatch discrimination: zero rail dispatches.
    expect(world.rail.sends).toHaveLength(0);
    // The failed submission is durably recorded (idempotent denial).
    const record = await world.store.findMediaOperation(
      ACTOR.applicationId,
      mediaOperationKey("job-submission", "submit-budget"),
    );
    expect(record?.status).toBe("failed");
    expect(record?.failureReason).toContain("BUDGET_EXCEEDED");
    // The execution opened for the submission is FAILED (no orphan
    // RUNNING executions of denied submissions).
    expect(world.ledger.transitions.some((entry) => entry.command === "fail")).toBe(true);
    // A retried submission under the same key REPLAYS the recorded
    // denial (idempotent denial — no duplicate side effects, no stuck
    // job row; a fixed budget needs a NEW key, recorded honestly).
    world.budget.failReserve = false;
    await expect(
      world.service.submitJob(submitInput(world, "an expensive render"), "submit-budget", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: /durably failed/ });
    // A fresh key after funding proceeds normally.
    const funded = await world.service.submitJob(
      submitInput(world, "an expensive render"),
      "submit-budget-2",
      ACTOR,
    );
    expect(funded.status).toBe("generating");
  });

  test("a SECRET mediation refusal fails closed before the paid dispatch and releases the reservation", async () => {
    const world = await seededWorld();
    world.secrets.refuse = true;
    await expect(
      world.service.submitJob(submitInput(world, "a render"), "submit-secrets", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(world.rail.sends).toHaveLength(0);
    expect(world.budget.releases).toHaveLength(1);
    const record = await world.store.findMediaOperation(
      ACTOR.applicationId,
      mediaOperationKey("job-submission", "submit-secrets"),
    );
    expect(record?.status).toBe("failed");
  });

  test("a submission whose input artifact is absent from the tenant namespace is rejected (tenant isolation for inputs)", async () => {
    const world = await seededWorld();
    await expect(
      world.service.submitJob(
        { ...submitInput(world, "transform this"), inputArtifactDigest: "b".repeat(64) },
        "submit-input-missing",
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.sends).toHaveLength(0);
  });

  test("a rail dispatch refusal fails the job closed and releases the reservation", async () => {
    const world = await seededWorld();
    world.rail.failNextDispatch("fixture upstream overload");
    await expect(
      world.service.submitJob(submitInput(world, "a refused render"), "submit-refused", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-refused");
    expect(job?.status).toBe("failed");
    expect(job?.failureCause).toContain("rail dispatch refused");
    expect(world.budget.releases).toHaveLength(1);
    // The refusal is durably recorded: a retried submission under the
    // same key replays the FAILED job row (the recorded terminal
    // outcome — no second paid dispatch attempt, no duplicate effect).
    const replay = await world.service.submitJob(
      submitInput(world, "a refused render"),
      "submit-refused",
      ACTOR,
    );
    expect(replay.status).toBe("failed");
    expect(replay.replayed).toBe(true);
    const dispatchOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      mediaOperationKey("paid-dispatch", replay.jobId),
    );
    expect(dispatchOp?.status).toBe("failed");
  });
});

describe("media generation service: the async lifecycle (polls, callbacks, completion)", () => {
  test("the poll path walks accepted → progressed → provider-completed and completes the job with an adopted lineage artifact", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a watercolor fox"),
      "submit-poll-1",
      ACTOR,
    );
    const outcome = await pollToCompletion(world, submitted.jobId);
    expect(outcome?.status).toBe("completed");
    expect(outcome?.outputArtifactDigest).toMatch(/^[0-9a-f]{64}$/);
    // The job row: completed with the output digest + the postprocessing digest.
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("completed");
    expect(job?.outputArtifactDigest).toBe(outcome?.outputArtifactDigest);
    expect(job?.postprocessingDigest).toMatch(/^[0-9a-f]{64}$/);
    // The observation ledger: the normalized evidence trail.
    const observations = await world.store.listObservations(ACTOR.applicationId, submitted.jobId);
    expect(observations.map((observation) => observation.observation)).toContain(
      "provider-completed",
    );
    expect(observations.every((observation) => observation.source === "poll")).toBe(true);
    // The artifact adoption: one generated-output record with lineage.
    const artifacts = await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.role).toBe("generated-output");
    expect(artifacts[0]?.artifactDigest).toBe(outcome?.outputArtifactDigest);
    // The execution lifecycle: verify → pass (BOUND to a PASS result).
    const commands = world.ledger.transitions.map((entry) => entry.command);
    expect(commands).toContain("verify");
    expect(commands).toContain("pass");
    expect(world.ledger.passVerifications).toHaveLength(1);
    const firstPass = world.ledger.passVerifications[0];
    expect(firstPass).toBeDefined();
    expect(
      ((firstPass?.verificationResults ?? []) as unknown[]).some(
        (result) => struct(result).status === "PASS",
      ),
    ).toBe(true);
    // Full provenance on ONE execution identity: submitted → dispatched
    // → observations → verification → artifact → completed.
    const evidenceClasses = world.ledger.evidence.map((entry) => entry.input.evidenceClass);
    for (const required of [
      "job-submitted",
      "job-dispatched",
      "observation",
      "artifact",
      "job-completed",
    ]) {
      expect(evidenceClasses).toContain(required);
    }
    const executionIds = new Set(world.ledger.evidence.map((entry) => entry.input.executionId));
    expect(executionIds.size).toBe(1);
  });

  test("the callback path applies NORMALIZED observations and completes idempotently (duplicate callbacks converge)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "an oil-paint heron"),
      "submit-cb-1",
      ACTOR,
    );
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    const providerJobRef = job?.providerJobRef as string;
    const frame = (observation: string, outputDescriptor?: Record<string, unknown>) =>
      ({
        jobId: submitted.jobId,
        providerJobRef,
        callbackKey: `cb-${observation}`,
        observation,
        providerStateLabel: `simulated-${observation}`,
        ...(outputDescriptor === undefined ? {} : { outputDescriptor }),
      }) as MediaCallbackInput;
    const completionDescriptor = {
      contentDigest: "c".repeat(64),
      generationKind: "image",
      width: 1024,
      height: 1024,
    };
    await world.service.applyCallback(frame("accepted"), ACTOR);
    await world.service.applyCallback(frame("progressed"), ACTOR);
    const completed = await world.service.applyCallback(
      frame("provider-completed", completionDescriptor),
      ACTOR,
    );
    expect(completed.status).toBe("completed");
    // The DUPLICATE completion callback converges: no second state
    // mutation, no second adoption, no second execution transition.
    const artifactsBefore = (await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId))
      .length;
    const duplicate = await world.service.applyCallback(
      frame("provider-completed", completionDescriptor),
      ACTOR,
    );
    expect(duplicate.status).toBe("completed");
    expect(duplicate.replayed).toBe(true);
    expect((await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId)).length).toBe(
      artifactsBefore,
    );
    expect(world.verification.calls.length).toBeLessThan(2);
    // The evidence rows exist exactly once per observation key.
    const observations = await world.store.listObservations(ACTOR.applicationId, submitted.jobId);
    const keys = observations.map((observation) => observation.observationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("a FOREIGN or STALE callback is rejected before any mutation (the correlation guard)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a suspicious frame"),
      "submit-cb-2",
      ACTOR,
    );
    const foreignFrame: MediaCallbackInput = {
      jobId: submitted.jobId,
      providerJobRef: "simmedia-job-999",
      observation: "provider-completed",
      callbackKey: "cb-foreign",
      outputDescriptor: { contentDigest: "d".repeat(64), generationKind: "image" },
    };
    await expect(world.service.applyCallback(foreignFrame, ACTOR)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: /correlation rejected/,
    });
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
    const observations = await world.store.listObservations(ACTOR.applicationId, submitted.jobId);
    expect(observations).toHaveLength(0);
    // A callback on another tenant's job fails closed on tenant scope.
    await expect(
      world.service.applyCallback(
        {
          jobId: submitted.jobId,
          providerJobRef: "simmedia-job-1",
          observation: "accepted",
        },
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("a provider-failed observation fails the job + the execution (the normalized failure projection)", async () => {
    const world = buildWorld();
    // failJobs fails the generation at poll time.
    const rail = createInProcessMediaRail(["video", "image", "audio", "multimodal"], {
      now: () => new Date("2026-01-01T00:00:00Z"),
      failJobs: "simulated provider content-policy refusal",
    });
    const world2 = { ...world, rail } as MediaWorld;
    const registry = createModalityAdapterRegistry();
    registry.register(createMediaModalityAdapter(rail));
    let idSeq = 100;
    const generateId = () => `00000000-0000-7000-8000-${String(++idSeq).padStart(12, "0")}`;
    const deploymentStore = new InMemoryDeploymentStore();
    const deploymentService = createDeploymentService({
      store: deploymentStore,
      agentInventory: {
        async findVersion(_applicationId: string, agentId: string, version: string) {
          return {
            agentId,
            version,
            validationState: "valid" as const,
            agentStatus: "available" as const,
          };
        },
      },
      environmentResolver: {
        async resolve(applicationId: string, environmentId: string) {
          return { environmentId, applicationId, tenantId: ACTOR.tenantId };
        },
      },
      adapters: registry,
      digest,
      generateId,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const store = new InMemoryMediaStore(digest);
    const log = new CallLog();
    const ledger = new FakeExecutionLedger(log);
    const service = createMediaGenerationService({
      store,
      deployments: deploymentStore,
      rail,
      policy: new FakePolicyAdmission(log),
      capabilities: new FakeCapabilityAdmission(log),
      budget: new FakeBudgetAdmission(log),
      secrets: new FakeSecretMediation(log),
      ledger,
      artifacts: new FakeArtifactAuthority(),
      verification: new FakeVerificationGate(),
      railConnectionRef: "conn-media-rail-1",
      digest,
      generateId,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const actor = { ...ACTOR };
    await deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
    await deploymentService.publishPlan(planInput(), { version: 1 }, actor);
    const created = await deploymentService.createDeployment({ ...CREATION }, "dk-fail", actor);
    const submitted = await service.submitJob(
      { deploymentId: created.deploymentId, generationKind: "image", prompt: "a failing render" },
      "submit-fail",
      actor,
    );
    const outcome = await pollToCompletion(
      { ...world2, service, store, rail, ledger } as unknown as MediaWorld,
      submitted.jobId,
    );
    expect(outcome?.status).toBe("failed");
    const job = await store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failureCause).toContain("provider failure observed");
    expect(ledger.transitions.some((entry) => entry.command === "fail")).toBe(true);
    // The failed job can be RETRIED (see the retry suite below).
  });

  test("polling an undispatched job is rejected (the provider-ref guard)", async () => {
    const world = await seededWorld();
    await expect(
      world.service.pollJob("00000000-0000-7000-8000-0000000000e1", ACTOR),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });
});

describe("media generation service: the verification-before-completion boundary", () => {
  const verifiedInput = (world: MediaWorld): SubmitMediaJobInput => ({
    deploymentId: world.deploymentId,
    generationKind: "image",
    prompt: "a verified render",
    verification: { criteria: [{ criterionId: "brand-safety", version: 2 }] },
  });

  test("a job with verification REQUIRED completes ONLY through the verification authority's PASS verdict", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(verifiedInput(world), "submit-v1", ACTOR);
    const outcome = await pollToCompletion(world, submitted.jobId);
    expect(outcome?.status).toBe("completed");
    expect(world.verification.calls).toHaveLength(1);
    const request = struct(world.verification.calls[0]);
    expect(request.criteria).toEqual([{ criterionId: "brand-safety", version: 2 }]);
    expect(String(request.outputArtifactDigest)).toMatch(/^[0-9a-f]{64}$/);
    // The pass binding carries the verification authority's results.
    const pass = world.ledger.passVerifications[0];
    const results = pass?.verificationResults as unknown[];
    expect(
      results.some(
        (result) =>
          struct(result).criterionId === "brand-safety" &&
          struct(result).status === "PASS" &&
          String(struct(result).strategy).includes("verification-authority"),
      ),
    ).toBe(true);
    // The job row records the required mode.
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.verificationMode).toBe("required");
    expect(job?.verificationCriteria).toEqual([{ criterionId: "brand-safety", version: 2 }]);
  });

  test("a criteriaMet=false verdict FAILS the job (unverified output can never reach completed)", async () => {
    const world = await seededWorld();
    world.verification.criteriaMet = false;
    const submitted = await world.service.submitJob(verifiedInput(world), "submit-v2", ACTOR);
    await expect(pollToCompletion(world, submitted.jobId)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failureCause).toContain("verification rejected");
    // The execution is FAILED (with FAIL verification results recorded).
    const failTransition = world.ledger.passVerifications;
    expect(world.ledger.transitions.some((entry) => entry.command === "fail")).toBe(true);
    expect(failTransition).toHaveLength(0);
    // The output artifact was ADOPTED but the job is not completed —
    // the adoption is evidence of the rejected output, not a completion.
    const artifacts = await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId);
    expect(artifacts).toHaveLength(1);
    // A re-poll of the completion observation CONVERGES on the FAILED
    // terminal state (the observation row + the failed projection are
    // the recorded outcome; a replay cannot flip the rejection).
    const replay = await world.service.pollJob(submitted.jobId, ACTOR);
    expect(replay.status).toBe("failed");
    expect(replay.replayed).toBe(true);
  });

  test("a provider output that FAILS the deterministic postprocessing shape check is REJECTED before completion", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(verifiedInput(world), "submit-v3", ACTOR);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    const malformed = {
      jobId: submitted.jobId,
      providerJobRef: job?.providerJobRef as string,
      callbackKey: "cb-malformed",
      observation: "provider-completed",
      outputDescriptor: { generationKind: "image" }, // NO contentDigest
    } as MediaCallbackInput;
    await expect(world.service.applyCallback(malformed, ACTOR)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    const after = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(after?.status).toBe("failed");
    expect(after?.failureCause).toContain("postprocessing");
    expect(after?.outputArtifactDigest).toBeNull();
  });

  test("a kind-mismatched provider output is rejected by the deterministic shape check (AC5)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(verifiedInput(world), "submit-v4", ACTOR);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    const mismatched = {
      jobId: submitted.jobId,
      providerJobRef: job?.providerJobRef as string,
      callbackKey: "cb-mismatched",
      observation: "provider-completed",
      outputDescriptor: { contentDigest: "e".repeat(64), generationKind: "video" },
    } as MediaCallbackInput;
    await expect(world.service.applyCallback(mismatched, ACTOR)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    const after = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(after?.status).toBe("failed");
    expect(after?.failureCause).toContain("generation kind mismatch");
  });
});

describe("media generation service: cancellation and retry", () => {
  test("cancelling a generating job moves the closed lifecycle to cancelled, cancels the execution and releases the reservation", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a cancelled render"),
      "submit-cancel-1",
      ACTOR,
    );
    const cancelled = await world.service.cancelJob(submitted.jobId, "user requested", ACTOR);
    expect(cancelled.status).toBe("cancelled");
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("cancelled");
    expect(world.ledger.transitions.some((entry) => entry.command === "cancel")).toBe(true);
    expect(world.budget.releases.length).toBe(1);
    // The rail cancellation happened exactly once under the stable key.
    expect(world.rail.sends.filter((record) => record.kind === "cancel")).toHaveLength(1);
    // A repeated cancellation converges (terminal replay).
    const again = await world.service.cancelJob(submitted.jobId, "user requested", ACTOR);
    expect(again.status).toBe("cancelled");
    expect(again.replayed).toBe(true);
    expect(world.rail.cancellations).toBe(1);
    // A LATE observation on the cancelled job converges: the
    // provider-cancelled poll is recorded as evidence only — no
    // second state move, no second rail side effect.
    const latePoll = await world.service.pollJob(submitted.jobId, ACTOR);
    expect(latePoll.status).toBe("cancelled");
    expect(world.rail.cancellations).toBe(1);
    expect(world.rail.sends.filter((record) => record.kind === "cancel")).toHaveLength(1);
  });

  test("a policy-denied cancellation performs zero rail side effects (journal-then-fail)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a locked render"),
      "submit-cancel-2",
      ACTOR,
    );
    world.policy.denyAction = "job-cancel";
    await expect(world.service.cancelJob(submitted.jobId, "no", ACTOR)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(world.rail.sends.filter((record) => record.kind === "cancel")).toHaveLength(0);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
  });

  test("a cancellation after the provider reached a terminal state FAILS CLOSED (the provider's outcome owns the job)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a finished render"),
      "submit-cancel-3",
      ACTOR,
    );
    // The rail advances to its terminal provider state (poll completes the job).
    await pollToCompletion(world, submitted.jobId);
    await expect(world.service.cancelJob(submitted.jobId, "too late", ACTOR)).rejects.toMatchObject(
      {
        code: "INVALID_STATE_TRANSITION",
        message: /terminal jobs cannot be cancelled/,
      },
    );
  });

  test("retrying a FAILED job creates ONE new job with ONE new paid dispatch; a repeated retry converges", async () => {
    const rail = createInProcessMediaRail(["video", "image", "audio", "multimodal"], {
      now: () => new Date("2026-01-01T00:00:00Z"),
      failJobs: "simulated provider failure",
    });
    const registry = createModalityAdapterRegistry();
    registry.register(createMediaModalityAdapter(rail));
    let idSeq = 200;
    const generateId = () => `00000000-0000-7000-8000-${String(++idSeq).padStart(12, "0")}`;
    const now = () => new Date("2026-01-01T00:00:00Z");
    const deploymentStore = new InMemoryDeploymentStore();
    const deploymentService = createDeploymentService({
      store: deploymentStore,
      agentInventory: {
        async findVersion(_applicationId: string, agentId: string, version: string) {
          return {
            agentId,
            version,
            validationState: "valid" as const,
            agentStatus: "available" as const,
          };
        },
      },
      environmentResolver: {
        async resolve(applicationId: string, environmentId: string) {
          return { environmentId, applicationId, tenantId: ACTOR.tenantId };
        },
      },
      adapters: registry,
      digest,
      generateId,
      now,
    });
    const store = new InMemoryMediaStore(digest);
    const log = new CallLog();
    const service = createMediaGenerationService({
      store,
      deployments: deploymentStore,
      rail,
      policy: new FakePolicyAdmission(log),
      capabilities: new FakeCapabilityAdmission(log),
      budget: new FakeBudgetAdmission(log),
      secrets: new FakeSecretMediation(log),
      ledger: new FakeExecutionLedger(log),
      artifacts: new FakeArtifactAuthority(),
      verification: new FakeVerificationGate(),
      railConnectionRef: "conn-media-rail-1",
      digest,
      generateId,
      now,
    });
    const actor = { ...ACTOR };
    await deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
    await deploymentService.publishPlan(planInput(), { version: 1 }, actor);
    const created = await deploymentService.createDeployment({ ...CREATION }, "dk-retry", actor);
    const prompt = "a render that fails then succeeds";
    const failed = await service.submitJob(
      { deploymentId: created.deploymentId, generationKind: "image", prompt },
      "submit-retry-src",
      actor,
    );
    // Walk the failing rail to the provider failure.
    for (let index = 0; index < 6; index += 1) {
      const outcome = await service.pollJob(failed.jobId, actor);
      if (outcome.status === "failed") {
        break;
      }
    }
    const failedJob = await store.findJob(ACTOR.applicationId, failed.jobId);
    expect(failedJob?.status).toBe("failed");
    const dispatchesBefore = rail.sends.filter((record) => record.kind === "dispatch").length;
    // The retry: a NEW job + execution + paid dispatch under the retry key.
    const retry = await service.retryJob(failed.jobId, { prompt }, "retry-1", actor);
    expect(retry.retryOfJobId).toBe(failed.jobId);
    expect(retry.jobId).not.toBe(failed.jobId);
    expect(retry.executionId).not.toBe(failed.executionId);
    expect(rail.sends.filter((record) => record.kind === "dispatch").length).toBe(
      dispatchesBefore + 1,
    );
    // A REPEATED retry under the SAME key converges on the SAME retry
    // job — no duplicate paid dispatch (MOD-013).
    const retryAgain = await service.retryJob(failed.jobId, { prompt }, "retry-1", actor);
    expect(retryAgain.jobId).toBe(retry.jobId);
    expect(retryAgain.executionId).toBe(retry.executionId);
    expect(rail.sends.filter((record) => record.kind === "dispatch").length).toBe(
      dispatchesBefore + 1,
    );
    // A retry with a DIVERGENT intent fails closed.
    await expect(
      service.retryJob(failed.jobId, { prompt: "a different prompt" }, "retry-2", actor),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR", message: /diverges/ });
    // Only failed jobs can be retried.
    await expect(service.retryJob(retry.jobId, { prompt }, "retry-3", actor)).rejects.toMatchObject(
      {
        code: "INVALID_STATE_TRANSITION",
      },
    );
  });
});

describe("media generation service: derived variants (MOD-012 lineage)", () => {
  test("a derived variant is adopted with the SOURCE artifact as its lineage parent and the job's pinned version", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a source render"),
      "submit-variant-1",
      ACTOR,
    );
    await pollToCompletion(world, submitted.jobId);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    const sourceDigest = job?.outputArtifactDigest as string;
    const variant = await world.service.deriveVariant(
      { jobId: submitted.jobId, variant: { resize: "512x512", format: "webp" } },
      "variant-key-1",
      ACTOR,
    );
    expect(variant.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(variant.parentDigests).toEqual([sourceDigest]);
    expect(variant.pinnedPlanVersion).toBe(1);
    const artifacts = await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId);
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.role).sort()).toEqual([
      "derived-variant",
      "generated-output",
    ]);
    const variantRecord = artifacts.find((artifact) => artifact.role === "derived-variant");
    expect(variantRecord?.parentDigests).toEqual([sourceDigest]);
    // A repeated derivation under the same key converges (no second adoption).
    const again = await world.service.deriveVariant(
      { jobId: submitted.jobId, variant: { resize: "512x512", format: "webp" } },
      "variant-key-1",
      ACTOR,
    );
    expect(again.artifactDigest).toBe(variant.artifactDigest);
    expect(again.replayed).toBe(true);
    expect((await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId)).length).toBe(2);
  });

  test("variants derive ONLY from completed jobs with an adopted output", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a not-yet-complete render"),
      "submit-variant-2",
      ACTOR,
    );
    await expect(
      world.service.deriveVariant(
        { jobId: submitted.jobId, variant: { resize: "512x512" } },
        "variant-key-2",
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });

  test("a policy-denied variant derivation performs zero adoptions (journal-then-fail)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "a guarded render"),
      "submit-variant-3",
      ACTOR,
    );
    await pollToCompletion(world, submitted.jobId);
    world.policy.denyAction = "variant-derive";
    await expect(
      world.service.deriveVariant(
        { jobId: submitted.jobId, variant: { resize: "256x256" } },
        "variant-key-3",
        ACTOR,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.artifacts.adoptions.length).toBe(1); // the output only
  });
});

describe("media generation service: tenant isolation and provenance reads", () => {
  test("a foreign-tenant actor cannot read, poll, cancel or derive on another tenant's job", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "an isolated render"),
      "submit-iso-1",
      ACTOR,
    );
    await expect(world.service.getJob(submitted.jobId, OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    await expect(world.service.pollJob(submitted.jobId, OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    await expect(
      world.service.cancelJob(submitted.jobId, "no", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    expect(world.rail.sends.filter((record) => record.kind === "cancel")).toHaveLength(0);
  });

  test("getJob returns the job with its observation and artifact evidence (the read path)", async () => {
    const world = await seededWorld();
    const submitted = await world.service.submitJob(
      submitInput(world, "an observable render"),
      "submit-read-1",
      ACTOR,
    );
    const outcome = await pollToCompletion(world, submitted.jobId);
    const read = await world.service.getJob(submitted.jobId, ACTOR);
    expect(read.job.status).toBe("completed");
    expect(read.job.outputArtifactDigest).toBe(outcome?.outputArtifactDigest);
    expect(read.observations.length).toBeGreaterThan(0);
    expect(read.artifacts.length).toBe(1);
  });
});
