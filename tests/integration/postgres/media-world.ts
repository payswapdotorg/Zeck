/**
 * Shared real-PostgreSQL fixture for the media-generation suites
 * (WORK-026).
 *
 * Extends the WORK-023 deployment-fabric world with the WORK-026 media
 * fabric over the provider-neutral DatabasePort:
 *
 *   * media jobs/observations/artifact adoptions/operations:
 *     SqlMediaStore (migration 0021);
 *   * provenance: the REAL media execution-ledger adapter over the
 *     REAL executions service (media-mapped executions are created and
 *     lifecycle-walked RUNNING → VERIFYING → COMPLETED/FAILED/CANCELLED
 *     through the executions PUBLIC surface, and every submission/
 *     dispatch/observation/adoption/cancellation rides the real
 *     EventEnvelope ledger);
 *   * policy admission: the REAL policies engine (WORK-007) through the
 *     deployments module's policy-media adapter, with a default
 *     platform-allow document (and a deny toggle for the denial proofs);
 *   * budget admission: the REAL budgets service (WORK-004 —
 *     SqlBudgetStore + SqlBudgetsIdempotency, a developer-funded wallet
 *     with granted credits) through the budget-media adapter — the
 *     budget-before-paid-dispatch boundary is PHYSICAL in PostgreSQL
 *     (wallet debits, reservation rows, convergence by operationId);
 *   * verification: the REAL verification service (WORK-013 —
 *     SqlVerificationStore, the deterministic evaluator bank, the
 *     artifact target resolver over the REAL artifacts service) through
 *     the verification-media gate, with declared invariant criteria;
 *   * artifacts: the REAL artifacts service (content-addressed,
 *     lineage-bearing) through the media-artifact-authority adapter;
 *   * the upstream rail: the in-process simulated media rail (the
 *     provider-honesty stance — no external media-provider credentials
 *     exist in this environment; external behavior is UNVERIFIED and
 *     recorded as such in docs/work-items/WORK-026.md);
 *   * capability/secret seams: recording fakes (their PG behavior is
 *     owned by their own modules' suites; the durable-state proofs
 *     here need only deterministic toggles).
 */

import { createHash } from "node:crypto";
import { createInMemoryArtifactStore } from "../../../src/modules/artifacts/adapters/in-memory-artifact-store";
import { createNodeDigestPort } from "../../../src/modules/artifacts/adapters/node-digest";
import { type ArtifactService, createArtifactService } from "../../../src/modules/artifacts/public";
import {
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../../../src/modules/budgets/adapters/sql-budget-store";
import {
  type BudgetService,
  createBudgetService,
} from "../../../src/modules/budgets/application/budget-service";
import type {
  DeploymentPlanInput,
  DeploymentProfileInput,
  MediaActor,
  MediaBudgetReserveCommand,
  MediaCapabilityAdmissionRequest,
  MediaGenerationService,
  MediaSecretMediationRequest,
} from "../../../src/modules/deployments/public";
import {
  createBudgetMediaAdmission,
  createDeploymentService,
  createInProcessMediaRail,
  createMediaArtifactAuthorityAdapter,
  createMediaExecutionLedgerAdapter,
  createMediaGenerationService,
  createMediaModalityAdapter,
  createModalityAdapterRegistry,
  createPolicyMediaAdmission,
  createSqlEnvironmentResolver,
  createVerificationMediaGate,
  SqlMediaStore,
} from "../../../src/modules/deployments/public";
import { createPolicyAuthority, type PolicyAuthority } from "../../../src/modules/policies/public";
import { createDeterministicEvaluatorBank } from "../../../src/modules/verification/adapters/deterministic-evaluators";
import {
  createExecutionLedgerAdapter,
  createExecutionTransitionAdapter,
} from "../../../src/modules/verification/adapters/execution-ledger";
import { createPolicyVerificationAdmission } from "../../../src/modules/verification/adapters/policy-verification-admission";
import { SqlVerificationStore } from "../../../src/modules/verification/adapters/sql-verification-store";
import {
  createArtifactTargetResolver,
  createPlanRevisionResolver,
} from "../../../src/modules/verification/adapters/target-resolvers";
import {
  createVerificationService,
  type VerificationService,
} from "../../../src/modules/verification/application/verification-service";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type DeploymentPgWorld, seedDeploymentWorld } from "./deployments-world";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** The neutral media-generation profile body (the media modality). */
export const MEDIA_PROFILE_BODY: DeploymentProfileInput = {
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

export function mediaPlanBody(world: {
  readonly environmentId: string;
  readonly agentId: string;
}): DeploymentPlanInput {
  return {
    planId: "brand-media-plan",
    profileRef: { profileId: "brand-media", version: 1 },
    agentRef: { agentId: world.agentId, agentVersion: "1.0.0", agentKind: "zeck" },
    environmentId: world.environmentId,
    channelBindings: [
      { channelKind: "web", adapterCapabilityId: "simulated-media-rail" },
      { channelKind: "webhook", adapterCapabilityId: "simulated-media-rail" },
    ],
    sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
  };
}

/** Recording fakes for the capability + secret admission seams. */
class MediaAdmissions {
  readonly capabilityCalls: MediaCapabilityAdmissionRequest[] = [];
  readonly reserves: MediaBudgetReserveCommand[] = [];
  readonly releases: Array<Record<string, unknown>> = [];
  readonly settles: Array<Record<string, unknown>> = [];
  readonly mediationCalls: MediaSecretMediationRequest[] = [];
  unmetCapabilities: string[] = [];
  refuseMediation = false;

  readonly capabilities = {
    resolve: async (request: MediaCapabilityAdmissionRequest) => {
      this.capabilityCalls.push(request);
      return { satisfied: this.unmetCapabilities.length === 0, unmet: this.unmetCapabilities };
    },
  };

  readonly secrets = {
    mediate: async (request: MediaSecretMediationRequest) => {
      this.mediationCalls.push(request);
      return this.refuseMediation
        ? { mediated: false as const, reason: "fixture connection inactive" }
        : { mediated: true as const, grantRef: "mediated:conn-media-1" };
    },
  };
}

export interface MediaPgWorld {
  readonly db: DatabasePort;
  readonly base: DeploymentPgWorld;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly mediaStore: SqlMediaStore;
  readonly service: MediaGenerationService;
  readonly rail: ReturnType<typeof createInProcessMediaRail>;
  readonly admissions: MediaAdmissions;
  /** The REAL policies authority behind the policy admission seam. */
  readonly policyAuthority: PolicyAuthority;
  /** The REAL budgets service behind the budget admission seam. */
  readonly budgetService: BudgetService;
  /** The REAL verification service behind the verification gate. */
  readonly verificationService: VerificationService;
  /** The REAL artifacts service behind the artifact authority seam. */
  readonly artifacts: ArtifactService;
  readonly actor: () => MediaActor;
  /**
   * Boot (or re-boot) the media generation service over the SURVIVING
   * world — the process-restart primitive for the crash-injection
   * proofs: the PG store, the executions ledger (PG), the budgets
   * service (PG), the verification service (PG), the upstream rail
   * (the external provider's idempotency-key ledger) and the admission
   * seams persist across a Zeck process death; a `point` arms ONE
   * durable-boundary crash (a method on store/rail/ledger, before/
   * after its durable commit) that kills the booted process mid-flight.
   */
  readonly boot: (point?: CrashInjectionPoint | null) => {
    readonly service: MediaGenerationService;
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

/** The invariant criteria the media verification proofs declare. */
export const MEDIA_CRITERIA = {
  /** PASSes for image-kind outputs (the happy-path gate). */
  passing: {
    criterionId: "media-kind-image",
    version: 1,
    kind: "invariant",
    required: true,
    description: "the generated output's kind is image",
    definition: { assertions: [{ path: "generationKind", op: "eq", value: "image" }] },
  },
  /** FAILs for image-kind outputs (the rejection proof). */
  rejecting: {
    criterionId: "media-kind-audio",
    version: 1,
    kind: "invariant",
    required: true,
    description: "the generated output's kind is audio",
    definition: { assertions: [{ path: "generationKind", op: "eq", value: "audio" }] },
  },
} as const;

export async function seedMediaWorld(db: DatabasePort): Promise<MediaPgWorld> {
  const base = await seedDeploymentWorld(db);
  const actor = base.actor();
  const newId = createUuidv7Generator();
  const now = () => new Date();

  // The media-fabric deployment service over the SAME SQL store with
  // the media modality adapter bridge registered.
  const rail = createInProcessMediaRail(["video", "image", "audio", "multimodal"], {
    now,
    contentDigest: (providerJobRef, specDigest) =>
      sha256Hex(`simulated-media:${providerJobRef}:${specDigest}`),
  });
  const adapters = createModalityAdapterRegistry();
  adapters.register(createMediaModalityAdapter(rail));
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
    digest: sha256Hex,
    generateId: newId,
    now,
  });

  // Profile + plan v1/v2 + the deployment (active, pinned at v1).
  await deploymentService.publishProfile({ ...MEDIA_PROFILE_BODY }, { version: 1 }, actor);
  await deploymentService.publishPlan(mediaPlanBody(base), { version: 1 }, actor);
  await deploymentService.publishPlan(
    {
      ...mediaPlanBody(base),
      sessionPolicy: { maxSessionDurationMs: 1_800_000, maxConcurrentSessions: 32 },
    },
    { version: 2 },
    actor,
  );
  const created = await deploymentService.createDeployment(
    {
      slug: "brand-media-prod",
      name: "Brand media (production)",
      environmentId: base.environmentId,
      agentId: base.agentId,
      agentVersion: base.agentVersion,
      agentKind: "zeck",
      planId: "brand-media-plan",
    },
    "media-create-deployment",
    actor,
  );

  // The REAL policies engine for the media admission seam (default
  // platform-allow; the deny path publishes a restriction document).
  const policiesPublic = await import("../../../src/modules/policies/public");
  const policyAuthority = createPolicyAuthority({
    store: new policiesPublic.InMemoryPolicyStore(),
    hasher: policiesPublic.nodePolicyHasher,
  });
  await policyAuthority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // The REAL budgets service for the budget admission seam (a
  // developer-funded wallet with granted credits — the paid-dispatch
  // boundary is PHYSICAL: wallet debits + reservation rows in PG).
  const budgetService = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), newId),
    generateId: newId,
    now,
  });
  const budgetScope = {
    actorId: actor.actorId,
    applicationId: base.applicationId,
    tenantId: base.tenantId,
  };
  await budgetService.configureFundingMode(
    { ...budgetScope, fundingMode: "developer" },
    "media-cfg-funding",
  );
  await budgetService.grantCredits(
    { ...budgetScope, ownerKind: "developer", amountMicroUsd: "50000000" },
    "media-grant-credits",
  );

  // The REAL artifacts service (content-addressed, lineage-bearing).
  const artifacts = createArtifactService({
    store: createInMemoryArtifactStore(),
    digest: createNodeDigestPort(),
  });

  // The REAL verification service behind the media gate, with the
  // declared invariant criteria for the media proofs.
  const verificationService = createVerificationService({
    store: new SqlVerificationStore(db),
    admission: createPolicyVerificationAdmission(policyAuthority),
    ledger: createExecutionLedgerAdapter(base.executionService),
    transitions: createExecutionTransitionAdapter(base.executionService),
    replanning: {
      onVerificationOutcome: async () => ({ decision: "replan", detail: "fixture" }),
    },
    evaluators: [...createDeterministicEvaluatorBank()],
    resolvers: {
      artifact: createArtifactTargetResolver(artifacts),
      "plan-revision": createPlanRevisionResolver(base.executionService),
    },
    generateId: newId,
    now,
    hashInput: (text) => createNodeDigestPort().sha256Hex(`verification:${text}`),
  });
  await verificationService.declareCriteria({
    applicationId: base.applicationId,
    tenantId: base.tenantId,
    criteria: MEDIA_CRITERIA.passing,
  });
  await verificationService.declareCriteria({
    applicationId: base.applicationId,
    tenantId: base.tenantId,
    criteria: MEDIA_CRITERIA.rejecting,
  });

  const admissions = new MediaAdmissions();
  const mediaStore = new SqlMediaStore(db, sha256Hex);
  const ledger = createMediaExecutionLedgerAdapter(base.executionService);
  const railConnectionRef = "connections:simulated-media-rail";
  const budgetAdmission = createBudgetMediaAdmission(budgetService);
  const verificationGate = createVerificationMediaGate(verificationService);
  const artifactAuthority = createMediaArtifactAuthorityAdapter(artifacts);
  const policyAdmission = createPolicyMediaAdmission(policyAuthority);

  const boot = (point: CrashInjectionPoint | null = null) => {
    const storeProcess = crashableSeam(mediaStore, "store", point);
    const railProcess = crashableSeam(rail, "rail", point);
    const ledgerProcess = crashableSeam(ledger, "ledger", point);
    const service = createMediaGenerationService({
      store: storeProcess.proxy,
      deployments: base.deploymentStore,
      rail: railProcess.proxy,
      policy: policyAdmission,
      capabilities: admissions.capabilities,
      budget: budgetAdmission,
      secrets: admissions.secrets,
      ledger: ledgerProcess.proxy,
      artifacts: artifactAuthority,
      verification: verificationGate,
      railConnectionRef,
      digest: sha256Hex,
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
    mediaStore,
    service: boot().service,
    rail,
    admissions,
    policyAuthority,
    budgetService,
    verificationService,
    artifacts,
    actor: () => ({
      actorId: base.actor().actorId,
      applicationId: base.applicationId,
      tenantId: base.tenantId,
    }),
    boot,
  };
}

/** Submit one media job on the world's deployment (v1 pin). */
export async function submitMediaJob(
  world: MediaPgWorld,
  suffix: string,
  overrides: {
    readonly generationKind?: "video" | "image" | "audio" | "multimodal";
    readonly verification?: {
      readonly criteria: readonly { criterionId: string; version: number }[];
    };
  } = {},
): Promise<ReturnType<MediaGenerationService["submitJob"]>> {
  return world.service.submitJob(
    {
      deploymentId: world.deploymentId,
      generationKind: overrides.generationKind ?? "image",
      prompt: `a fixture render ${suffix}`,
      ...(overrides.verification === undefined ? {} : { verification: overrides.verification }),
    },
    `submit-${suffix}`,
    world.actor(),
  );
}

/**
 * Walk the simulated rail to completion through polls (the provider's
 * deterministic stage progression: accepted → 25% → 60% → completed).
 */
export async function pollToCompletion(
  service: MediaGenerationService,
  jobId: string,
  actor: MediaActor,
  polls = 6,
): Promise<Awaited<ReturnType<MediaGenerationService["pollJob"]>> | null> {
  let outcome: Awaited<ReturnType<MediaGenerationService["pollJob"]>> | null = null;
  for (let index = 0; index < polls; index += 1) {
    outcome = await service.pollJob(jobId, actor);
    if (outcome.status === "completed" || outcome.status === "failed") {
      return outcome;
    }
  }
  return outcome;
}

/**
 * One provider-completed CALLBACK frame for a dispatched job (the
 * inbound-transport path; the descriptor's content digest matches the
 * rail's deterministic output digest).
 */
export function completedCallbackFor(
  jobId: string,
  providerJobRef: string,
  callbackKey = "cb-complete",
): {
  readonly jobId: string;
  readonly providerJobRef: string;
  readonly callbackKey: string;
  readonly observation: "provider-completed";
  readonly providerStateLabel: string;
  readonly progress: number;
  readonly outputDescriptor: Readonly<Record<string, unknown>>;
} {
  return {
    jobId,
    providerJobRef,
    callbackKey,
    observation: "provider-completed",
    providerStateLabel: "simulated-completed",
    progress: 100,
    outputDescriptor: {
      contentDigest: sha256Hex(`simulated-media:${providerJobRef}:fixture-callback`),
      generationKind: "image",
      width: 1024,
      height: 768,
      durationMs: null,
    },
  };
}
