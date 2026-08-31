/**
 * Shared real-PostgreSQL fixture for the verification suites (WORK-013).
 *
 * Seeds a tenant + application and wires the FULL verification fabric over
 * the provider-neutral DatabasePort — the production composition:
 *
 *   * executions: SqlExecutionStore + SqlExecutionsIdempotency + the
 *     execution service, with the REAL policy authority behind the
 *     authorize seam (createExecutionAuthorization) — seeded executions
 *     can be driven to any lifecycle status through the REAL single
 *     write path (including WAITING_HUMAN / REPLANNING);
 *   * policies: the REAL authority (in-memory definitions + node hasher)
 *     behind the verification admission seam
 *     (createPolicyVerificationAdmission);
 *   * verification: SqlVerificationStore (migration 0007) + the governed
 *     service with the execution ledger/transition adapters (the
 *     canonical evidence path), the deterministic evaluator bank, a
 *     SCRIPTED model judge (the transport fake — the production adapter
 *     dispatches through the models public gateway; the judge port is
 *     the seam), an optional recording replanning boundary, and the
 *     artifact/plan-revision target resolvers over the REAL artifacts
 *     service and the REAL executions ledger;
 *   * artifacts: the REAL artifact service (in-memory content-addressed
 *     store — the artifacts module's own durable-surface decision) for
 *     artifact-target resolution proofs.
 */

import { createInMemoryArtifactStore } from "../../../src/modules/artifacts/adapters/in-memory-artifact-store";
import { createNodeDigestPort } from "../../../src/modules/artifacts/adapters/node-digest";
import { type ArtifactService, createArtifactService } from "../../../src/modules/artifacts/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../../../src/modules/executions/adapters/sql-execution-store";
import {
  createExecutionService,
  type ExecutionService,
} from "../../../src/modules/executions/application/execution-service";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../../src/modules/policies/public";
import { createDeterministicEvaluatorBank } from "../../../src/modules/verification/adapters/deterministic-evaluators";
import {
  createExecutionLedgerAdapter,
  createExecutionTransitionAdapter,
} from "../../../src/modules/verification/adapters/execution-ledger";
import { createModelJudgeEvaluator } from "../../../src/modules/verification/adapters/model-judge-evaluator";
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
import type { ReplanningDecision } from "../../../src/modules/verification/domain/conclusion";
import type { ModelJudgment } from "../../../src/modules/verification/ports/model-judge";
import type { ReplanningBoundary } from "../../../src/modules/verification/ports/replanning-boundary";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";

export const generateId = createUuidv7Generator();
export const ACTOR_ID = "00000000-0000-7000-8000-0000000000bb";

/** A scripted model judge (the transport fake behind the judge port). */
export class ScriptedModelJudge {
  judgment: (request: unknown) => ModelJudgment;
  readonly requests: unknown[] = [];

  constructor() {
    this.judgment = () => ({
      criterionId: "",
      meetsCriteria: "unknown",
      rationale: "scripted",
      judgeIdentity: {},
    });
  }

  async judge(request: unknown): Promise<ModelJudgment> {
    this.requests.push(request);
    return this.judgment(request);
  }
}

export interface VerificationPgWorld {
  readonly db: DatabasePort;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionService: ExecutionService;
  readonly policyStore: InMemoryPolicyStore;
  readonly policyAuthority: PolicyAuthority;
  readonly verificationService: VerificationService;
  readonly verificationStore: SqlVerificationStore;
  readonly modelJudge: ScriptedModelJudge;
  readonly artifacts: ArtifactService;
  readonly replanningDecisions: ReplanningDecision[];
  actor(): { actorId: string; tenantId: string };
  seedExecution(status?: string): Promise<string>;
}

export async function seedVerificationWorld(db: DatabasePort): Promise<VerificationPgWorld> {
  const tenantId = generateId();
  const applicationId = generateId();
  await db.execute({
    sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
    parameters: [tenantId, `t-${tenantId.slice(-6)}`, "verification tenant"],
  });
  await db.execute({
    sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
    parameters: [applicationId, tenantId, `a-${applicationId.slice(-6)}`, "verification app"],
  });

  // Policies: the REAL authority behind the verification admission seam.
  const policyStore = new InMemoryPolicyStore();
  const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  // Executions: full SQL fabric, policy-gated authorize.
  const executionService = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization: (
      await import("../../../src/modules/policies/public")
    ).createExecutionAuthorization(authority),
    generateId,
    now: () => new Date(),
  });

  // Artifacts: the REAL service for artifact-target resolution.
  const artifacts = createArtifactService({
    store: createInMemoryArtifactStore(),
    digest: createNodeDigestPort(),
  });

  // The scripted model judge (transport fake behind the judge port).
  const modelJudge = new ScriptedModelJudge();

  // The recording replanning boundary (the planner-side seam fake).
  const replanningDecisions: ReplanningDecision[] = [];
  const replanning: ReplanningBoundary = {
    onVerificationOutcome: async (outcome) => {
      const decision: ReplanningDecision = outcome.requiredUnmet.some(
        (entry) => entry.status === "INCONCLUSIVE",
      )
        ? { decision: "escalate-human", detail: "uncertainty needs a human" }
        : { decision: "replan", detail: "demonstrated failure — replan" };
      replanningDecisions.push(decision);
      return decision;
    },
  };

  const verificationStore = new SqlVerificationStore(db);
  const verificationService = createVerificationService({
    store: verificationStore,
    admission: createPolicyVerificationAdmission(authority),
    ledger: createExecutionLedgerAdapter(executionService),
    transitions: createExecutionTransitionAdapter(executionService),
    replanning,
    evaluators: [
      ...createDeterministicEvaluatorBank(),
      createModelJudgeEvaluator({
        judge: async (request) => modelJudge.judge(request),
      }),
    ],
    resolvers: {
      artifact: createArtifactTargetResolver(artifacts),
      "plan-revision": createPlanRevisionResolver(executionService),
    },
    generateId,
    now: () => new Date(),
    hashInput: (text) => {
      // Deterministic content digest (sha256 via node:crypto through the
      // injected adapter seam — the adapter layer owns crypto).
      return createNodeDigestPort().sha256Hex(`verification:${text}`);
    },
  });

  const actor = () => ({ actorId: ACTOR_ID, tenantId });

  const world: VerificationPgWorld = {
    db,
    tenantId,
    applicationId,
    executionService,
    policyStore,
    policyAuthority: authority,
    verificationService,
    verificationStore,
    modelJudge,
    artifacts,
    replanningDecisions,
    actor,
    async seedExecution(status = "RUNNING") {
      const receipt = await executionService.createExecution(
        { applicationId, task: { kind: "verify-me", input: "in-1" } },
        `create-${generateId()}`,
        actor(),
      );
      const executionId = receipt.executionId;
      const step = async (command: string) =>
        executionService.transition(
          {
            command: command as never,
            applicationId,
            tenantId,
            executionId,
            actorId: ACTOR_ID,
          } as never,
          `${command}-${generateId()}`,
        );
      if (status !== "CREATED") {
        await step("authorize");
        if (status !== "AUTHORIZED") {
          await step("plan");
          if (status !== "PLANNING") {
            await step("queue");
            if (status !== "QUEUED") {
              await step("start");
              if (status === "WAITING_HUMAN") {
                await step("wait-human");
              } else if (status === "WAITING_USER") {
                await step("wait-user");
              } else if (status === "VERIFYING") {
                await step("verify");
              }
            }
          }
        }
      }
      return executionId;
    },
  };

  return world;
}
