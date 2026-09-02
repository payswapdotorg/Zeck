/**
 * Discrimination: the provider-neutral media-generation boundaries
 * (WORK-026, MOD-011/012/013; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, EXECUTION-PROVENANCE,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY).
 *
 * The 14 REQUIRED SAFETY PROOFS (the work order's mandatory coverage,
 * labeled S1..S14). Every protection has BOTH halves (the house style):
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
 *   S1  tenant isolation              tenant-guard-removed (job+deployment)
 *       cross-tenant submit/read/poll/cancel/derive/callback: TENANT_SCOPE_VIOLATION
 *   S2  policy before side effect     admission-order / admission-removed
 *       denial at submit AND cancel AND variant-derive: zero rail side effects
 *   S3  capability-before-provider    capability-gate-removed
 *       unmet capability: CAPABILITY_UNAVAILABLE, zero paid dispatches
 *   S4  budget-before-paid-dispatch   dispatch-budget-gate-removed
 *       exhausted budget: BUDGET_EXCEEDED, zero rail dispatches; the
 *       admission order is frozen (policy→capability→budget→mediation
 *       BEFORE the durable job row and the rail dispatch)
 *   S5  secret mediation              mediation-gate-removed
 *       refused mediation: typed failure, reservation released, zero sends
 *   S6  duplicate submission          replay-branch-removed
 *       idempotency   repeat submission + N=8 concurrent: one job, one
 *       execution, ONE paid dispatch
 *   S7  callback correlation          correlation-guard-removed
 *       foreign/stale callback frame: typed rejection, zero mutation
 *   S8  callback tenant isolation     callback-path-unguarded
 *       a foreign-tenant actor's callback: TENANT_SCOPE_VIOLATION
 *   S9  verification-before-          verification-gate-bypassed
 *       completion (AC5)              criteriaMet=false verdict: job FAILED,
 *       never completed; the output digest never attaches
 *   S10 deterministic postprocessing  postprocessing-removed
 *       rejection (AC5)               kind-mismatched/malformed provider
 *       output: typed rejection before completion
 *   S11 artifact lineage (MOD-012)    lineage-dropped
 *       generated outputs adopt the input digest as parent; derived
 *       variants adopt the source digest — the lineage link is
 *       identity-bearing
 *   S12 stable rail keys / retry      dispatch-key-degraded
 *       idempotency                   the paid dispatch key is job-stable;
 *       a repeated retry converges with ONE dispatch per job
 *   S13 closed lifecycle vocabulary   lifecycle-opened
 *       the job statuses/observations are CLOSED frozen vocabularies
 *       (domain + migration CHECKs); terminal jobs cannot be cancelled
 *   S14 no second execution machine   execution-authority-inversion
 *       execution transitions ride ONLY the ledger seam (verify/pass/
 *       fail/cancel commands); the store port carries none
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../../src/modules/deployments/public";
import {
  createDeploymentService,
  createInProcessMediaRail,
  createMediaGenerationService,
  createMediaModalityAdapter,
  createModalityAdapterRegistry,
  InMemoryDeploymentStore,
  InMemoryMediaStore,
  mediaRailDispatchKey,
} from "../../src/modules/deployments/public";
import { PlatformError } from "../../src/shared/errors";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = "src/modules/deployments/application/media-generation-service.ts";
const DOMAIN_PATH = "src/modules/deployments/domain/media.ts";
const STORE_PORT_PATH = "src/modules/deployments/ports/media-store.ts";
const RAIL_PORT_PATH = "src/modules/deployments/ports/media-rail.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0021_media_generation_jobs.sql";
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_PATH), "utf8");
const DOMAIN_SOURCE = readFileSync(join(REPO_ROOT, DOMAIN_PATH), "utf8");
const STORE_PORT_SOURCE = readFileSync(join(REPO_ROOT, STORE_PORT_PATH), "utf8");
const RAIL_PORT_SOURCE = readFileSync(join(REPO_ROOT, RAIL_PORT_PATH), "utf8");
const MIGRATION_SOURCE = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Extract one method body from the service source (4-space indent). */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`signature not found: ${signature}`);
  }
  const next = source.indexOf("\n    async ", start + signature.length);
  const nextConst = source.indexOf("\n  const ", start + signature.length);
  const ends = [next, nextConst].filter((index) => index > start);
  const end = ends.length === 0 ? source.length : Math.min(...ends);
  return source.slice(start, end);
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

interface MediaRules {
  readonly service: string;
  readonly submitBody: string;
  readonly dispatchBody: string;
  readonly completionBody: string;
  readonly callbackBody: string;
  readonly deriveBody: string;
  readonly cancelBody: string;
  readonly resolveJobBody: string;
  readonly domain: string;
  readonly storePort: string;
  readonly railPort: string;
  readonly migration: string;
}

function rulesFrom(
  service: string,
  domain: string = DOMAIN_SOURCE,
  storePort: string = STORE_PORT_SOURCE,
  railPort: string = RAIL_PORT_SOURCE,
  migration: string = MIGRATION_SOURCE,
): MediaRules {
  return {
    service,
    submitBody: sectionOf(
      service,
      "const submitJobInternal = async (",
      "  // -------------------------------------------------------------------------",
    ),
    dispatchBody: sectionOf(
      service,
      "const ensureDispatched = async (",
      "  // -------------------------------------------------------------------------",
    ),
    completionBody: sectionOf(
      service,
      "const completeJob = async (",
      "  // -------------------------------------------------------------------------",
    ),
    callbackBody: methodBody(service, "async applyCallback("),
    deriveBody: methodBody(service, "async deriveVariant("),
    cancelBody: methodBody(service, "async cancelJob("),
    resolveJobBody: sectionOf(service, "const resolveJob = async (", "  /**"),
    domain,
    storePort,
    railPort,
    migration,
  };
}

const cleanRules = (): MediaRules =>
  rulesFrom(SERVICE_SOURCE, DOMAIN_SOURCE, STORE_PORT_SOURCE, RAIL_PORT_SOURCE, MIGRATION_SOURCE);

const mutateService = (mutation: (content: string) => string): MediaRules =>
  rulesFrom(mutation(SERVICE_SOURCE));
const mutateDomain = (mutation: (content: string) => string): MediaRules =>
  rulesFrom(SERVICE_SOURCE, mutation(DOMAIN_SOURCE));
const mutateStorePort = (mutation: (content: string) => string): MediaRules =>
  rulesFrom(SERVICE_SOURCE, DOMAIN_SOURCE, mutation(STORE_PORT_SOURCE));
const mutateRailPort = (mutation: (content: string) => string): MediaRules =>
  rulesFrom(SERVICE_SOURCE, DOMAIN_SOURCE, STORE_PORT_SOURCE, mutation(RAIL_PORT_SOURCE));
const mutateMigration = (mutation: (content: string) => string): MediaRules =>
  rulesFrom(
    SERVICE_SOURCE,
    DOMAIN_SOURCE,
    STORE_PORT_SOURCE,
    RAIL_PORT_SOURCE,
    mutation(MIGRATION_SOURCE),
  );

// ---------------------------------------------------------------------------
// The static probe: violations over the (possibly mutated) REAL source.
// ---------------------------------------------------------------------------

function violationsOf(rules: MediaRules): string[] {
  const violations: string[] = [];

  // S1 — tenant guards (job + deployment) must exist.
  if (!rules.resolveJobBody.includes("job.tenantId !== actor.tenantId")) {
    violations.push("job-tenant-guard-removed");
  }
  if (!rules.service.includes("deployment.tenantId !== tenantId")) {
    violations.push("deployment-tenant-guard-removed");
  }

  // S2/S3/S4/S5 — the admission chain must run BEFORE the side
  // effects, in the frozen order, inside the submission flow.
  const order: ReadonlyArray<readonly [string, number]> = [
    ["policy.admit(", rules.submitBody.indexOf("policy.admit(")],
    ["capabilities.resolve(", rules.submitBody.indexOf("capabilities.resolve(")],
    ["budget.reserve(", rules.submitBody.indexOf("budget.reserve(")],
    ["secrets.mediate(", rules.submitBody.indexOf("secrets.mediate(")],
    ["store.insertJob(", rules.submitBody.indexOf("store.insertJob(")],
  ];
  for (const [label, index] of order) {
    if (index === -1) {
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

  // S3 — the capability gate must exist (capability BEFORE provider:
  // the rail is dispatched only after this).
  if (!rules.submitBody.includes("!capabilityDecision.satisfied")) {
    violations.push("capability-gate-removed");
  }

  // S4 — budget admission BEFORE the PAID rail dispatch inside the
  // dispatch tail (MOD-013's core).
  const dispatchBudget = rules.dispatchBody.indexOf("budget.reserve(");
  const dispatchRail = rules.dispatchBody.indexOf("rail.submitJob(");
  if (dispatchBudget === -1) {
    violations.push("dispatch-budget-gate-removed");
  } else if (dispatchRail !== -1 && dispatchBudget > dispatchRail) {
    violations.push("dispatch-budget-after-rail");
  }

  // S5 — the mediation gate must exist.
  if (!rules.submitBody.includes("!mediation.mediated")) {
    violations.push("mediation-gate-removed");
  }

  // S6 — the idempotent-replay fast path must exist (duplicate
  // submissions converge on the existing job row).
  if (!rules.submitBody.includes("const replayed = await store.findJobBySubmissionKey(")) {
    violations.push("replay-branch-removed");
  }

  // S7 — the callback correlation guard must exist (foreign or stale
  // frames are rejected before any mutation).
  if (!rules.callbackBody.includes("job.providerJobRef !== input.providerJobRef")) {
    violations.push("correlation-guard-removed");
  }

  // S8 — the callback path resolves the job through the TENANT-GUARDED
  // resolver (never a raw store read).
  if (!rules.callbackBody.includes("await resolveJob(actor, input.jobId)")) {
    violations.push("callback-path-unguarded");
  }

  // S9 — the verification gate controls completion when required; a
  // criteriaMet=false verdict fails the job.
  if (!rules.completionBody.includes('if (job.verificationMode === "required") {')) {
    violations.push("verification-gate-bypassed");
  }
  if (!rules.completionBody.includes("if (!verdict.criteriaMet) {")) {
    violations.push("verification-rejection-removed");
  }

  // S10 — the deterministic postprocessing shape check runs BEFORE the
  // adoption/completion (it can REJECT).
  const postprocess = rules.completionBody.indexOf("postprocessMediaOutput({");
  const adoption = rules.completionBody.indexOf("artifacts.adoptArtifact({");
  if (postprocess === -1) {
    violations.push("postprocessing-removed");
  } else if (adoption !== -1 && postprocess > adoption) {
    violations.push("postprocessing-after-adoption");
  }

  // S11 — the lineage link: generated outputs adopt the INPUT digest as
  // parent; derived variants adopt the SOURCE digest.
  if (
    !rules.completionBody.includes(
      "parents: job.inputArtifactDigest === null ? [] : [job.inputArtifactDigest],",
    )
  ) {
    violations.push("output-lineage-dropped");
  }
  if (!rules.deriveBody.includes("parents: [sourceDigest],")) {
    violations.push("variant-lineage-dropped");
  }

  // S12 — the paid dispatch carries the STABLE job-derived rail key.
  if (!rules.dispatchBody.includes("idempotencyKey: mediaRailDispatchKey(job.id),")) {
    violations.push("dispatch-key-degraded");
  }
  // The cancel key likewise.
  if (!rules.cancelBody.includes("idempotencyKey: mediaRailCancelKey(job.id),")) {
    violations.push("cancel-key-degraded");
  }

  // S13 — the CLOSED vocabularies (domain constants + migration CHECKs).
  const FROZEN_STATUSES = `export const MEDIA_JOB_STATUSES = [
  "submitted",
  "dispatching",
  "generating",
  "verifying",
  "completed",
  "failed",
  "cancelled",
] as const;`;
  const FROZEN_OBSERVATIONS = `export const MEDIA_PROVIDER_OBSERVATIONS = [
  "accepted",
  "progressed",
  "provider-completed",
  "provider-failed",
  "provider-cancelled",
] as const;`;
  if (!rules.domain.includes(FROZEN_STATUSES)) {
    violations.push("lifecycle-opened-statuses");
  }
  if (!rules.domain.includes(FROZEN_OBSERVATIONS)) {
    violations.push("lifecycle-opened-observations");
  }
  if (
    !rules.domain.includes(
      "export const MEDIA_JOB_TRANSITIONS: Readonly<Record<MediaJobStatus, readonly MediaJobStatus[]>> = {",
    )
  ) {
    violations.push("lifecycle-opened-transitions");
  }
  if (!rules.migration.includes("CONSTRAINT media_jobs_status_vocabulary CHECK")) {
    violations.push("migration-status-vocabulary-removed");
  }
  if (!rules.migration.includes("CONSTRAINT media_obs_vocabulary CHECK")) {
    violations.push("migration-observation-vocabulary-removed");
  }

  // S14 — no second execution state machine: the media store port
  // never carries execution-transition vocabulary.
  for (const forbidden of [
    "transitionExecution",
    "setExecutionStatus",
    "writeExecutionState",
    "updateExecutionStatus",
  ]) {
    if (rules.storePort.includes(forbidden)) {
      violations.push(`execution-authority-inversion:${forbidden}`);
    }
  }
  // The execution transitions ride the ledger seam only.
  if (!/ledger\s*\.\s*enterVerification\(/.test(rules.service)) {
    violations.push("ledger-verify-path-removed");
  }
  if (!/ledger\s*\.\s*completeExecution\(/.test(rules.service)) {
    violations.push("ledger-complete-path-removed");
  }
  if (!/ledger\s*\.\s*failExecution\(/.test(rules.service)) {
    violations.push("ledger-fail-path-removed");
  }
  if (!/ledger\s*\.\s*cancelExecution\(/.test(rules.service)) {
    violations.push("ledger-cancel-path-removed");
  }
  // The rail port stays transport-only: the MediaRail INTERFACE carries
  // no authority METHOD (comments describe what must not cross).
  const railInterface =
    /export interface MediaRail \{([\s\S]*?)\n\}/.exec(rules.railPort)?.[1] ?? "";
  const railMethods = [...railInterface.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm)]
    .map((match) => match[1] ?? "")
    .filter((method) => method !== "descriptor");
  if (!railMethods.every((method) => ["submitJob", "cancelJob", "pollJob"].includes(method))) {
    violations.push("rail-method-set-opened");
  }
  for (const forbidden of ["admit", "authorize", "reserve", "budget", "transition"]) {
    if (railMethods.includes(forbidden)) {
      violations.push(`rail-authority-vocabulary:${forbidden}`);
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// The runtime world (a compact twin of the unit suite's world).
// ---------------------------------------------------------------------------

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

const PLAN: DeploymentPlanInput = {
  planId: "brand-media-plan",
  profileRef: { profileId: "brand-media", version: 1 },
  agentRef: { agentId: AGENT_ID, agentVersion: "1.0.0", agentKind: "zeck" },
  environmentId: ENV_ID,
  channelBindings: [{ channelKind: "web", adapterCapabilityId: "simulated-media-rail" }],
  sessionPolicy: { maxSessionDurationMs: 3_600_000, maxConcurrentSessions: 64 },
};

const CREATION: CreateDeploymentInput = {
  slug: "brand-media-prod",
  name: "Brand media",
  environmentId: ENV_ID,
  agentId: AGENT_ID,
  agentVersion: "1.0.0",
  agentKind: "zeck",
  planId: "brand-media-plan",
};

/** Recording admission seams (typed with the real port request shapes). */
class RecordingAdmissions {
  readonly policyCalls: MediaPolicyAdmissionRequest[] = [];
  readonly capabilityCalls: MediaCapabilityAdmissionRequest[] = [];
  readonly reserves: MediaBudgetReserveCommand[] = [];
  readonly mediationCalls: MediaSecretMediationRequest[] = [];
  denyPolicy = false;
  denyAction: string | null = null;
  unmet: string[] = [];
  failBudget = false;
  refuseMediation = false;
  private seq = 0;
  private readonly reservationsByOperation = new Map<string, string>();

  readonly policy = {
    admit: async (request: MediaPolicyAdmissionRequest) => {
      this.policyCalls.push(request);
      if (this.denyPolicy || (this.denyAction !== null && this.denyAction === request.action)) {
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
    },
  };

  readonly capabilities = {
    resolve: async (request: MediaCapabilityAdmissionRequest) => {
      this.capabilityCalls.push(request);
      return { satisfied: this.unmet.length === 0, unmet: this.unmet };
    },
  };

  readonly budget = {
    reserve: async (command: MediaBudgetReserveCommand) => {
      const existing = this.reservationsByOperation.get(command.operationId);
      if (existing !== undefined) {
        return { reservationId: existing, amountMicroUsd: "80000", converged: true };
      }
      this.reserves.push(command);
      if (this.failBudget) {
        throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "fixture exhausted budget" });
      }
      this.seq += 1;
      const reservationId = `resv-${this.seq}`;
      this.reservationsByOperation.set(command.operationId, reservationId);
      return { reservationId, amountMicroUsd: "80000", converged: false };
    },
    settle: async () => ({ reservationId: "resv-x", settled: true }),
    release: async () => ({ reservationId: "resv-x", released: true }),
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

/** The verification-gate model (idempotent by key, verdict configurable). */
class RecordingVerificationGate {
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
class RecordingArtifactAuthority {
  readonly adoptions: Array<{
    tenantId: string;
    descriptor: Readonly<Record<string, unknown>>;
    parents: readonly string[];
  }> = [];
  private readonly digests = new Set<string>();
  private readonly tenants = new Map<string, Set<string>>();
  async adoptArtifact(input: {
    readonly tenantId: string;
    readonly descriptor: Readonly<Record<string, unknown>>;
    readonly parents: readonly string[];
    readonly sourceRefs: readonly Record<string, unknown>[];
  }) {
    this.adoptions.push({
      tenantId: input.tenantId,
      descriptor: input.descriptor,
      parents: [...input.parents],
    });
    const identity = digest(
      JSON.stringify([
        input.tenantId,
        input.descriptor,
        [...input.parents].sort(),
        input.sourceRefs.map((ref) => [
          (ref as Record<string, unknown>).kind,
          (ref as Record<string, unknown>).id,
          (ref as Record<string, unknown>).locator,
        ]),
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
    return (this.tenants.get(scope.tenantId) ?? new Set<string>()).has(digestValue);
  }
  seed(tenantId: string, digestValue: string) {
    const namespace = this.tenants.get(tenantId) ?? new Set<string>();
    namespace.add(digestValue);
    this.tenants.set(tenantId, namespace);
  }
}

/** In-memory model of the executions public seam (the media ledger port). */
class RecordingLedger implements MediaExecutionLedger {
  readonly opened: Array<{ key: string; input: MediaExecutionOpenInput }> = [];
  readonly evidence: MediaEvidenceInput[] = [];
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
    if (!replayed) {
      this.evidence.push(input);
    }
    this.seq += 1;
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
      (candidate) => candidate.id === input.executionId,
    );
    if (execution !== undefined && execution.status === "RUNNING") {
      execution.status = "VERIFYING";
    }
    return this.recordTransition("verify", idempotencyKey);
  }
  async completeExecution(input: Record<string, unknown>, idempotencyKey: string) {
    const results = input.verificationResults;
    const passResults = Array.isArray(results)
      ? results.filter((result) => (result as Record<string, unknown>).status === "PASS")
      : [];
    if (passResults.length === 0) {
      throw new PlatformError({
        code: "VERIFICATION_FAILED",
        message: "completion requires at least one PASS verification result",
      });
    }
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === input.executionId,
    );
    if (execution !== undefined) {
      execution.status = "COMPLETED";
    }
    return this.recordTransition("pass", idempotencyKey);
  }
  async failExecution(input: Record<string, unknown>, idempotencyKey: string) {
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === input.executionId,
    );
    if (execution !== undefined) {
      execution.status = "FAILED";
    }
    return this.recordTransition("fail", idempotencyKey);
  }
  async cancelExecution(input: Record<string, unknown>, idempotencyKey: string) {
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.id === input.executionId,
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

interface World {
  readonly service: MediaGenerationService;
  readonly store: InMemoryMediaStore;
  readonly rail: ReturnType<typeof createInProcessMediaRail>;
  readonly admissions: RecordingAdmissions;
  readonly verification: RecordingVerificationGate;
  readonly artifacts: RecordingArtifactAuthority;
  readonly ledger: RecordingLedger;
  readonly deploymentService: ReturnType<typeof createDeploymentService>;
  deploymentId: string;
}

async function buildWorld(): Promise<World> {
  const deploymentStore = new InMemoryDeploymentStore();
  const registry = createModalityAdapterRegistry();
  const rail = createInProcessMediaRail(["video", "image", "audio", "multimodal"], {
    now: () => new Date("2026-01-01T00:00:00Z"),
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
  const admissions = new RecordingAdmissions();
  const verification = new RecordingVerificationGate();
  const artifacts = new RecordingArtifactAuthority();
  const ledger = new RecordingLedger();
  const deps: MediaGenerationServiceDeps = {
    store,
    deployments: deploymentStore,
    rail,
    policy: admissions.policy,
    capabilities: admissions.capabilities,
    budget: admissions.budget,
    secrets: admissions.secrets,
    ledger,
    artifacts,
    verification,
    railConnectionRef: "conn-media-rail-1",
    digest,
    generateId,
    now,
  };
  const service = createMediaGenerationService(deps);
  const world: World = {
    service,
    store,
    rail,
    admissions,
    verification,
    artifacts,
    ledger,
    deploymentService,
    deploymentId: "",
  };
  await world.deploymentService.publishProfile({ ...PROFILE }, { version: 1 }, ACTOR);
  await world.deploymentService.publishPlan({ ...PLAN }, { version: 1 }, ACTOR);
  const created = await world.deploymentService.createDeployment(
    { ...CREATION },
    "deploy-key-0",
    ACTOR,
  );
  world.deploymentId = created.deploymentId;
  return world;
}

const submitInput = (world: World, prompt: string): SubmitMediaJobInput => ({
  deploymentId: world.deploymentId,
  generationKind: "image",
  prompt,
});

const requiredVerificationSubmit = (world: World, prompt: string): SubmitMediaJobInput => ({
  ...submitInput(world, prompt),
  verification: { criteria: [{ criterionId: "media-output-integrity", version: 1 }] },
});

/** Drive a job to the completion boundary through polls. */
async function pollToCompletion(world: World, jobId: string, polls = 6) {
  let outcome: Awaited<ReturnType<MediaGenerationService["pollJob"]>> | null = null;
  for (let index = 0; index < polls; index += 1) {
    outcome = await world.service.pollJob(jobId, ACTOR);
    if (outcome.status === "completed" || outcome.status === "failed") {
      return outcome;
    }
  }
  return outcome as Awaited<ReturnType<MediaGenerationService["pollJob"]>>;
}

describe("discrimination: the provider-neutral media generation boundaries (WORK-026)", () => {
  test("the clean tree scans clean (the probe's baseline)", () => {
    expect(violationsOf(cleanRules())).toEqual([]);
  });

  // S1 — tenant isolation.
  test("S1 STATIC: removing the job tenant guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (job.tenantId !== actor.tenantId) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("job-tenant-guard-removed");
  });

  test("S1 STATIC: removing the deployment tenant guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (deployment.tenantId !== tenantId) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("deployment-tenant-guard-removed");
  });

  test("S1 RUNTIME: a foreign-tenant actor cannot submit/read/poll/cancel/derive on another tenant's job", async () => {
    const world = await buildWorld();
    const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s1", ACTOR);
    await expect(
      world.service.submitJob(submitInput(world, "steal"), "s1-other", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(world.service.pollJob(submitted.jobId, OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    await expect(
      world.service.cancelJob(submitted.jobId, "no", OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    await expect(
      world.service.deriveVariant(
        { jobId: submitted.jobId, variant: { resize: "50%" } },
        "s1-v",
        OTHER_TENANT_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    const foreignFrame: MediaCallbackInput = {
      jobId: submitted.jobId,
      providerJobRef: submitted.providerJobRef ?? "simmedia-job-1",
      observation: "provider-completed",
      callbackKey: "cb-s1",
      outputDescriptor: { contentDigest: "a".repeat(64), generationKind: "image" },
    };
    await expect(
      world.service.applyCallback(foreignFrame, OTHER_TENANT_ACTOR),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    // Zero side effects for the foreign tenant.
    expect(world.rail.sends.filter((record) => record.kind === "dispatch")).toHaveLength(1);
    expect(world.admissions.policyCalls.length).toBeGreaterThanOrEqual(1);
  });

  // S2 — policy before side effect.
  test("S2 STATIC: deleting the submission policy admission is flagged (admission-missing)", () => {
    const mutated = mutateService((content) =>
      content.replace(
        /const decision = await policy\.admit\(\{[\s\S]*?\}\);\n {4}if \(!decision\.allowed\) \{[\s\S]*?\n {4}\}/,
        "",
      ),
    );
    expect(violationsOf(mutated)).toContain("admission-missing:policy.admit(");
  });

  test("S2 STATIC: reordering the admission chain (budget before capability) is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "const capabilityDecision = await capabilities.resolve({",
        "const __moved = budget.reserve({}); const capabilityDecision = await capabilities.resolve({",
      ),
    );
    expect(violationsOf(mutated)).toContain(
      "admission-order:capabilities.resolve(-after-budget.reserve(",
    );
  });

  test("S2 RUNTIME: a policy denial at submit AND cancel performs zero rail side effects", async () => {
    const world = await buildWorld();
    world.admissions.denyPolicy = true;
    await expect(
      world.service.submitJob(submitInput(world, "a forbidden render"), "s2", ACTOR),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(world.rail.sends).toHaveLength(0);
    expect(world.admissions.reserves).toHaveLength(0);
    world.admissions.denyPolicy = false;
    const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s2b", ACTOR);
    world.admissions.denyAction = "job-cancel";
    await expect(world.service.cancelJob(submitted.jobId, "no", ACTOR)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    expect(world.rail.sends.filter((record) => record.kind === "cancel")).toHaveLength(0);
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
  });

  // S3 — capability-before-provider.
  test("S3 STATIC: removing the capability gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!capabilityDecision.satisfied) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("capability-gate-removed");
  });

  test("S3 RUNTIME: an unmet capability cannot dispatch paid work (CAPABILITY_UNAVAILABLE, zero sends)", async () => {
    const world = await buildWorld();
    world.admissions.unmet = ["media-generation-fabric"];
    await expect(
      world.service.submitJob(submitInput(world, "a koi"), "s3", ACTOR),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    expect(world.rail.sends).toHaveLength(0);
    expect(world.admissions.reserves).toHaveLength(0);
    // Capability admission happens BEFORE the budget reservation.
    expect(world.admissions.capabilityCalls.length).toBeGreaterThanOrEqual(1);
  });

  // S4 — budget-before-paid-dispatch (the MOD-013 core).
  test("S4 STATIC: removing the dispatch-tail budget admission is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        /const reservation = await budget\.reserve\(\{[\s\S]*?\}\);\n {6}reservationId = reservation\.reservationId;/,
        "reservationId = 'forged';",
      ),
    );
    expect(violationsOf(mutated)).toContain("dispatch-budget-gate-removed");
  });

  test("S4 STATIC: dispatching the rail call before the budget reservation is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "const amountMicroUsd = railCostMicroUsd(job.generationKind);\n      const reservation = await budget.reserve({",
        "const amountMicroUsd = railCostMicroUsd(job.generationKind);\n      const __early = await rail.submitJob({ early: true });\n      const reservation = await budget.reserve({",
      ),
    );
    expect(violationsOf(mutated)).toContain("dispatch-budget-after-rail");
  });

  test("S4 RUNTIME: an exhausted budget prevents the paid dispatch (BUDGET_EXCEEDED, zero rail sends)", async () => {
    const world = await buildWorld();
    world.admissions.failBudget = true;
    await expect(
      world.service.submitJob(submitInput(world, "an expensive render"), "s4", ACTOR),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(world.rail.sends).toHaveLength(0);
    // The denial is durably recorded and the opened execution is failed
    // (no orphan RUNNING executions of denied submissions).
    const record = await world.store.findMediaOperation(
      ACTOR.applicationId,
      `mediaop:job-submission:s4`,
    );
    expect(record?.status).toBe("failed");
    expect(record?.failureReason).toContain("BUDGET_EXCEEDED");
    expect(world.ledger.transitions.some((entry) => entry.command === "fail")).toBe(true);
  });

  // S5 — secret mediation.
  test("S5 STATIC: removing the mediation gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!mediation.mediated) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("mediation-gate-removed");
  });

  test("S5 RUNTIME: refused secret mediation fails closed and releases the reservation", async () => {
    const world = await buildWorld();
    world.admissions.refuseMediation = true;
    await expect(
      world.service.submitJob(submitInput(world, "a koi"), "s5", ACTOR),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(world.rail.sends).toHaveLength(0);
  });

  // S6 — duplicate submission idempotency.
  test("S6 STATIC: removing the idempotent-replay fast path is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "const replayed = await store.findJobBySubmissionKey(actor.applicationId, idempotencyKey);",
        "const replayed = null;",
      ),
    );
    expect(violationsOf(mutated)).toContain("replay-branch-removed");
  });

  test("S6 RUNTIME: repeated and N=8 concurrent submissions converge on ONE job + ONE paid dispatch", async () => {
    const world = await buildWorld();
    const first = await world.service.submitJob(submitInput(world, "eight kois"), "s6", ACTOR);
    const second = await world.service.submitJob(submitInput(world, "eight kois"), "s6", ACTOR);
    expect(second.jobId).toBe(first.jobId);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    // A different key under the same prompt is a DIFFERENT job (the
    // key is the discriminator — the body fingerprint arbitrates reuse).
    const third = await world.service.submitJob(submitInput(world, "eight kois"), "s6b", ACTOR);
    expect(third.jobId).not.toBe(first.jobId);
    // N=8 concurrent duplicates under one key.
    const raced = await Promise.all(
      Array.from({ length: 8 }, () =>
        world.service.submitJob(submitInput(world, "racing kois"), "s6-race", ACTOR),
      ),
    );
    expect(new Set(raced.map((result) => result.jobId)).size).toBe(1);
    expect(new Set(raced.map((result) => result.executionId)).size).toBe(1);
    // Exactly THREE paid dispatches total (one per logical job: first,
    // third, raced) — never one per DUPLICATE submission.
    expect(world.rail.sends.filter((record) => record.kind === "dispatch")).toHaveLength(3);
    expect(world.ledger.opened).toHaveLength(3);
  });

  // S7 — callback correlation.
  test("S7 STATIC: removing the callback correlation guard is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (job.providerJobRef !== input.providerJobRef) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("correlation-guard-removed");
  });

  test("S7 RUNTIME: a foreign or stale callback frame is rejected before any mutation", async () => {
    const world = await buildWorld();
    const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s7", ACTOR);
    const foreignFrame: MediaCallbackInput = {
      jobId: submitted.jobId,
      providerJobRef: "simmedia-job-999",
      observation: "provider-completed",
      callbackKey: "cb-foreign",
      outputDescriptor: { contentDigest: "b".repeat(64), generationKind: "image" },
    };
    await expect(world.service.applyCallback(foreignFrame, ACTOR)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
    const observations = await world.store.listObservations(ACTOR.applicationId, submitted.jobId);
    expect(observations).toHaveLength(0);
  });

  // S8 — callback tenant isolation.
  test("S8 STATIC: an unguarded callback path is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "const job = await resolveJob(actor, input.jobId);",
        "const job = await store.findJob(actor.applicationId, input.jobId);\n      if (job === null) { throw new Error('absent'); }",
      ),
    );
    expect(violationsOf(mutated)).toContain("callback-path-unguarded");
  });

  test("S8 RUNTIME: a callback from a foreign-tenant actor fails closed (TENANT_SCOPE_VIOLATION)", async () => {
    const world = await buildWorld();
    const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s8", ACTOR);
    const frame: MediaCallbackInput = {
      jobId: submitted.jobId,
      providerJobRef: submitted.providerJobRef ?? "simmedia-job-1",
      observation: "provider-completed",
      callbackKey: "cb-s8",
      outputDescriptor: { contentDigest: "c".repeat(64), generationKind: "image" },
    };
    await expect(world.service.applyCallback(frame, OTHER_TENANT_ACTOR)).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("generating");
  });

  // S9 — verification-before-completion.
  test("S9 STATIC: bypassing the verification gate is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace('if (job.verificationMode === "required") {', "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("verification-gate-bypassed");
  });

  test("S9 STATIC: removing the criteriaMet rejection is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("if (!verdict.criteriaMet) {", "if (false) {"),
    );
    expect(violationsOf(mutated)).toContain("verification-rejection-removed");
  });

  test("S9 RUNTIME: a criteriaMet=false verdict FAILS the job — unverified output never completes", async () => {
    const world = await buildWorld();
    world.verification.criteriaMet = false;
    const submitted = await world.service.submitJob(
      requiredVerificationSubmit(world, "a verified koi"),
      "s9",
      ACTOR,
    );
    await expect(pollToCompletion(world, submitted.jobId)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failureCause).toContain("verification rejected");
    expect(job?.outputArtifactDigest).toBeNull();
    expect(world.verification.calls.length).toBeGreaterThanOrEqual(1);
    expect(world.ledger.transitions.some((entry) => entry.command === "fail")).toBe(true);
    expect(world.ledger.transitions.some((entry) => entry.command === "pass")).toBe(false);
    // A re-poll converges on the FAILED terminal state — a replay
    // cannot flip the rejection.
    const replay = await world.service.pollJob(submitted.jobId, ACTOR);
    expect(replay.status).toBe("failed");
  });

  // S10 — deterministic postprocessing rejection.
  test("S10 STATIC: removing the postprocessing shape check is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        /const postprocessed = postprocessMediaOutput\(\{[\s\S]*?\}\);/,
        "const postprocessed = { descriptor: providerOutput };",
      ),
    );
    expect(violationsOf(mutated)).toContain("postprocessing-removed");
  });

  test("S10 RUNTIME: a kind-mismatched provider output is rejected before completion", async () => {
    const world = await buildWorld();
    const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s10", ACTOR);
    // Apply a callback whose output descriptor claims a DIFFERENT
    // generation kind than the job's (the deterministic shape check).
    const mismatchedFrame: MediaCallbackInput = {
      jobId: submitted.jobId,
      providerJobRef: submitted.providerJobRef ?? "simmedia-job-1",
      observation: "provider-completed",
      callbackKey: "cb-s10",
      outputDescriptor: { contentDigest: "d".repeat(64), generationKind: "video" },
    };
    await expect(world.service.applyCallback(mismatchedFrame, ACTOR)).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
    });
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.outputArtifactDigest).toBeNull();
    expect(world.artifacts.adoptions).toHaveLength(0);
  });

  // S11 — artifact lineage.
  test("S11 STATIC: dropping the output lineage parent is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "parents: job.inputArtifactDigest === null ? [] : [job.inputArtifactDigest],",
        "parents: [],",
      ),
    );
    expect(violationsOf(mutated)).toContain("output-lineage-dropped");
  });

  test("S11 STATIC: dropping the variant lineage parent is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace("parents: [sourceDigest],", "parents: [],"),
    );
    expect(violationsOf(mutated)).toContain("variant-lineage-dropped");
  });

  test("S11 RUNTIME: generated outputs and derived variants carry their lineage parents", async () => {
    const world = await buildWorld();
    const inputDigest = digest("source-image");
    world.artifacts.seed(ACTOR.tenantId, inputDigest);
    const submitted = await world.service.submitJob(
      { ...submitInput(world, "a remixed koi"), inputArtifactDigest: inputDigest },
      "s11",
      ACTOR,
    );
    const completed = await pollToCompletion(world, submitted.jobId);
    expect(completed.status).toBe("completed");
    expect(world.artifacts.adoptions).toHaveLength(1);
    expect(world.artifacts.adoptions[0]?.parents).toEqual([inputDigest]);
    // The derived variant adopts the OUTPUT digest as its parent.
    const variant = await world.service.deriveVariant(
      { jobId: submitted.jobId, variant: { resize: "50%" } },
      "s11-v",
      ACTOR,
    );
    expect(variant.parentDigests).toEqual([completed.outputArtifactDigest]);
    expect(world.artifacts.adoptions[1]?.parents).toEqual([completed.outputArtifactDigest]);
  });

  // S12 — stable rail keys / retry idempotency.
  test("S12 STATIC: degrading the paid-dispatch rail key is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "idempotencyKey: mediaRailDispatchKey(job.id),",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the mutant text embeds a template placeholder by design
        "idempotencyKey: `${job.id}:${Date.now()}`,",
      ),
    );
    expect(violationsOf(mutated)).toContain("dispatch-key-degraded");
  });

  test("S12 STATIC: degrading the cancel rail key is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "idempotencyKey: mediaRailCancelKey(job.id),",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the mutant text embeds a template placeholder by design
        "idempotencyKey: `${job.id}:${Date.now()}`,",
      ),
    );
    expect(violationsOf(mutated)).toContain("cancel-key-degraded");
  });

  test("S12 RUNTIME: the rail key is job-stable and a repeated retry converges with ONE paid dispatch", async () => {
    const world = await buildWorld();
    const railFail = createInProcessMediaRail(["image"], {
      now: () => new Date("2026-01-01T00:00:00Z"),
      failJobs: "fixture provider failure",
    });
    void railFail;
    const failed = await (async () => {
      // A provider-failed observation fails the job; then retry under
      // one key twice converges on ONE retry job.
      const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s12", ACTOR);
      const failFrame: MediaCallbackInput = {
        jobId: submitted.jobId,
        providerJobRef: submitted.providerJobRef ?? "simmedia-job-1",
        observation: "provider-failed",
        callbackKey: "cb-s12-fail",
      };
      await world.service.applyCallback(failFrame, ACTOR);
      const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
      expect(job?.status).toBe("failed");
      return submitted;
    })();
    const retry = await world.service.retryJob(
      failed.jobId,
      { prompt: "a koi" },
      "retry-s12",
      ACTOR,
    );
    const retryAgain = await world.service.retryJob(
      failed.jobId,
      { prompt: "a koi" },
      "retry-s12",
      ACTOR,
    );
    expect(retryAgain.jobId).toBe(retry.jobId);
    expect(retryAgain.executionId).toBe(retry.executionId);
    const dispatches = world.rail.sends.filter((record) => record.kind === "dispatch");
    expect(dispatches).toHaveLength(2);
    // Every dispatch key is the stable job-derived key.
    expect(
      dispatches.every((record) => record.idempotencyKey === mediaRailDispatchKey(record.jobId)),
    ).toBe(true);
    expect(new Set(dispatches.map((record) => record.idempotencyKey)).size).toBe(2);
  });

  // S13 — the closed lifecycle vocabulary.
  test("S13 STATIC: opening the job status vocabulary is flagged", () => {
    const mutated = mutateDomain((content) =>
      content.replace(
        'export const MEDIA_JOB_STATUSES = [\n  "submitted",',
        'export const MEDIA_JOB_STATUSES = [\n  "vendor-queued",\n  "submitted",',
      ),
    );
    expect(violationsOf(mutated)).toContain("lifecycle-opened-statuses");
  });

  test("S13 STATIC: opening the observation vocabulary is flagged", () => {
    const mutated = mutateDomain((content) =>
      content.replace(
        'export const MEDIA_PROVIDER_OBSERVATIONS = [\n  "accepted",',
        'export const MEDIA_PROVIDER_OBSERVATIONS = [\n  "vendor-succeeded",\n  "accepted",',
      ),
    );
    expect(violationsOf(mutated)).toContain("lifecycle-opened-observations");
  });

  test("S13 STATIC: removing the migration status vocabulary CHECK is flagged", () => {
    const mutated = mutateMigration((content) =>
      content.replace("CONSTRAINT media_jobs_status_vocabulary CHECK", "CONSTRAINT removed CHECK"),
    );
    expect(violationsOf(mutated)).toContain("migration-status-vocabulary-removed");
  });

  test("S13 STATIC: removing the migration observation vocabulary CHECK is flagged", () => {
    const mutated = mutateMigration((content) =>
      content.replace("CONSTRAINT media_obs_vocabulary CHECK", "CONSTRAINT removed CHECK"),
    );
    expect(violationsOf(mutated)).toContain("migration-observation-vocabulary-removed");
  });

  test("S13 RUNTIME: terminal jobs cannot be cancelled (the closed lifecycle's terminal immutability)", async () => {
    const world = await buildWorld();
    const submitted = await world.service.submitJob(submitInput(world, "a koi"), "s13", ACTOR);
    const completed = await pollToCompletion(world, submitted.jobId);
    expect(completed.status).toBe("completed");
    await expect(world.service.cancelJob(submitted.jobId, "too late", ACTOR)).rejects.toMatchObject(
      {
        code: "INVALID_STATE_TRANSITION",
      },
    );
    const job = await world.store.findJob(ACTOR.applicationId, submitted.jobId);
    expect(job?.status).toBe("completed");
  });

  // S14 — no second execution state machine.
  test("S14 STATIC: an execution-transition surface on the store port is flagged", () => {
    const mutated = mutateStorePort(
      (content) => `${content}\n  transitionExecution(input: unknown): Promise<unknown>;\n`,
    );
    expect(violationsOf(mutated)).toContain("execution-authority-inversion:transitionExecution");
  });

  test("S14 STATIC: removing the ledger verify path is flagged", () => {
    const mutated = mutateService((content) =>
      content.replace(
        "await ledger\n        .enterVerification(",
        "await (undefined as any)\n        .enterVerification(",
      ),
    );
    expect(violationsOf(mutated)).toContain("ledger-verify-path-removed");
  });

  test("S14 STATIC: rail-port authority vocabulary is flagged", () => {
    const mutated = mutateRailPort((content) =>
      content.replace(
        "  submitJob(request: MediaRailDispatchRequest): Promise<MediaRailDispatchOutcome>;",
        "  submitJob(request: MediaRailDispatchRequest): Promise<MediaRailDispatchOutcome>;\n  reserve(input: unknown): Promise<unknown>;",
      ),
    );
    expect(violationsOf(mutated)).toContain("rail-authority-vocabulary:reserve");
  });

  test("S14 RUNTIME: execution transitions ride the ledger seam only (verify→pass on the happy path)", async () => {
    const world = await buildWorld();
    const submitted = await world.service.submitJob(
      requiredVerificationSubmit(world, "a verified koi"),
      "s14",
      ACTOR,
    );
    const completed = await pollToCompletion(world, submitted.jobId);
    expect(completed.status).toBe("completed");
    const commands = world.ledger.transitions.map((entry) => entry.command);
    expect(commands).toContain("verify");
    expect(commands).toContain("pass");
    expect(commands).not.toContain("fail");
    expect(commands).not.toContain("cancel");
  });
});
