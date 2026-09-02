/**
 * Discrimination: the long-running/resumable execution boundaries
 * (WORK-028, LNG-001/002/003; checkpoint contracts
 * CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE).
 *
 * The REQUIRED SAFETY PROOFS of the Work Order's mandatory coverage,
 * labeled D1..D12 (static) and R1..R10 (runtime). Every protection has
 * BOTH halves (the house style):
 *
 *   STATIC mutants mutate the REAL source in memory; the probe scanners
 *   below must flag exactly the weakened protection (a mutant that
 *   removes, reorders or inverts a guard is caught without touching the
 *   clean tree, which always scans clean);
 *
 *   RUNTIME red records observe the governed in-memory world under
 *   constructed scenarios and stay red (the negative behavior is the
 *   permanent expected outcome).
 *
 * Proof map (proof → mutant → runtime red):
 *   D1/R1  stale worker cannot commit   lease-guard-removed
 *          side effects (AC3's core)    expired + foreign + superseded
 *                                        claims: typed failure, ZERO writes
 *   D2/R2  lease conflict FAILS CLOSED  acquire-refused-branch-removed
 *                                        live-held acquire: typed refusal,
 *                                        lease unchanged
 *   D3/R3  concurrent resumes converge  resume-lease-arbitration-removed
 *   (AC6)                                 N=8 workers: ONE winner, 7 typed
 *                                        conflicts, ONE resume transition
 *   D4/R4  checkpoint integrity         integrity-check-removed
 *          tampering rejected            tampered digest: typed failure
 *   D5/R5  incompatible plan revision    compatibility-check-removed
 *          rejected                      revision mismatch: typed failure
 *   D6/R6  materially changed resume     materiality-branch-removed
 *          re-enters admission (LNG-003/ changed facts: policy + resource
 *          AC4)                          seams consulted; unchanged: never
 *   D7/R7  human interruption is         journal-after-act mutant
 *          authoritative + auditable     WAITING_HUMAN, lease
 *                                        force-released, wakes superseded,
 *                                        evidence BEFORE the move
 *   D8/R8  the execution identity is     identity-creation-added
 *          never re-created              same id across pause/resume
 *   D9     no second execution authority port-authority-added (structural)
 *   D10/R10 policy denial blocks resume  denial-not-durable mutant
 *          side effects                  POLICY_DENIED, zero side effects,
 *                                        durable FAILED replay
 *   D11    committed-effect probe runs   probe-order-inverted
 *          BEFORE the lease guard (the
 *          crash-recovery committed/
 *          reversible distinction)
 *   D12    the physical guards exist in  migration-guard-removed mutants
 *          migration 0022 (convergence-
 *          aware sequence gate, guarded
 *          lease epochs, ops lifecycle)
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { BudgetAuthority } from "../../src/modules/budgets/public";
import { InMemoryLongRunningExecutionStore } from "../../src/modules/executions/adapters/in-memory-long-running-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../src/modules/executions/application/execution-service";
import {
  createLongRunningExecutionService,
  type LongRunningExecutionService,
} from "../../src/modules/executions/application/long-running-service";
import type {
  CheckpointContents,
  CheckpointRecord,
  ResumeFacts,
} from "../../src/modules/executions/domain/checkpoint";
import type { ResumeReAdmissionRequest } from "../../src/modules/executions/ports/resume-admission";
import { PlatformError } from "../../src/shared/errors";
import {
  allowAllAuthorization,
  FakeBudgetAuthority,
  InMemoryExecutionStore,
  InMemoryExecutionsIdempotency,
} from "../unit/executions/fakes";

const REPO_ROOT = join(process.cwd());
const SERVICE_PATH = "src/modules/executions/application/long-running-service.ts";
const CHECKPOINT_DOMAIN_PATH = "src/modules/executions/domain/checkpoint.ts";
const STORE_PORT_PATH = "src/modules/executions/ports/long-running-store.ts";
const MIGRATION_PATH = "src/platform/db/migrations/0022_long_running_execution_state.sql";
const SERVICE_SOURCE = readFileSync(join(REPO_ROOT, SERVICE_PATH), "utf8");
const CHECKPOINT_DOMAIN_SOURCE = readFileSync(join(REPO_ROOT, CHECKPOINT_DOMAIN_PATH), "utf8");
const STORE_PORT_SOURCE = readFileSync(join(REPO_ROOT, STORE_PORT_PATH), "utf8");
const MIGRATION_SOURCE = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");
const STORE_SQL_SOURCE = readFileSync(
  join(REPO_ROOT, "src/modules/executions/adapters/sql-long-running-store.ts"),
  "utf8",
);

const digest = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex");

/** Extract one function-const body from the service source (2-space indent). */
function bodyOf(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start === -1) {
    throw new Error(`signature not found: ${signature}`);
  }
  const next = source.indexOf("\n  const ", start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

/** Re-splice one function-const body back into the (mutated) source. */
function mutateBodyOf(
  source: string,
  signature: string,
  mutation: (body: string) => string,
): string {
  const body = bodyOf(source, signature);
  return source.replace(body, mutation(body));
}

const COMMIT_CHECKPOINT_BODY = bodyOf(SERVICE_SOURCE, "const commitCheckpoint = async (");
const ACQUIRE_BODY = bodyOf(SERVICE_SOURCE, "const acquireLease = async (");
const RESUME_BODY = bodyOf(SERVICE_SOURCE, "const resumeExecution = async (");
const INTERRUPT_BODY = bodyOf(SERVICE_SOURCE, "const requestInterruption = async (");

// ---------------------------------------------------------------------------
// The static probe: violations over the (possibly mutated) REAL source.
// ---------------------------------------------------------------------------

interface LongRunningRules {
  readonly service: string;
  readonly commitCheckpointBody: string;
  readonly acquireBody: string;
  readonly resumeBody: string;
  readonly interruptBody: string;
  readonly storePort: string;
  readonly migration: string;
  readonly storeSql: string;
}

function violationsOf(rules: LongRunningRules): string[] {
  const violations: string[] = [];

  // D1 — the lease-validity guard protects the checkpoint commit (the
  // side effect), and the worker transition.
  if (
    !rules.commitCheckpointBody.includes(
      "await guardLease(input.applicationId, input.executionId, input.worker)",
    )
  ) {
    violations.push("lease-guard-removed");
  }
  if (
    !rules.service.includes(
      "await guardLease(input.applicationId, input.command.executionId, input.worker)",
    )
  ) {
    violations.push("worker-transition-guard-removed");
  }

  // D11 — the COMMITTED-EFFECT probe runs BEFORE the lease guard (an
  // already-durable checkpoint is converged, never re-guarded, never
  // duplicated; an uncommitted one is guarded — the crash-recovery
  // committed/reversible distinction).
  const probe = rules.commitCheckpointBody.indexOf("findCheckpointByDigest(");
  const guard = rules.commitCheckpointBody.indexOf("guardLease(input.applicationId");
  if (probe === -1 || guard === -1) {
    violations.push("probe-or-guard-missing");
  } else if (probe > guard) {
    violations.push("probe-order-inverted");
  }

  // D2 — lease conflicts FAIL CLOSED (the refused branch exists and
  // throws; the row stays honestly PENDING).
  if (!rules.acquireBody.includes('if (outcome.status === "refused") {')) {
    violations.push("acquire-refused-branch-removed");
  }
  if (!rules.acquireBody.includes("LEASE CONFLICT: FAIL CLOSED")) {
    violations.push("acquire-conflict-comment-removed");
  }

  // D3 — the resuming worker ACQUIRES the lease (the arbitration that
  // makes concurrent resumes converge to one authoritative owner).
  if (!rules.resumeBody.includes("store.acquireLease(")) {
    violations.push("resume-lease-arbitration-removed");
  }

  // D4 — the checkpoint INTEGRITY check (recomputed digest) exists.
  if (!rules.resumeBody.includes("checkpointIntegrityFailure(checkpoint, digest)")) {
    violations.push("integrity-check-removed");
  }

  // D5 — the plan-revision COMPATIBILITY check exists.
  if (
    !rules.resumeBody.includes("checkpointIncompatibility(checkpoint.contents, input.resumeFacts)")
  ) {
    violations.push("compatibility-check-removed");
  }

  // D6/R6 — the MATERIALIZITY rule: changed facts re-enter the CURRENT
  // policy admission (and the resource axis for resource dimensions).
  if (!rules.resumeBody.includes("materialChangeBetween(checkpoint.contents, input.resumeFacts)")) {
    violations.push("materiality-branch-removed");
  }
  if (!rules.resumeBody.includes("await resumePolicyReadmission.readmit(request)")) {
    violations.push("policy-readmission-removed");
  }
  if (!rules.resumeBody.includes("await resourceReadmission.readmit(request)")) {
    violations.push("resource-readmission-removed");
  }
  // The materiality dimensions are pinned in the domain (the explicit
  // materiality rule).
  if (!rules.service.includes('"executions.longrunning.resume"')) {
    violations.push("resume-fingerprint-marker-removed");
  }
  const materialitySource = CHECKPOINT_DOMAIN_SOURCE;
  if (!materialitySource.includes("export const MATERIAL_CHANGE_DIMENSIONS")) {
    violations.push("materiality-dimensions-removed");
  }

  // D7 — human interruption is journal-then-act: the durable request
  // evidence BEFORE the wake supersede, the lease force-release and the
  // frozen wait-human move.
  const requested = rules.interruptBody.indexOf('"interruption-requested"');
  const supersede = rules.interruptBody.indexOf("markWakeUpsSuperseded(");
  const forceRelease = rules.interruptBody.indexOf("forceReleaseLease(");
  const waitHuman = rules.interruptBody.indexOf('"wait-human"');
  if (requested === -1) {
    violations.push("interruption-evidence-removed");
  } else {
    for (const [label, index] of [
      ["wake-supersede", supersede],
      ["lease-force-release", forceRelease],
      ["wait-human-move", waitHuman],
    ] as const) {
      if (index === -1) {
        violations.push(`interruption-${label}-removed`);
      } else if (requested > index) {
        violations.push(`journal-after-act:${label}`);
      }
    }
  }
  // The human authority force-releases ANY live lease (never blocked).
  if (!rules.interruptBody.includes('cause: "human-interruption"')) {
    violations.push("interruption-force-release-cause-removed");
  }

  // D8 — the identity is never re-created: no createExecution call
  // anywhere in the long-running service (a second identity is
  // unrepresentable).
  if (rules.service.includes("createExecution(")) {
    violations.push("identity-creation-added");
  }
  if (!rules.resumeBody.includes("executionId: input.executionId")) {
    violations.push("resume-identity-echo-removed");
  }

  // D9 — no second execution authority: the store port never carries
  // execution-transition/status vocabulary.
  for (const forbidden of [
    "setExecutionStatus",
    "transitionExecution",
    "updateExecutionStatus",
    "appendEvent(",
    "recordStepEvent(",
  ]) {
    if (rules.storePort.includes(forbidden)) {
      violations.push(`port-authority-added:${forbidden}`);
    }
  }

  // D10 — a policy denial is DURABLE: the journal-then-fail pair (the
  // `resume-denied` evidence + the POLICY-branch failOperation with the
  // policy reason) both exist in the denial branch.
  if (!rules.resumeBody.includes('"resume-denied"')) {
    violations.push("denial-evidence-removed");
  }
  if (!rules.resumeBody.includes("`resume re-admission denied: ${policy.reason")) {
    violations.push("denial-not-durable");
  }

  // D12 — the physical guards of migration 0022 (+ the SQL store's
  // monotonic epoch advance).
  if (!rules.migration.includes("CREATE TRIGGER lr_checkpoint_sequence_gate")) {
    violations.push("migration-sequence-gate-removed");
  }
  if (!rules.migration.includes("IF existing_digest = NEW.content_digest THEN RETURN NEW;")) {
    violations.push("migration-convergence-branch-removed");
  }
  if (!rules.migration.includes("CREATE TRIGGER lr_lease_guards")) {
    violations.push("migration-lease-guards-removed");
  }
  if (!rules.migration.includes("lease epoch must not regress")) {
    violations.push("migration-epoch-regression-guard-removed");
  }
  if (!rules.storeSql.includes("epoch = epoch + 1")) {
    violations.push("store-epoch-monotonicity-removed");
  }
  if (!rules.migration.includes("CREATE TRIGGER lr_ops_lifecycle_guard")) {
    violations.push("migration-ops-lifecycle-removed");
  }
  if (!rules.migration.includes("lr_ops_key_unique")) {
    violations.push("migration-ops-stable-key-removed");
  }
  if (!rules.migration.includes("lr_lease_execution_fk")) {
    violations.push("migration-identity-binding-removed");
  }

  return violations;
}

/** The clean tree scans clean. */
function cleanRules(): LongRunningRules {
  return {
    service: SERVICE_SOURCE,
    commitCheckpointBody: COMMIT_CHECKPOINT_BODY,
    acquireBody: ACQUIRE_BODY,
    resumeBody: RESUME_BODY,
    interruptBody: INTERRUPT_BODY,
    storePort: STORE_PORT_SOURCE,
    migration: MIGRATION_SOURCE,
    storeSql: STORE_SQL_SOURCE,
  };
}

function mutateService(mutation: (content: string) => string): LongRunningRules {
  const service = mutation(SERVICE_SOURCE);
  return {
    service,
    commitCheckpointBody: bodyOf(service, "const commitCheckpoint = async ("),
    acquireBody: bodyOf(service, "const acquireLease = async ("),
    resumeBody: bodyOf(service, "const resumeExecution = async ("),
    interruptBody: bodyOf(service, "const requestInterruption = async ("),
    storePort: STORE_PORT_SOURCE,
    migration: MIGRATION_SOURCE,
    storeSql: STORE_SQL_SOURCE,
  };
}

function mutateStoreSql(mutation: (content: string) => string): LongRunningRules {
  return { ...cleanRules(), storeSql: mutation(STORE_SQL_SOURCE) };
}

function mutatePort(mutation: (content: string) => string): LongRunningRules {
  return { ...cleanRules(), storePort: mutation(STORE_PORT_SOURCE) };
}

function mutateMigration(mutation: (content: string) => string): LongRunningRules {
  return { ...cleanRules(), migration: mutation(MIGRATION_SOURCE) };
}

// ---------------------------------------------------------------------------
// The runtime world (a compact twin of the unit suite's world).
// ---------------------------------------------------------------------------

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000a1";
const ACTOR_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID };

/** Recording fakes for the two REQUIRED re-admission authorities. */
class AdmissionFakes {
  readonly policyCalls: ResumeReAdmissionRequest[] = [];
  readonly resourceCalls: ResumeReAdmissionRequest[] = [];
  denyPolicy = false;
  readonly policy = {
    readmit: async (request: ResumeReAdmissionRequest) => {
      this.policyCalls.push(request);
      return this.denyPolicy
        ? {
            allowed: false as const,
            reason: "fixture policy denial",
            denialCode: "POLICY_DENIED" as const,
          }
        : { allowed: true as const };
    },
  };
  readonly resource = {
    readmit: async (request: ResumeReAdmissionRequest) => {
      this.resourceCalls.push(request);
      return { allowed: true as const };
    },
  };
}

interface World {
  readonly executions: ExecutionService;
  readonly executionStore: InMemoryExecutionStore;
  readonly store: InMemoryLongRunningExecutionStore;
  readonly service: LongRunningExecutionService;
  readonly admissions: AdmissionFakes;
  readonly budgets: FakeBudgetAuthority;
  readonly advance: (ms: number) => void;
}

function createWorld(): World {
  const executionStore = new InMemoryExecutionStore();
  executionStore.seedApplication(APPLICATION_ID, TENANT_ID);
  const idempotency = new InMemoryExecutionsIdempotency();
  idempotency.store = executionStore;
  let n = 0;
  const generateId = () => {
    n += 1;
    return `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  };
  let clockMs = Date.parse("2026-09-15T12:00:00Z");
  const now = () => new Date(clockMs);
  const advance = (ms: number) => {
    clockMs += ms;
  };
  const executions = createExecutionService({
    store: executionStore,
    idempotency,
    authorization: allowAllAuthorization,
    generateId,
    now,
  });
  const store = new InMemoryLongRunningExecutionStore();
  const admissions = new AdmissionFakes();
  const budgets = new FakeBudgetAuthority();
  const service = createLongRunningExecutionService({
    executions,
    store,
    resumePolicyReadmission: admissions.policy,
    resourceReadmission: admissions.resource,
    budgetAuthority: budgets.impl as BudgetAuthority,
    digest,
    generateId,
    now,
  });
  return { executions, executionStore, store, service, admissions, budgets, advance };
}

/** Distinct create keys per driveToRunning call (distinct identities). */
let driven = 0;

async function driveToRunning(world: World): Promise<string> {
  driven += 1;
  const created = await world.executions.createExecution(
    { applicationId: APPLICATION_ID, task: { kind: "summarize", input: "artifact-1" } },
    `create-${APPLICATION_ID}-${driven}`,
    actor,
  );
  const executionId = created.executionId;
  const scope = { ...actor, applicationId: APPLICATION_ID, executionId };
  await world.executions.transition({ ...scope, command: "authorize" }, `authorize-${executionId}`);
  await world.executions.transition({ ...scope, command: "plan" }, `plan-${executionId}`);
  await world.executions.transition({ ...scope, command: "queue" }, `queue-${executionId}`);
  await world.executions.transition({ ...scope, command: "start" }, `start-${executionId}`);
  return executionId;
}

const checkpointOf = (
  executionId: string,
  overrides: Partial<CheckpointContents> = {},
): CheckpointContents => ({
  executionId,
  planId: "plan-1",
  planRevision: 3,
  contextArtifactRefs: ["artifact:ctx/1"],
  lastEventPosition: 5,
  resourceClass: "standard",
  environmentId: null,
  environmentSpecDigest: null,
  requiredCapabilities: ["cap-a"],
  maxCostMicroUsd: null,
  ...overrides,
});

const factsOf = (contents: CheckpointContents): ResumeFacts => ({
  planId: contents.planId,
  planRevision: contents.planRevision,
  resourceClass: contents.resourceClass,
  environmentId: contents.environmentId,
  environmentSpecDigest: contents.environmentSpecDigest,
  requiredCapabilities: contents.requiredCapabilities,
  maxCostMicroUsd: contents.maxCostMicroUsd,
});

const acquire = (world: World, executionId: string, ownerId = "worker-1", ttlMs = 60_000) =>
  world.service.acquireLease(
    { applicationId: APPLICATION_ID, executionId, actor, ownerId, ttlMs },
    `lease-${executionId}-${ownerId}`,
  );

const pause = (world: World, executionId: string) =>
  world.service.pauseExecution(
    {
      applicationId: APPLICATION_ID,
      executionId,
      actor,
      worker: { ownerId: "worker-1", epoch: 1 },
      waitKind: "tool",
      checkpoint: checkpointOf(executionId),
    },
    `pause-${executionId}`,
  );

const eventsOf = (world: World, executionId: string, command: string) =>
  world.executionStore.events.filter(
    (event) => event.executionId === executionId && event.command === command,
  );

const expectTyped = async (run: () => Promise<unknown>, code: string) => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe(code);
    return;
  }
  throw new Error(`expected a typed ${code} failure`);
};

// ---------------------------------------------------------------------------
// The static half: the clean tree scans clean; every mutant is flagged.
// ---------------------------------------------------------------------------

describe("discrimination: long-running execution boundaries (WORK-028) — static mutants", () => {
  test("the clean tree scans clean", () => {
    expect(violationsOf(cleanRules())).toEqual([]);
  });

  test("D1: the lease-guard mutant is flagged (stale workers cannot commit side effects)", () => {
    const mutant = mutateService((source) =>
      mutateBodyOf(source, "const commitCheckpoint = async (", (body) =>
        body.replace(
          "await guardLease(input.applicationId, input.executionId, input.worker);",
          "void input.worker;",
        ),
      ),
    );
    expect(violationsOf(mutant)).toContain("lease-guard-removed");
  });

  test("D1b: the worker-transition guard mutant is flagged", () => {
    const mutant = mutateService((source) =>
      source.replace(
        "await guardLease(input.applicationId, input.command.executionId, input.worker);",
        "void input.worker;",
      ),
    );
    expect(violationsOf(mutant)).toContain("worker-transition-guard-removed");
  });

  test("D2: the acquire conflict branch mutant is flagged (lease conflicts fail closed)", () => {
    const mutant = mutateService((source) =>
      source.replace('if (outcome.status === "refused") {', 'if (outcome.status === "never") {'),
    );
    expect(violationsOf(mutant)).toContain("acquire-refused-branch-removed");
  });

  test("D3: the resume lease-arbitration mutant is flagged (concurrent resumes converge)", () => {
    const mutant = mutateService((source) =>
      mutateBodyOf(source, "const resumeExecution = async (", (body) =>
        body.replace("store.acquireLease({", "store.getLease({"),
      ),
    );
    expect(violationsOf(mutant)).toContain("resume-lease-arbitration-removed");
  });

  test("D4: the checkpoint integrity-check mutant is flagged (tampering rejected)", () => {
    const mutant = mutateService((source) =>
      source.replace(
        "const integrityFailure = checkpointIntegrityFailure(checkpoint, digest);",
        "const integrityFailure = null;",
      ),
    );
    expect(violationsOf(mutant)).toContain("integrity-check-removed");
  });

  test("D5: the plan-revision compatibility mutant is flagged (incompatible revisions rejected)", () => {
    const mutant = mutateService((source) =>
      source.replace(
        "const incompatibility = checkpointIncompatibility(checkpoint.contents, input.resumeFacts);",
        "const incompatibility = null;",
      ),
    );
    expect(violationsOf(mutant)).toContain("compatibility-check-removed");
  });

  test("D6: the materiality-branch mutant is flagged (changed resumes re-enter admission)", () => {
    const mutant = mutateService((source) =>
      source.replace(
        "const materialChange = materialChangeBetween(checkpoint.contents, input.resumeFacts);",
        "const materialChange: MaterialChangeDimension[] = [];",
      ),
    );
    expect(violationsOf(mutant)).toContain("materiality-branch-removed");
  });

  test("D6b: the policy re-admission removal mutant is flagged", () => {
    const mutant = mutateService((source) =>
      source.replace(
        "const policy = await resumePolicyReadmission.readmit(request);",
        "const policy = { allowed: true as const };",
      ),
    );
    expect(violationsOf(mutant)).toContain("policy-readmission-removed");
  });

  test("D7: the journal-after-act interruption mutant is flagged (evidence before the move)", () => {
    // Reorder WITHIN the interruption body: move the request evidence
    // AFTER the force-release (the weakened journal-then-act order).
    const mutant = mutateService((source) =>
      mutateBodyOf(source, "const requestInterruption = async (", (body) => {
        const evidenceStart = body.indexOf('command: "interruption-requested"');
        expect(evidenceStart).toBeGreaterThan(-1);
        const callStart = body.lastIndexOf("await recordEvidence(", evidenceStart);
        const requestedKey = body.indexOf(`\`\${operationKey}:requested\``, evidenceStart);
        expect(requestedKey).toBeGreaterThan(-1);
        const callEnd = body.indexOf(");", requestedKey) + 2;
        const block = body.slice(callStart, callEnd);
        const releaseAnchor = "const released = await store.forceReleaseLease({";
        const releaseAt = body.indexOf(releaseAnchor);
        expect(releaseAt).toBeGreaterThan(-1);
        const without = body.slice(0, callStart) + body.slice(callEnd);
        const releaseInWithout = without.indexOf(releaseAnchor);
        // Insert AFTER the whole force-release statement (both the wake
        // supersede and the force-release now precede the evidence).
        const releaseEnd = without.indexOf("});", releaseInWithout) + 3;
        return `${without.slice(0, releaseEnd)}\n    ${block}${without.slice(releaseEnd)}`;
      }),
    );
    // The evidence now lands AFTER both the wake supersede and the
    // force-release — the journal-after-act weakening is flagged.
    expect(violationsOf(mutant)).toContain("journal-after-act:wake-supersede");
    expect(violationsOf(mutant)).toContain("journal-after-act:lease-force-release");
  });

  test("D8: the identity-creation mutant is flagged (a second identity is unrepresentable)", () => {
    const mutant = mutateService((source) =>
      source.replace(
        'const record = await beginOperation(\n      "resume",',
        `const rerun = await executions.createExecution({}, \`re-\${input.executionId}\`, { actorId: input.actor.actorId, tenantId: input.actor.tenantId });\n    void rerun;\n    const record = await beginOperation(\n      "resume",`,
      ),
    );
    expect(violationsOf(mutant)).toContain("identity-creation-added");
  });

  test("D9: the port-authority mutant is flagged (no second execution authority)", () => {
    const mutant = mutatePort((port) =>
      port.replace(
        "  beginOperation(input: BeginOperationInput): Promise<BeginOperationOutcome>;",
        "  beginOperation(input: BeginOperationInput): Promise<BeginOperationOutcome>;\n  setExecutionStatus(executionId: string, status: string): Promise<void>;",
      ),
    );
    expect(violationsOf(mutant)).toContain("port-authority-added:setExecutionStatus");
  });

  test("D10: the denial-durability mutant is flagged (policy denial is journaled + durable)", () => {
    const mutant = mutateService((source) =>
      mutateBodyOf(source, "const resumeExecution = async (", (body) =>
        body.replace(
          `await store.failOperation(\n          input.applicationId,\n          operationKey,\n          \`resume re-admission denied: \${policy.reason ?? "policy authority denial"}\`,`,
          "void operationKey;",
        ),
      ),
    );
    expect(violationsOf(mutant)).toContain("denial-not-durable");
  });

  test("D11: the probe-order mutant is flagged (committed-effect probe before the lease guard)", () => {
    const mutant = mutateService((source) =>
      mutateBodyOf(source, "const commitCheckpoint = async (", (body) => {
        const probeCall = "const committed = await store.findCheckpointByDigest(";
        const probeStart = body.indexOf(probeCall);
        expect(probeStart).toBeGreaterThan(-1);
        const probeEnd = body.indexOf(");", probeStart) + 2;
        const probeBlock = body.slice(probeStart, probeEnd);
        const without = body.slice(0, probeStart) + body.slice(probeEnd);
        const guardAnchor =
          "await guardLease(input.applicationId, input.executionId, input.worker);";
        const guardAt = without.indexOf(guardAnchor);
        expect(guardAt).toBeGreaterThan(-1);
        // Insert the probe AFTER the guard (the inverted order).
        const guardEnd = guardAt + guardAnchor.length;
        return `${without.slice(0, guardEnd)}\n      ${probeBlock}${without.slice(guardEnd)}`;
      }),
    );
    expect(violationsOf(mutant)).toContain("probe-order-inverted");
  });

  test("D12: the migration guard mutants are flagged (the physical discipline)", () => {
    const noGate = mutateMigration((sql) =>
      sql.replace("CREATE TRIGGER lr_checkpoint_sequence_gate\n", ""),
    );
    expect(violationsOf(noGate)).toContain("migration-sequence-gate-removed");
    const noConvergence = mutateMigration((sql) =>
      sql.replace(
        "IF existing_digest = NEW.content_digest THEN RETURN NEW;",
        "IF FALSE THEN RETURN NEW;",
      ),
    );
    expect(violationsOf(noConvergence)).toContain("migration-convergence-branch-removed");
    const noLeaseGuards = mutateMigration((sql) =>
      sql.replace("CREATE TRIGGER lr_lease_guards\n", ""),
    );
    expect(violationsOf(noLeaseGuards)).toContain("migration-lease-guards-removed");
    const noEpochGuard = mutateMigration((sql) =>
      sql.replace("lease epoch must not regress", "lease epoch may regress"),
    );
    expect(violationsOf(noEpochGuard)).toContain("migration-epoch-regression-guard-removed");
    const noStoreEpoch = mutateStoreSql((sql) => sql.replace("epoch = epoch + 1", "epoch = epoch"));
    expect(violationsOf(noStoreEpoch)).toContain("store-epoch-monotonicity-removed");
    const noOpsLifecycle = mutateMigration((sql) =>
      sql.replace("CREATE TRIGGER lr_ops_lifecycle_guard\n", ""),
    );
    expect(violationsOf(noOpsLifecycle)).toContain("migration-ops-lifecycle-removed");
    const noStableKey = mutateMigration((sql) =>
      sql.replace("lr_ops_key_unique", "lr_ops_key_not_unique"),
    );
    expect(violationsOf(noStableKey)).toContain("migration-ops-stable-key-removed");
    const noIdentityBinding = mutateMigration((sql) =>
      sql.replace("lr_lease_execution_fk", "lr_lease_execution_not_fk"),
    );
    expect(violationsOf(noIdentityBinding)).toContain("migration-identity-binding-removed");
  });
});

// ---------------------------------------------------------------------------
// The runtime half: the negative records stay red.
// ---------------------------------------------------------------------------

describe("discrimination: long-running execution boundaries (WORK-028) — runtime reds", () => {
  test("R1: stale workers cannot commit side effects (expired / foreign / superseded) — typed failure, ZERO writes", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    // EXPIRED: the lease TTL passes inside the crash/downtime window.
    world.advance(120_000);
    await expectTyped(
      () =>
        world.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            contents: checkpointOf(executionId),
          },
          `ck-${executionId}`,
        ),
      "EXPIRED",
    );
    expect(world.store.checkpoints.size).toBe(0); // ZERO side effects
    expect(eventsOf(world, executionId, "checkpoint-recorded")).toHaveLength(0);
    // A new owner takes over (epoch 2): the STALE worker-1/epoch-1 claim
    // is superseded forever.
    await acquire(world, executionId, "worker-2");
    await expectTyped(
      () =>
        world.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-1", epoch: 1 },
            contents: checkpointOf(executionId),
          },
          `ck2-${executionId}`,
        ),
      "INVALID_STATE_TRANSITION",
    );
    // FOREIGN: a third worker neither stale nor owner.
    await expectTyped(
      () =>
        world.service.recordCheckpoint(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            worker: { ownerId: "worker-3", epoch: 2 },
            contents: checkpointOf(executionId),
          },
          `ck3-${executionId}`,
        ),
      "INVALID_STATE_TRANSITION",
    );
    expect(world.store.checkpoints.size).toBe(0); // still ZERO
  });

  test("R2: a live lease conflict FAILS CLOSED — typed refusal, the lease unchanged", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    const first = await acquire(world, executionId, "worker-1");
    expect(first.lease.epoch).toBe(1);
    await expectTyped(() => acquire(world, executionId, "worker-2"), "INVALID_STATE_TRANSITION");
    const lease = world.store.leases.get(executionId);
    expect(lease).toMatchObject({ ownerId: "worker-1", epoch: 1 }); // unchanged
  });

  test("R3: N=8 concurrent resumes converge — ONE authoritative resumption, 7 typed conflicts, ONE transition", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await pause(world, executionId);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        world.service
          .resumeExecution(
            {
              applicationId: APPLICATION_ID,
              executionId,
              actor,
              resumeFacts: factsOf(checkpointOf(executionId)),
              worker: { ownerId: `resumer-${i}`, ttlMs: 60_000 },
            },
            `race-${i}`,
          )
          .then((outcome) => ({
            ok: true as const,
            status: outcome.status,
            replayed: outcome.replayed,
          }))
          .catch((error: PlatformError) => ({ ok: false as const, code: error.code })),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1); // ONE winner
    expect((results.find((r) => r.ok) as { status: string }).status).toBe("RUNNING");
    for (const loser of results.filter((r) => !r.ok)) {
      expect(loser.code).toBe("INVALID_STATE_TRANSITION"); // conflicts fail closed
    }
    // Zero duplicate side effects: ONE resume transition, ONE owner.
    expect(eventsOf(world, executionId, "resume")).toHaveLength(1);
    expect(world.store.leases.get(executionId)?.ownerId).toMatch(/^resumer-\d$/);
  });

  test("R4: a tampered checkpoint digest is rejected typed (integrity)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await pause(world, executionId);
    // Tamper the durable row's content digest (corruption/bit-rot class).
    const key = [...world.store.checkpoints.keys()].find(
      (k) => world.store.checkpoints.get(k)?.executionId === executionId,
    );
    expect(key).toBeDefined();
    const row = world.store.checkpoints.get(key as string) as CheckpointRecord;
    world.store.checkpoints.set(key as string, {
      ...row,
      contentDigest: digest(`${row.contentDigest}:tampered`),
    });
    await expectTyped(
      () =>
        world.service.resumeExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            resumeFacts: factsOf(checkpointOf(executionId)),
          },
          `resume-${executionId}`,
        ),
      "INVALID_STATE_TRANSITION",
    );
    expect(world.executionStore.executions.get(executionId)?.status).toBe("WAITING_TOOL"); // never resumed
  });

  test("R5: an incompatible (stale downgrade) plan revision is rejected typed", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await pause(world, executionId);
    // The checkpoint was recorded at revision 3; revision 2 is a stale
    // DOWNGRADE (incompatible — a higher revision is a legitimate
    // materially-changed resume that re-enters admission instead).
    await expectTyped(
      () =>
        world.service.resumeExecution(
          {
            applicationId: APPLICATION_ID,
            executionId,
            actor,
            resumeFacts: factsOf(checkpointOf(executionId, { planRevision: 2 })),
          },
          `resume-${executionId}`,
        ),
      "INVALID_STATE_TRANSITION",
    );
    expect(world.executionStore.executions.get(executionId)?.status).toBe("WAITING_TOOL");
  });

  test("R6: materially changed facts re-enter admission; unchanged facts never re-consult", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await pause(world, executionId);
    // UNCHANGED resume: zero authority consultations.
    const unchanged = await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `resume-unchanged`,
    );
    expect(unchanged.readmitted).toBe(false);
    expect(world.admissions.policyCalls).toHaveLength(0);
    expect(world.admissions.resourceCalls).toHaveLength(0);
    // MATERIALLY CHANGED (resource class + cost bound): both axes consulted.
    const changedFacts = factsOf(
      checkpointOf(executionId, { resourceClass: "premium", maxCostMicroUsd: "500000" }),
    );
    const changed = await world.service.resumeExecution(
      { applicationId: APPLICATION_ID, executionId, actor, resumeFacts: changedFacts },
      `resume-changed`,
    );
    expect(changed.readmitted).toBe(true);
    expect(world.admissions.policyCalls).toHaveLength(1);
    expect(world.admissions.resourceCalls).toHaveLength(1);
    expect(world.budgets.reserveCalls).toHaveLength(1); // the cost axis reserved
  });

  test("R7: human interruption is authoritative and auditable — WAITING_HUMAN, lease force-released, wakes superseded, evidence first", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await world.service.pauseExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        worker: { ownerId: "worker-1", epoch: 1 },
        waitKind: "tool",
        checkpoint: checkpointOf(executionId),
        wakeUp: {
          wakeKey: "tool-return",
          cause: "awaiting tool result",
          earliestWakeAt: new Date(Date.parse("2026-09-15T12:00:01Z")).toISOString(),
        },
      },
      `pause-${executionId}`,
    );
    // A SECOND lease-holding execution is interrupted while RUNNING.
    const second = await driveToRunning(world);
    await acquire(world, second, "worker-1");
    const outcome = await world.service.requestInterruption(
      { applicationId: APPLICATION_ID, executionId: second, actor, reason: "operator halt" },
      `interrupt-${second}`,
    );
    expect(outcome.status).toBe("WAITING_HUMAN");
    expect(outcome.leaseReleased).toBe(true);
    expect(world.store.leases.get(second)?.releaseCause).toBe("human-interruption");
    expect(eventsOf(world, second, "interruption-requested")).toHaveLength(1); // auditable
    expect(eventsOf(world, second, "wait-human")).toHaveLength(1);
    // The wake of the FIRST execution is superseded by an interruption
    // too (auto-resume revoked; the schedule never fires).
    const superseded = await world.service.requestInterruption(
      { applicationId: APPLICATION_ID, executionId, actor, reason: "operator halt" },
      `interrupt-${executionId}`,
    );
    expect(superseded.wakeUpsSuperseded).toBe(1);
    expect(world.store.wakeUps.get(`${APPLICATION_ID}|${executionId}|tool-return`)?.status).toBe(
      "superseded",
    );
    // The superseded wake never fires.
    world.advance(60_000);
    const applied = await world.service.applyWakeUps({ applicationId: APPLICATION_ID, actor });
    expect(applied.applications).toHaveLength(0);
  });

  test("R8: the execution identity is unchanged across pause/resume (never a second identity)", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    const paused = await pause(world, executionId);
    expect(paused.executionId).toBe(executionId);
    const resumed = await world.service.resumeExecution(
      {
        applicationId: APPLICATION_ID,
        executionId,
        actor,
        resumeFacts: factsOf(checkpointOf(executionId)),
      },
      `resume-${executionId}`,
    );
    expect(resumed.executionId).toBe(executionId);
    expect(resumed.checkpointId).toBe(paused.checkpointId); // the same checkpoint
    expect(world.executionStore.executions.size).toBe(1); // ONE execution row, ever
  });

  test("R10: a policy denial blocks resume side effects — typed failure, durable replay, zero resume transitions", async () => {
    const world = createWorld();
    const executionId = await driveToRunning(world);
    await acquire(world, executionId, "worker-1");
    await pause(world, executionId);
    world.admissions.denyPolicy = true;
    const changedFacts = factsOf(checkpointOf(executionId, { maxCostMicroUsd: "500000" }));
    await expectTyped(
      () =>
        world.service.resumeExecution(
          { applicationId: APPLICATION_ID, executionId, actor, resumeFacts: changedFacts },
          `denied-${executionId}`,
        ),
      "POLICY_DENIED",
    );
    expect(world.executionStore.executions.get(executionId)?.status).toBe("WAITING_TOOL"); // zero side effects
    expect(eventsOf(world, executionId, "resume")).toHaveLength(0);
    expect(eventsOf(world, executionId, "resume-denied")).toHaveLength(1); // journaled once
    // The denial is DURABLE: the same key replays typed forever.
    await expectTyped(
      () =>
        world.service.resumeExecution(
          { applicationId: APPLICATION_ID, executionId, actor, resumeFacts: changedFacts },
          `denied-${executionId}`,
        ),
      "POLICY_DENIED",
    );
    expect(eventsOf(world, executionId, "resume-denied")).toHaveLength(1);
    expect(eventsOf(world, executionId, "resume")).toHaveLength(0);
  });
});
