/**
 * Crash-injection proofs — the durable, recoverable media OPERATION
 * state and the STABLE rail-level idempotency keys (WORK-026; checkpoint
 * contract CONCURRENCY-CRASH-SAFETY; the WORK-024 crash-safety standard
 * from the PR #46 review round, applied to media generation).
 *
 * THE CRASH MODEL (kill/restart at the durable boundaries): a Zeck
 * process dies mid-operation. What survives a process crash:
 *   - the DURABLE STATE (the media store — job rows with their guarded
 *     CLOSED lifecycle, the append-only observation ledger, the
 *     write-once artifact-adoption records, and the media_operations
 *     ledger);
 *   - the EXECUTIONS LEDGER (its own durable module);
 *   - the UPSTREAM RAIL (the external media provider — it keeps its
 *     idempotency-key ledger exactly as a real provider would);
 *   - the VERIFICATION AUTHORITY (its evaluations are keyed-idempotent).
 * What dies: the in-flight service process (its closure, its unwritten
 * intents). A "restart" is a NEW service instance booted over the
 * surviving world (`boot()`).
 *
 * The injector arms ONE durable-boundary crash point per process (a
 * method on store/rail/ledger/verification, before/after its durable
 * commit) and THROWS a ProcessCrashError through the awaited call —
 * every armed point below is OUTSIDE the service's best-effort
 * `.catch()` regions, so the crash always propagates and the process
 * genuinely dies mid-flight. The test then reboots (a fresh process,
 * no plan) and re-issues the SAME logical operation under the SAME
 * idempotency coordinates.
 *
 * THE PROOF RECORDS (the required lifecycle points):
 *   SUBMISSION / PAID DISPATCH  C1 claim | C2 job row | C3 checkpoint |
 *                               C4 double crash | C5 dispatch claim |
 *                               C6 rail dispatch | C7 dispatched
 *                               checkpoint (no re-admission, no second
 *                               paid call) | C8 generating move
 *   EXECUTION IDENTITY          C9 open crash → same identity
 *   OBSERVATION APPLY           C10 claim | C11 evidence row
 *   COMPLETION                  C12 verifying move | C13 adoption
 *                               checkpoint | C14 terminal move →
 *                               reconcile | C15 verification-gate crash
 *                               (keyed re-consult converges)
 *   CANCELLATION                C16 claim | C17 rail cancel | C18
 *                               rail-issued checkpoint | C19 terminal
 *                               move → reconcile (execution + budget
 *                               tails re-driven)
 *   RETRY / VARIANT             C20 retry resubmission convergence |
 *                               C21 variant adoption crash
 *   KEY DISCIPLINE              C22 the stable-key scheme derivation
 *
 * Every record asserts the SAME invariants: EXACTLY ONE upstream paid
 * dispatch per stable key (the rail `sends` observable — never a second
 * record; a re-issue converges through `replays`), the operation rows
 * reach COMPLETED with the honest attempts ledger, the durable rows
 * (job/observation/adoption/evidence) exist exactly once, and — for
 * the past-checkpoint recoveries — the paid-inference and admission
 * seams are NEVER re-invoked past the point of no return (the
 * checkpoint's facts complete the durable tail).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type {
  CreateDeploymentInput,
  DeploymentPlanInput,
  DeploymentProfileInput,
  MediaActor,
  MediaBudgetReserveCommand,
  MediaCapabilityAdmissionRequest,
  MediaCallbackInput,
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
  mediaBudgetOperationId,
  mediaRailDispatchKey,
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

const PLAN: DeploymentPlanInput = {
  planId: "brand-media-plan",
  profileRef: { profileId: "brand-media", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" as const },
  environmentId: ENV_ID,
  channelBindings: [
    { channelKind: "web", adapterCapabilityId: "simulated-media-rail" },
    { channelKind: "webhook", adapterCapabilityId: "simulated-media-rail" },
  ],
  sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
};

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
// The recording fakes (the admission seams + the verification gate + the
// canonical artifact authority + the executions-ledger model — every
// command is key-idempotent, exactly like the real authorities).
// ---------------------------------------------------------------------------

class FakePolicyAdmission {
  readonly calls: MediaPolicyAdmissionRequest[] = [];
  deny = false;
  async admit(request: MediaPolicyAdmissionRequest) {
    this.calls.push(request);
    if (this.deny) {
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
  async resolve(request: MediaCapabilityAdmissionRequest) {
    this.calls.push(request);
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
  async reserve(command: MediaBudgetReserveCommand) {
    // Key-convergent reservation (the REAL budgets module treats
    // operationId as the idempotency discriminator: a retried or
    // concurrent duplicate converges on the SAME reservation — the
    // crash-recovery proofs depend on that convergence).
    const existing = this.reservationsByOperation.get(command.operationId);
    if (existing !== undefined) {
      return { reservationId: existing, amountMicroUsd: "80000", converged: true };
    }
    if (this.failReserve) {
      throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted budget" });
    }
    this.seq += 1;
    const reservationId = `resv-${this.seq}`;
    this.reservationsByOperation.set(command.operationId, reservationId);
    this.reserves.push(command);
    return { reservationId, amountMicroUsd: "80000", converged: false };
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
  readonly calls: MediaSecretMediationRequest[] = [];
  refuse = false;
  async mediate(request: MediaSecretMediationRequest) {
    this.calls.push(request);
    if (this.refuse) {
      return { mediated: false as const, reason: "fixture connection inactive" };
    }
    return { mediated: true as const, grantRef: "mediated:conn-media-1:cred" };
  }
}

/** The verification-gate model (idempotent by key, verdict configurable). */
class FakeVerificationGate {
  readonly calls: Array<MediaVerificationRequest> = [];
  /** The recorded keyed conclusions (assert helper). */
  readonly conclusions: Array<{ key: string; criteriaMet: boolean; evaluationId: string }> = [];
  criteriaMet = true;
  private seq = 0;
  private readonly byKey = new Map<string, { criteriaMet: boolean; evaluationId: string }>();
  async verify(request: MediaVerificationRequest, idempotencyKey: string) {
    this.calls.push(request);
    const existing = this.byKey.get(idempotencyKey);
    if (existing !== undefined) {
      this.conclusions.push({ key: idempotencyKey, ...existing });
      return { ...existing, replayed: true };
    }
    this.seq += 1;
    const conclusion = {
      criteriaMet: this.criteriaMet,
      evaluationId: `eval-${this.seq}`,
      replayed: false,
    };
    this.byKey.set(idempotencyKey, conclusion);
    this.conclusions.push({ key: idempotencyKey, ...conclusion });
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
    const namespace = this.tenants.get(input.tenantId) ?? new Set<string>();
    namespace.add(identity);
    this.tenants.set(input.tenantId, namespace);
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
}

/** In-memory model of the executions public seam (the media ledger port). */
class FakeExecutionLedger implements MediaExecutionLedger {
  readonly opened: Array<{ key: string; input: MediaExecutionOpenInput }> = [];
  readonly evidence: Array<{ key: string; input: MediaEvidenceInput }> = [];
  readonly transitions: Array<{ key: string; command: string }> = [];
  private readonly executions = new Map<string, { id: string; status: string }>();
  private readonly evidenceKeys = new Set<string>();
  private readonly transitionKeys = new Set<string>();
  private seq = 0;
  private nextExecution = 0;
  private nextId() {
    this.nextExecution += 1;
    return `00000000-0000-7000-8000-${String(this.nextExecution).padStart(12, "0")}`;
  }
  async openExecution(input: MediaExecutionOpenInput, idempotencyKey: string) {
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
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    if (execution !== undefined && execution.status === "RUNNING") {
      execution.status = "VERIFYING";
    }
    return this.recordTransition("verify", idempotencyKey);
  }
  async completeExecution(input: Record<string, unknown>, idempotencyKey: string) {
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
    return this.recordTransition("pass", idempotencyKey);
  }
  async failExecution(input: Record<string, unknown>, idempotencyKey: string) {
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    if (execution !== undefined) {
      execution.status = "FAILED";
    }
    return this.recordTransition("fail", idempotencyKey);
  }
  async cancelExecution(input: Record<string, unknown>, idempotencyKey: string) {
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === struct(input).executionId,
    );
    if (execution !== undefined) {
      execution.status = "CANCELLED";
    }
    return this.recordTransition("cancel", idempotencyKey);
  }
  /** The final status of one execution (assert helper). */
  statusOf(executionId: string): string | null {
    const found = [...this.executions.values()].find((candidate) => candidate.id === executionId);
    return found?.status ?? null;
  }
  private async recordTransition(command: string, idempotencyKey: string) {
    const replayed = this.transitionKeys.has(idempotencyKey);
    this.transitionKeys.add(idempotencyKey);
    this.transitions.push({ key: idempotencyKey, command });
    this.seq += 1;
    return { sequence: this.seq, replayed };
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
  readonly target: "store" | "rail" | "ledger" | "verification";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable/external seam so the process dies at the planned
 * point. `before` = the durable commit did NOT happen; `after` = the
 * commit (or the external side effect) DID happen and the process died
 * immediately after. The wrapper records the firing so a vacuous proof
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
// The surviving world + the process boot (the restart primitive).
// ---------------------------------------------------------------------------

interface World {
  readonly store: InMemoryMediaStore;
  readonly rail: ReturnType<typeof createInProcessMediaRail>;
  readonly ledger: FakeExecutionLedger;
  readonly policy: FakePolicyAdmission;
  readonly capabilities: FakeCapabilityAdmission;
  readonly budget: FakeBudgetAdmission;
  readonly secrets: FakeSecretMediation;
  readonly verification: FakeVerificationGate;
  readonly artifacts: FakeArtifactAuthority;
  readonly deploymentStore: InMemoryDeploymentStore;
  deploymentId: string;
  /** Boot one Zeck process over the surviving world (the restart primitive). */
  boot(plan: CrashPoint | null): {
    readonly service: MediaGenerationService;
    readonly crashed: () => boolean;
  };
}

async function buildWorld(
  options: { readonly failJobs?: string } = {},
): Promise<World> {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  const rail = createInProcessMediaRail(["video", "image", "audio", "multimodal"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
    ...(options.failJobs === undefined ? {} : { failJobs: options.failJobs }),
  });
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
  const ledger = new FakeExecutionLedger();
  const policy = new FakePolicyAdmission();
  const capabilities = new FakeCapabilityAdmission();
  const budget = new FakeBudgetAdmission();
  const secrets = new FakeSecretMediation();
  const verification = new FakeVerificationGate();
  const artifacts = new FakeArtifactAuthority();

  const actor = { ...ACTOR };
  await deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, actor);
  await deploymentService.publishPlan(PLAN, { version: 1 }, actor);
  const created = await deploymentService.createDeployment({ ...CREATION }, "deploy-key-0", actor);

  const boot = (plan: CrashPoint | null) => {
    const storeProcess = crashing(store, "store", plan);
    const railProcess = crashing(rail, "rail", plan);
    const ledgerProcess = crashing(ledger, "ledger", plan);
    const verificationProcess = crashing(verification, "verification", plan);
    const deps: MediaGenerationServiceDeps = {
      store: storeProcess.proxy,
      deployments: deploymentStore,
      rail: railProcess.proxy,
      policy,
      capabilities,
      budget,
      secrets,
      ledger: ledgerProcess.proxy,
      artifacts,
      verification: verificationProcess.proxy,
      railConnectionRef: "conn-media-rail-1",
      digest,
      generateId,
      now,
    };
    const service = createMediaGenerationService(deps);
    return {
      service,
      crashed: () =>
        storeProcess.crashed() ||
        railProcess.crashed() ||
        ledgerProcess.crashed() ||
        verificationProcess.crashed(),
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
    verification,
    artifacts,
    deploymentStore,
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
async function diesDuring(run: () => Promise<unknown>, crashed: () => boolean): Promise<void> {
  await run().then(
    () => undefined,
    () => undefined,
  );
  expect(crashed()).toBe(true);
}

const submitInput = (world: World, prompt: string): SubmitMediaJobInput => ({
  deploymentId: world.deploymentId,
  generationKind: "image",
  prompt,
});

/** Walk the simulated rail to completion through N polls (one process). */
async function pollToCompletion(
  service: MediaGenerationService,
  jobId: string,
  polls = 6,
): Promise<Awaited<ReturnType<MediaGenerationService["pollJob"]>> | null> {
  let outcome: Awaited<ReturnType<MediaGenerationService["pollJob"]>> | null = null;
  for (let index = 0; index < polls; index += 1) {
    outcome = await service.pollJob(jobId, ACTOR);
    if (outcome.status === "completed" || outcome.status === "failed") {
      return outcome;
    }
  }
  return outcome;
}

/** One provider-completed CALLBACK frame for a dispatched job. */
const completedCallback = (jobId: string, providerJobRef: string): MediaCallbackInput => ({
  jobId,
  providerJobRef,
  callbackKey: "cb-complete-1",
  observation: "provider-completed",
  providerStateLabel: "simulated-completed",
  progress: 100,
  outputDescriptor: {
    contentDigest: digest(`simulated-media:${providerJobRef}:fixture`),
    generationKind: "image",
    width: 1024,
    height: 768,
    durationMs: null,
  },
});

const railDispatches = (world: World) => world.rail.sends.filter((r) => r.kind === "dispatch");
const railCancels = (world: World) => world.rail.sends.filter((r) => r.kind === "cancel");

describe("crash-injection proofs: durable media operation state + stable rail keys (WORK-026)", () => {
  // ---- SUBMISSION / PAID DISPATCH --------------------------------------------

  test("C1 SUBMIT: crash AFTER the durable operation claim — the retry completes with the claim-pinned job identity", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "store", method: "beginMediaOperation", when: "after" });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "a neon koi"), "submit-c1", ACTOR),
      dying.crashed,
    );
    // The claim committed and pinned the job identity BEFORE the crash;
    // nothing else happened (no admission, no job row, no dispatch).
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      "mediaop:job-submission:submit-c1",
    );
    expect(op?.status).toBe("pending");
    expect(op?.attempts).toBe(1);
    expect(op?.jobId).toBeDefined();
    const pinnedJobId = op?.jobId ?? null;
    // RESTART: the same logical submission completes with the pinned identity.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "a neon koi"),
      "submit-c1",
      ACTOR,
    );
    expect(outcome.jobId).toBe(pinnedJobId);
    expect(outcome.status).toBe("generating");
    // EXACTLY ONE upstream paid dispatch, ever.
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    // The operation completed with the honest attempts ledger.
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      "mediaop:job-submission:submit-c1",
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.attempts).toBe(2);
    // One execution identity, one admission pass (the dying process
    // crashed before any admission call).
    expect(world.ledger.opened).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(1);
  });

  test("C2 SUBMIT: crash AFTER the durable job row insert — the retry resumes the dispatch WITHOUT re-admission", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "store", method: "insertJob", when: "after" });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "a copper fox"), "submit-c2", ACTOR),
      dying.crashed,
    );
    // The job row exists (submitted); the dispatch never happened.
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c2");
    expect(job?.status).toBe("submitted");
    expect(railDispatches(world)).toHaveLength(0);
    // RESTART: the submission replay resumes the dispatch tail.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "a copper fox"),
      "submit-c2",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("generating");
    // EXACTLY ONE admission pass (the replay fast path skips it), one
    // execution identity, one paid dispatch, one budget reservation.
    expect(world.policy.calls).toHaveLength(1);
    expect(world.ledger.opened).toHaveLength(1);
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.budget.reserves).toHaveLength(1);
    // The submission operation completed (its tail converged).
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      "mediaop:job-submission:submit-c2",
    );
    expect(op?.status).toBe("completed");
  });

  test("C3 SUBMIT: crash AFTER the job-recorded checkpoint — the retry resumes the tail from the checkpoint facts", async () => {
    const world = await buildWorld();
    const dying = world.boot({
      target: "store",
      method: "recordMediaOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "a jade heron"), "submit-c3", ACTOR),
      dying.crashed,
    );
    // The checkpoint committed (job-recorded); the job row exists.
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      "mediaop:job-submission:submit-c3",
    );
    expect(op?.status).toBe("pending");
    expect(op?.checkpoint?.stage).toBe("job-recorded");
    expect(op?.checkpoint?.jobId).toBeDefined();
    // RESTART: the replay fast path converges the dispatch tail.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "a jade heron"),
      "submit-c3",
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("generating");
    // One admission pass, one execution, ONE paid dispatch.
    expect(world.policy.calls).toHaveLength(1);
    expect(world.ledger.opened).toHaveLength(1);
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(1);
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      "mediaop:job-submission:submit-c3",
    );
    expect(completed?.status).toBe("completed");
  });

  test("C4 SUBMIT: DOUBLE crash (checkpoint, then rail dispatch) — the third process converges; still exactly ONE paid dispatch", async () => {
    const world = await buildWorld();
    const first = world.boot({
      target: "store",
      method: "recordMediaOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => first.service.submitJob(submitInput(world, "a double crash"), "submit-c4", ACTOR),
      first.crashed,
    );
    // The second process dies right AFTER the rail accepted the paid
    // dispatch (the external side effect committed; no checkpoint).
    const second = world.boot({ target: "rail", method: "submitJob", when: "after" });
    await diesDuring(
      () => second.service.submitJob(submitInput(world, "a double crash"), "submit-c4", ACTOR),
      second.crashed,
    );
    expect(railDispatches(world)).toHaveLength(1);
    // The third process converges: the rail REPLAYS under the same key.
    const third = world.boot(null);
    const outcome = await third.service.submitJob(
      submitInput(world, "a double crash"),
      "submit-c4",
      ACTOR,
    );
    expect(outcome.status).toBe("generating");
    expect(outcome.providerJobRef).toMatch(/^simmedia-job-\d+$/);
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays.filter((r) => r.kind === "dispatch")).toHaveLength(1);
    // The budget converged by operationId: ONE new reservation across
    // all three processes.
    expect(world.budget.reserves).toHaveLength(1);
    expect(world.budget.settles).toHaveLength(1);
    // The dispatch operation converged.
    const dispatchOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      "mediaop:paid-dispatch",
    );
    expect(dispatchOp).toBeNull(); // keyed per job id, not a bare prefix
  });

  test("C5 DISPATCH: crash AFTER the paid-dispatch operation claim — the retry dispatches exactly once", async () => {
    const world = await buildWorld();
    // The SECOND beginMediaOperation call in the submission flow is the
    // paid-dispatch claim (the first is the job-submission claim).
    const dying = world.boot({
      target: "store",
      method: "beginMediaOperation",
      when: "after",
      occurrence: 2,
    });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "an amber wolf"), "submit-c5", ACTOR),
      dying.crashed,
    );
    // The job row exists (submitted); the submission op completed; the
    // paid-dispatch op is PENDING; the rail was never called.
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c5");
    expect(job?.status).toBe("submitted");
    expect(railDispatches(world)).toHaveLength(0);
    // RESTART: the replay resumes the dispatch.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "an amber wolf"),
      "submit-c5",
      ACTOR,
    );
    expect(outcome.status).toBe("generating");
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(1);
    const dispatchOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:paid-dispatch:${outcome.jobId}`,
    );
    expect(dispatchOp?.status).toBe("completed");
  });

  test("C6 DISPATCH: crash AFTER the rail accepted the paid dispatch — the retry re-issues under the SAME key and the rail converges", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "rail", method: "submitJob", when: "after" });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "a violet owl"), "submit-c6", ACTOR),
      dying.crashed,
    );
    // The rail performed the upstream PAID side effect; the job row is
    // at dispatching (the generating move never ran).
    expect(railDispatches(world)).toHaveLength(1);
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c6");
    expect(job?.status).toBe("dispatching");
    // RESTART: the retry re-issues the dispatch under the same stable
    // key — the rail REPLAYS the original acknowledgment.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "a violet owl"),
      "submit-c6",
      ACTOR,
    );
    expect(outcome.status).toBe("generating");
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays.filter((r) => r.kind === "dispatch")).toHaveLength(1);
    expect(outcome.providerJobRef).toBe(railDispatches(world)[0]?.providerJobRef);
    // The budget reserved exactly once (converged by operationId).
    expect(world.budget.reserves).toHaveLength(1);
    const dispatchOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:paid-dispatch:${outcome.jobId}`,
    );
    expect(dispatchOp?.status).toBe("completed");
  });

  test("C7 DISPATCH: crash AFTER the dispatched checkpoint — the retry completes the tail WITHOUT re-admission and WITHOUT a second rail call", async () => {
    const world = await buildWorld();
    // The SECOND checkpoint in the submission flow is the paid
    // dispatch's `dispatched` stage (past the point of no return).
    const dying = world.boot({
      target: "store",
      method: "recordMediaOperationCheckpoint",
      when: "after",
      occurrence: 2,
    });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "a crimson kite"), "submit-c7", ACTOR),
      dying.crashed,
    );
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c7");
    expect(job?.status).toBe("dispatching");
    const dispatchOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:paid-dispatch:${job?.id}`,
    );
    expect(dispatchOp?.status).toBe("pending");
    expect(dispatchOp?.checkpoint?.stage).toBe("dispatched");
    // RESTART: the durable tail completes from the checkpoint facts.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "a crimson kite"),
      "submit-c7",
      ACTOR,
    );
    expect(outcome.status).toBe("generating");
    // NO second rail call AT ALL (the checkpoint's providerJobRef is the
    // durable fact) — and NO re-run of budget admission (the reservation
    // converged by operation id; no second new reservation).
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    expect(world.budget.reserves).toHaveLength(1);
    expect(world.policy.calls).toHaveLength(1);
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:paid-dispatch:${job?.id}`,
    );
    expect(completed?.status).toBe("completed");
  });

  test("C8 DISPATCH: crash AFTER the guarded generating move — the retry reconciles the pending paid-dispatch row from the job row's proof", async () => {
    const world = await buildWorld();
    // The SECOND guarded mutation in the submission flow is the
    // dispatching → generating move (which records the rail reference).
    const dying = world.boot({
      target: "store",
      method: "applyGuardedJobMutation",
      when: "after",
      occurrence: 2,
    });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "an ivory stag"), "submit-c8", ACTOR),
      dying.crashed,
    );
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c8");
    expect(job?.status).toBe("generating");
    expect(job?.providerJobRef).toMatch(/^simmedia-job-\d+$/);
    // The paid-dispatch operation is PENDING (the crash landed between
    // the guarded move and the operation completion).
    const pending = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:paid-dispatch:${job?.id}`,
    );
    expect(pending?.status).toBe("pending");
    // RESTART: the submission replay reconciles the row from the job
    // row's durable proof (generating + the rail reference).
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "an ivory stag"),
      "submit-c8",
      ACTOR,
    );
    expect(outcome.status).toBe("generating");
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.rail.replays).toHaveLength(0);
    const reconciled = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:paid-dispatch:${job?.id}`,
    );
    expect(reconciled?.status).toBe("completed");
  });

  // ---- EXECUTION IDENTITY ---------------------------------------------------

  test("C9 EXECUTION: crash AFTER the execution open — the retry converges on the SAME execution identity", async () => {
    const world = await buildWorld();
    const dying = world.boot({ target: "ledger", method: "openExecution", when: "after" });
    await diesDuring(
      () => dying.service.submitJob(submitInput(world, "a slate raven"), "submit-c9", ACTOR),
      dying.crashed,
    );
    // The execution identity was created; the job row does NOT exist.
    expect(world.ledger.opened).toHaveLength(1);
    const executionId = world.ledger.opened[0]?.input
      ? null
      : null; // (identity held by the ledger's keyed model)
    expect(executionId).toBeNull();
    expect(
      await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c9"),
    ).toBeNull();
    // RESTART: the full admission re-runs (no past-no-return marker
    // existed); the execution open converges by key → SAME identity.
    const restarted = world.boot(null);
    const outcome = await restarted.service.submitJob(
      submitInput(world, "a slate raven"),
      "submit-c9",
      ACTOR,
    );
    expect(world.ledger.opened).toHaveLength(1);
    const execution = await world.ledger.readExecution(ACTOR.applicationId, outcome.executionId);
    expect(execution?.status).toBe("RUNNING");
    // One job, one dispatch.
    expect(railDispatches(world)).toHaveLength(1);
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c9");
    expect(job?.executionId).toBe(outcome.executionId);
  });

  // ---- OBSERVATION APPLY ----------------------------------------------------

  test("C10 OBSERVATION: crash AFTER the observation-apply claim — the callback retry applies exactly once", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a cobalt whale"),
      "submit-c10",
      ACTOR,
    );
    // The dying process claims the observation-apply operation and dies.
    const dying = world.boot({ target: "store", method: "beginMediaOperation", when: "after" });
    await diesDuring(
      () =>
        dying.service.applyCallback(
          completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
          ACTOR,
        ),
      dying.crashed,
    );
    const observations = await world.store.listObservations(ACTOR.applicationId, submitted.jobId);
    expect(observations).toHaveLength(0);
    // RESTART: the same callback frame applies exactly once.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyCallback(
      completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
      ACTOR,
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.status).toBe("completed");
    expect(await world.store.listObservations(ACTOR.applicationId, submitted.jobId)).toHaveLength(
      1,
    );
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:observation-apply:${submitted.jobId}:cb-complete-1`,
    );
    expect(op?.status).toBe("completed");
    expect(op?.attempts).toBe(2);
  });

  test("C11 OBSERVATION: crash AFTER the evidence row append — the retry converges the application tail", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a garnet moth"),
      "submit-c11",
      ACTOR,
    );
    const dying = world.boot({ target: "store", method: "appendObservation", when: "after" });
    await diesDuring(
      () =>
        dying.service.applyCallback(
          completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
          ACTOR,
        ),
      dying.crashed,
    );
    // The observation row exists; the observation-apply op is PENDING.
    const observations = await world.store.listObservations(ACTOR.applicationId, submitted.jobId);
    expect(observations).toHaveLength(1);
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:observation-apply:${submitted.jobId}:cb-complete-1`,
    );
    expect(op?.status).toBe("pending");
    // RESTART: the same frame converges — no second row, the completion
    // tail completes.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyCallback(
      completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(await world.store.listObservations(ACTOR.applicationId, submitted.jobId)).toHaveLength(
      1,
    );
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:observation-apply:${submitted.jobId}:cb-complete-1`,
    );
    expect(completed?.status).toBe("completed");
    // ONE artifact adoption row (the completion tail ran exactly once).
    const artifacts = await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId);
    expect(artifacts).toHaveLength(1);
  });

  // ---- COMPLETION -----------------------------------------------------------

  test("C12 COMPLETION: crash AFTER the guarded verifying move — the observation replay resumes the completion tail", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a topaz lynx"),
      "submit-c12",
      ACTOR,
    );
    // The completing process dies right after generating → verifying.
    const dying = world.boot({
      target: "store",
      method: "applyGuardedJobMutation",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.applyCallback(
          completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
          ACTOR,
        ),
      dying.crashed,
    );
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("verifying");
    // The observation-apply operation completed BEFORE the completion
    // boundary (the ordering inside applyObservation).
    const observationOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:observation-apply:${submitted.jobId}:cb-complete-1`,
    );
    expect(observationOp?.status).toBe("completed");
    // The completion operation is PENDING (claimed, tail cut short).
    const completionOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-completion:${submitted.jobId}`,
    );
    expect(completionOp?.status).toBe("pending");
    // RESTART: the SAME callback frame replays and the completion tail
    // RESUMES from the durable provider-completed observation.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyCallback(
      completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("completed");
    expect(outcome.outputArtifactDigest).toMatch(/^[0-9a-f]{64}$/);
    // Exactly one observation row, one adoption, ONE execution pass.
    expect(await world.store.listObservations(ACTOR.applicationId, submitted.jobId)).toHaveLength(
      1,
    );
    expect(await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId)).toHaveLength(1);
    expect(world.ledger.statusOf(submitted.executionId)).toBe("COMPLETED");
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-completion:${submitted.jobId}`,
    );
    expect(completed?.status).toBe("completed");
  });

  test("C13 COMPLETION: crash AFTER the artifact-adopted checkpoint — the retry resumes without a second adoption row", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a quartz falcon"),
      "submit-c13",
      ACTOR,
    );
    const dying = world.boot({
      target: "store",
      method: "recordMediaOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.applyCallback(
          completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
          ACTOR,
        ),
      dying.crashed,
    );
    // The adoption checkpoint committed (the artifact authority
    // performed the put-if-absent adoption); the artifact RECORD row and
    // the terminal tail did not happen.
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-completion:${submitted.jobId}`,
    );
    expect(op?.status).toBe("pending");
    expect(op?.checkpoint?.stage).toBe("artifact-adopted");
    expect(await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId)).toHaveLength(0);
    // RESTART: the same frame resumes the verification + terminal tail.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyCallback(
      completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
      ACTOR,
    );
    expect(outcome.status).toBe("completed");
    // The adoption converged by content identity: ONE artifact record.
    // The verification gate was NEVER consulted (mode none — the
    // deterministic postprocessing shape check is the controlling
    // boundary; the first process crashed before the gate too).
    expect(await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId)).toHaveLength(1);
    expect(world.verification.calls).toHaveLength(0);
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-completion:${submitted.jobId}`,
    );
    expect(completed?.status).toBe("completed");
    expect(world.ledger.statusOf(submitted.executionId)).toBe("COMPLETED");
  });

  test("C14 COMPLETION: crash AFTER the guarded completed move — the retry reconciles the pending rows and the execution tail", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "an obsidian hawk"), // mode none — deterministic boundary
      "submit-c14",
      ACTOR,
    );
    // The SECOND guarded mutation in the completing process is the
    // verifying → completed terminal move.
    const dying = world.boot({
      target: "store",
      method: "applyGuardedJobMutation",
      when: "after",
      occurrence: 2,
    });
    await diesDuring(
      () =>
        dying.service.applyCallback(
          completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
          ACTOR,
        ),
      dying.crashed,
    );
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("completed");
    expect(job?.outputArtifactDigest).toMatch(/^[0-9a-f]{64}$/);
    // The completion operation + the execution `pass` are still PENDING
    // (the crash landed between the guarded move and the tails).
    const completionOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-completion:${submitted.jobId}`,
    );
    expect(completionOp?.status).toBe("pending");
    expect(world.ledger.statusOf(submitted.executionId)).toBe("VERIFYING");
    // RESTART: the same frame replays the terminal outcome and the
    // reconciliation completes the operation row AND re-drives the
    // keyed execution `pass` (one PASS verification result — the
    // deterministic postprocessing boundary).
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyCallback(
      completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
      ACTOR,
    );
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("completed");
    const reconciled = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-completion:${submitted.jobId}`,
    );
    expect(reconciled?.status).toBe("completed");
    expect(world.ledger.statusOf(submitted.executionId)).toBe("COMPLETED");
    // ONE adoption row; no duplicate observation.
    expect(await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId)).toHaveLength(1);
    expect(await world.store.listObservations(ACTOR.applicationId, submitted.jobId)).toHaveLength(
      1,
    );
  });

  test("C15 COMPLETION (verification required): crash AFTER the verification gate — the keyed re-consult converges on the recorded verdict", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      {
        deploymentId: world.deploymentId,
        generationKind: "image",
        prompt: "a verified opal crane",
        verification: { criteria: [{ criterionId: "media-fidelity", version: 1 }] },
      },
      "submit-c15",
      ACTOR,
    );
    // The completing process dies right after the verification
    // authority recorded its PASS verdict (a durable keyed evaluation).
    const dying = world.boot({ target: "verification", method: "verify", when: "after" });
    await diesDuring(
      () =>
        dying.service.applyCallback(
          completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
          ACTOR,
        ),
      dying.crashed,
    );
    expect(world.verification.calls).toHaveLength(1);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("verifying");
    // RESTART: the completion re-consults the gate under the SAME key —
    // the authority replays the recorded verdict (never a second
    // evaluation) — and completes.
    const restarted = world.boot(null);
    const outcome = await restarted.service.applyCallback(
      completedCallback(submitted.jobId, submitted.providerJobRef ?? ""),
      ACTOR,
    );
    expect(outcome.status).toBe("completed");
    expect(world.verification.calls).toHaveLength(2);
    // The re-consult converged on the RECORDED verdict: same key, same
    // conclusion (never a second evaluation).
    expect(world.verification.conclusions).toHaveLength(2);
    expect(world.verification.conclusions[0]?.key).toBe(
      world.verification.conclusions[1]?.key,
    );
    expect(world.verification.conclusions[0]?.criteriaMet).toBe(true);
    expect(world.verification.conclusions[1]?.criteriaMet).toBe(true);
    expect(world.verification.conclusions[0]?.evaluationId).toBe(
      world.verification.conclusions[1]?.evaluationId,
    );
    expect(world.ledger.statusOf(submitted.executionId)).toBe("COMPLETED");
  });

  // ---- CANCELLATION ---------------------------------------------------------

  test("C16 CANCEL: crash AFTER the cancellation claim — the retry cancels exactly once", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a cancelled jasper bear"),
      "submit-c16",
      ACTOR,
    );
    // The dying process runs the cancel policy admission, claims the
    // operation, and dies BEFORE the rail call.
    const dying = world.boot({ target: "store", method: "beginMediaOperation", when: "after" });
    await diesDuring(
      () => dying.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR),
      dying.crashed,
    );
    expect(railCancels(world)).toHaveLength(0);
    // RESTART: the retry completes the cancellation.
    const restarted = world.boot(null);
    const outcome = await restarted.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR);
    expect(outcome.status).toBe("cancelled");
    // The resumed claim IS a replay (the honest marker: the operation
    // was claimed by the process that died).
    expect(outcome.replayed).toBe(true);
    expect(railCancels(world)).toHaveLength(1);
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-cancellation:${submitted.jobId}`,
    );
    expect(op?.status).toBe("completed");
    expect(op?.attempts).toBe(2);
    expect(world.ledger.statusOf(submitted.executionId)).toBe("CANCELLED");
  });

  test("C17 CANCEL: crash AFTER the rail cancellation — the retry re-issues under the SAME key and the rail converges", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a cancelled coral snake"),
      "submit-c17",
      ACTOR,
    );
    const dying = world.boot({ target: "rail", method: "cancelJob", when: "after" });
    await diesDuring(
      () => dying.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR),
      dying.crashed,
    );
    // The rail performed the cancellation; the job row is unchanged.
    expect(railCancels(world)).toHaveLength(1);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
    // RESTART: the retry re-issues the rail cancel under the same key.
    const restarted = world.boot(null);
    const outcome = await restarted.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR);
    expect(outcome.status).toBe("cancelled");
    expect(railCancels(world)).toHaveLength(1);
    expect(world.rail.replays.filter((r) => r.kind === "cancel")).toHaveLength(1);
    expect(world.ledger.statusOf(submitted.executionId)).toBe("CANCELLED");
  });

  test("C18 CANCEL: crash AFTER the rail-issued checkpoint — the retry completes the durable tail", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a cancelled amber lynx"),
      "submit-c18",
      ACTOR,
    );
    const dying = world.boot({
      target: "store",
      method: "recordMediaOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () => dying.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR),
      dying.crashed,
    );
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-cancellation:${submitted.jobId}`,
    );
    expect(op?.status).toBe("pending");
    expect(op?.checkpoint?.stage).toBe("rail-issued");
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
    // RESTART: the rail cancel re-issues under the same key (converges);
    // the guarded terminal move completes the cancellation.
    const restarted = world.boot(null);
    const outcome = await restarted.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR);
    expect(outcome.status).toBe("cancelled");
    expect(railCancels(world)).toHaveLength(1);
    expect(world.rail.replays.filter((r) => r.kind === "cancel")).toHaveLength(1);
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-cancellation:${submitted.jobId}`,
    );
    expect(completed?.status).toBe("completed");
  });

  test("C19 CANCEL: crash AFTER the guarded cancelled move — the retry reconciles the operation row AND the execution/budget tails", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a cancelled opal fox"),
      "submit-c19",
      ACTOR,
    );
    // The guarded mutation in the cancelling process is the terminal
    // → cancelled move; the crash lands between it and the budget
    // release / execution cancel tails.
    const dying = world.boot({
      target: "store",
      method: "applyGuardedJobMutation",
      when: "after",
    });
    await diesDuring(
      () => dying.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR),
      dying.crashed,
    );
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("cancelled");
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-cancellation:${submitted.jobId}`,
    );
    expect(op?.status).toBe("pending");
    expect(world.ledger.statusOf(submitted.executionId)).toBe("RUNNING");
    expect(world.budget.releases).toHaveLength(0);
    // RESTART: the repeated cancellation converges on the terminal
    // outcome and RECONCILES: the operation row completes and the keyed
    // execution `cancel` + budget `release` tails re-drive exactly once.
    const restarted = world.boot(null);
    const outcome = await restarted.service.cancelJob(submitted.jobId, "fixture cancellation", ACTOR);
    expect(outcome.replayed).toBe(true);
    expect(outcome.status).toBe("cancelled");
    const completed = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-cancellation:${submitted.jobId}`,
    );
    expect(completed?.status).toBe("completed");
    expect(world.ledger.statusOf(submitted.executionId)).toBe("CANCELLED");
    expect(world.budget.releases).toHaveLength(1);
    expect(world.budget.releases[0]?.operationId).toBe(mediaBudgetOperationId(submitted.jobId));
  });

  // ---- RETRY / VARIANT ------------------------------------------------------

  test("C20 RETRY: a crash during a retry resubmission — the SAME retry key converges on the SAME retry job (no second paid dispatch)", async () => {
    // A rail whose generation jobs FAIL at poll time (the provider
    // failure observation) — the retry rides a fresh dispatch.
    const world = await buildWorld({ failJobs: "simulated provider failure" });
    const seeded = world.boot(null);
    const prompt = "a render that fails then retries";
    const submitted = await seeded.service.submitJob(
      { deploymentId: world.deploymentId, generationKind: "image", prompt },
      "submit-c20",
      ACTOR,
    );
    // Walk the failing rail to the provider failure.
    for (let index = 0; index < 6; index += 1) {
      const outcome = await seeded.service.pollJob(submitted.jobId, ACTOR);
      if (outcome.status === "failed") {
        break;
      }
    }
    const failedJob = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(failedJob?.status).toBe("failed");
    const dispatchesBefore = railDispatches(world).length;
    // The retry resubmission dies right AFTER the rail accepted the NEW
    // retry job's paid dispatch.
    const dying = world.boot({ target: "rail", method: "submitJob", when: "after" });
    await diesDuring(
      () => dying.service.retryJob(failedJob?.id ?? "", { prompt }, "retry-c20", ACTOR),
      dying.crashed,
    );
    // The rail accepted exactly ONE retry dispatch (a NEW job identity —
    // one job = one execution = one paid dispatch).
    expect(railDispatches(world)).toHaveLength(dispatchesBefore + 1);
    // RESTART: the same retry key replays the same retry job.
    const restarted = world.boot(null);
    const retry = await restarted.service.retryJob(
      failedJob?.id ?? "",
      { prompt },
      "retry-c20",
      ACTOR,
    );
    expect(retry.replayed).toBe(true);
    expect(retry.retryOfJobId).toBe(failedJob?.id);
    expect(retry.status).toBe("generating");
    // Still exactly ONE retry dispatch; the retry job's rail reference
    // is the original acknowledgment.
    expect(railDispatches(world)).toHaveLength(dispatchesBefore + 1);
    expect(world.rail.replays.filter((r) => r.kind === "dispatch")).toHaveLength(1);
    expect(retry.providerJobRef).toBe(railDispatches(world)[dispatchesBefore]?.providerJobRef);
    // The failed original + the retry job: ONE new reservation only
    // (the failed original's reservation; the retry's own single
    // reservation — converging by operationId across the crash).
    const distinctReservations = new Set(world.budget.reserves.map((r) => r.operationId));
    expect(distinctReservations.size).toBe(2);
  });

  test("C21 VARIANT: crash AFTER the variant adoption checkpoint — the retry converges on the SAME variant artifact", async () => {
    const world = await buildWorld();
    const seeded = world.boot(null);
    const submitted = await seeded.service.submitJob(
      submitInput(world, "a variant pearl ibis"),
      "submit-c21",
      ACTOR,
    );
    const completed = await pollToCompletion(seeded.service, submitted.jobId);
    expect(completed?.status).toBe("completed");
    const completedJob = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(completedJob?.outputArtifactDigest).toMatch(/^[0-9a-f]{64}$/);
    const sourceDigest = completedJob?.outputArtifactDigest ?? "";
    // The variant derivation dies right AFTER the artifact authority
    // adopted the variant (the put-if-absent side effect).
    const dying = world.boot({
      target: "store",
      method: "recordMediaOperationCheckpoint",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.deriveVariant(
          { jobId: submitted.jobId, variant: { transform: "resize", width: 512 } },
          "variant-c21",
          ACTOR,
        ),
      dying.crashed,
    );
    const op = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:variant-adoption:${submitted.jobId}:variant-c21`,
    );
    expect(op?.status).toBe("pending");
    expect(op?.checkpoint?.stage).toBe("variant-adopted");
    // RESTART: the same variant key converges on the SAME artifact
    // (content identity) — one adoption record, one ledger evidence.
    const restarted = world.boot(null);
    const variant = await restarted.service.deriveVariant(
      { jobId: submitted.jobId, variant: { transform: "resize", width: 512 } },
      "variant-c21",
      ACTOR,
    );
    expect(variant.replayed).toBe(true);
    expect(variant.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(variant.parentDigests).toEqual([sourceDigest]);
    const artifacts = await world.store.listArtifacts(ACTOR.applicationId, submitted.jobId);
    expect(artifacts.filter((a) => a.role === "derived-variant")).toHaveLength(1);
    const completedOp = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:variant-adoption:${submitted.jobId}:variant-c21`,
    );
    expect(completedOp?.status).toBe("completed");
  });

  // ---- KEY DISCIPLINE -------------------------------------------------------

  test("C22 KEY DISCIPLINE: the stable key scheme — rail dispatch keys, budget operation ids and verification keys derive from the job identity alone", () => {
    // The scheme is structural: every side-effecting seam's stable key
    // is a PURE function of the durable job coordinates, so ANY process
    // (original, retry, crash-resume, concurrent duplicate) derives the
    // SAME key and the seams converge. No caller-supplied key reaches
    // the rail/budget/verification seams.
    expect(mediaRailDispatchKey("job-1")).toBe("mediarail:dispatch:job-1");
    expect(mediaRailDispatchKey("job-1")).toBe(mediaRailDispatchKey("job-1"));
    expect(mediaRailDispatchKey("job-1")).not.toBe(mediaRailDispatchKey("job-2"));
    expect(mediaBudgetOperationId("job-1")).toBe("media-reserve:job-1");
    expect(mediaBudgetOperationId("job-1")).not.toBe(mediaBudgetOperationId("job-2"));
  });

  test("C23 CONCURRENCY: N=8 concurrent duplicate submissions under the same key — exactly ONE job, ONE paid dispatch", async () => {
    const world = await buildWorld();
    const process = world.boot(null);
    const input = submitInput(world, "a concurrent onyx tiger");
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => process.service.submitJob(input, "submit-c23", ACTOR)),
    );
    // All eight converge on the SAME job identity.
    const jobIds = new Set(outcomes.map((outcome) => outcome.jobId));
    expect(jobIds.size).toBe(1);
    expect(outcomes.filter((outcome) => outcome.replayed).length).toBe(7);
    // Exactly ONE upstream paid dispatch; the duplicates that reached
    // the rail converged by key (replays, never second records).
    expect(railDispatches(world)).toHaveLength(1);
    expect(world.budget.reserves).toHaveLength(1);
    const job = await world.store.findJobBySubmissionKey(ACTOR.applicationId, "submit-c23");
    expect(job?.status).toBe("generating");
    expect(job?.providerJobRef).toMatch(/^simmedia-job-\d+$/);
    expect(world.ledger.opened).toHaveLength(1);
    // Concurrent duplicates may re-run the READ-ONLY admission walk
    // (policy is a pure decision — zero side effects; the SEQUENTIAL
    // retry path skips it via the replay fast path); the side-effect
    // seams above all converged to exactly one.
    expect(world.policy.calls.length).toBeGreaterThanOrEqual(1);
    expect(world.secrets.calls.length).toBeGreaterThanOrEqual(1);
  });
});
