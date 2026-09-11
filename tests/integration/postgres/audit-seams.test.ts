/**
 * Real-PostgreSQL seam observation tests (WORK-059 / SEC-004;
 * checkpoints EXECUTION-PROVENANCE + DEPENDENCY-DIRECTION over the
 * real fabric).
 *
 * Proves the FULL observation chain over the REAL authorities:
 *
 *  - the executions seam observer wraps the REAL execution service
 *    (SQL store + idempotency ledger over the real database) and
 *    records `execution.created` + `execution.transitioned` evidence
 *    with exact provenance (the execution identity is the source
 *    record identity — replayable);
 *  - a RETRIED transition after a projection failure converges: the
 *    authority's idempotency replays the durable outcome, the audit
 *    identity converges, exactly ONE evidence record exists;
 *  - the policy admission observer wraps the REAL policy authority
 *    (policies module over the in-memory policy store — the
 *    executions authorize seam shape) and records `policy.decision`
 *    evidence with the exact policy-set provenance (id, version,
 *    content hash), while the verdict passes through verbatim;
 *  - the decision-record seam observer wraps the REAL
 *    SqlOptimizationDecisionStore (the E1.1 append-only evidence
 *    authority) and records `decision.recorded` evidence keyed by the
 *    decision's own content identity;
 *  - the observed audit chain verifies end-to-end over the real
 *    database (deterministic verdict).
 */

import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import { createObservingAdmission } from "../../../src/modules/audit/adapters/observing-authorization";
import { createObservingDecisionStore } from "../../../src/modules/audit/adapters/observing-decision-store";
import { createObservingExecutionService } from "../../../src/modules/audit/adapters/observing-execution-service";
import { SqlAuditStore } from "../../../src/modules/audit/adapters/sql-audit-store";
import { AuditProjectionError, createAuditService } from "../../../src/modules/audit/public";
import { createIrPlanSource } from "../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../../src/modules/planning/public";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicySet,
} from "../../../src/modules/policies/public";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import type { CandidateRepresentation } from "../../../src/platform/execution-ir/cost-model";
import { buildOptimizationDecision } from "../../../src/platform/execution-ir/decision-record";
import { SqlOptimizationDecisionStore } from "../../../src/platform/execution-ir/decision-store";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
import {
  ACTOR_ID,
  baseCreateInput,
  type ExecutionsWorld,
  seedExecutionsWorld,
} from "./executions-world";
import { definePgSuite } from "./harness";

const digest = createAuditNodeDigest();
const planDigest = createNodeDigest();
const planSource = createIrPlanSource();
const NOW = () => new Date("2026-09-20T12:00:00.000Z");

function auditServiceOver(db: ExecutionsWorld["db"]) {
  const store = new SqlAuditStore(db, digest, NOW);
  return { store, audit: createAuditService({ store, digest }) };
}

definePgSuite("audit seam observation over the real authorities (real PostgreSQL)", (ctx) => {
  test("the executions seam observer records created/transitioned evidence with exact provenance", async () => {
    const base = await seedExecutionsWorld(ctx.port);
    const { store, audit } = auditServiceOver(base.db);
    const observing = createObservingExecutionService({
      inner: base.service,
      store,
      environment: "production",
      now: NOW,
    });

    const receipt = await observing.createExecution(
      baseCreateInput(base.applicationId),
      "audit-create-1",
      { actorId: ACTOR_ID, tenantId: base.tenantId },
    );
    await observing.transition(
      {
        actorId: ACTOR_ID,
        tenantId: base.tenantId,
        applicationId: base.applicationId,
        executionId: receipt.executionId,
        command: "authorize",
      },
      "audit-auth-1",
    );

    const records = await store.listRecords(base.applicationId);
    expect(records.map((record) => record.action.kind)).toEqual([
      "execution.created",
      "execution.transitioned",
    ]);
    const created = records[0]!;
    // The observed action carries the exact source identity: the
    // execution is the authoritative record (replayable provenance).
    expect(created.target).toEqual({ kind: "execution", id: receipt.executionId });
    expect(created.provenance.sourceRecordId).toBe(receipt.executionId);
    expect(created.action.operationKey).toBe("audit-create-1");
    const transitioned = records[1]!;
    expect(transitioned.actionDetail).toEqual({
      from: "CREATED",
      to: "AUTHORIZED",
      sequence: 2,
    });
    const verification = await audit.verifyChain(base.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("a projection failure after the authority commits fails closed; the RETRY converges to one record", async () => {
    const base = await seedExecutionsWorld(ctx.port);
    const { store, audit } = auditServiceOver(base.db);
    // A failing store: the TRANSITION's evidence append fails once,
    // later attempts recover (the create evidence lands immediately).
    let failures = 0;
    const failing = {
      async appendRecord(submission: Parameters<typeof store.appendRecord>[0]) {
        if (failures === 0 && submission.action.operationKey === "conv-auth-1") {
          failures += 1;
          throw new Error("projection unavailable");
        }
        return store.appendRecord(submission);
      },
      getRecord: (applicationId: string, recordId: string) =>
        store.getRecord(applicationId, recordId),
      listRecords: (applicationId: string, options?: { fromSequence?: number }) =>
        store.listRecords(applicationId, options),
      chainHead: (applicationId: string) => store.chainHead(applicationId),
      purgeExpiredRecords: (input: Parameters<typeof store.purgeExpiredRecords>[0]) =>
        store.purgeExpiredRecords(input),
      listPurgeManifests: (
        applicationId: string,
        window: { fromSequence: number; toSequence: number },
      ) => store.listPurgeManifests(applicationId, window),
    };
    const observing = createObservingExecutionService({
      inner: base.service,
      store: failing,
      environment: "production",
      now: NOW,
    });
    const command = {
      actorId: ACTOR_ID,
      tenantId: base.tenantId,
      applicationId: base.applicationId,
      executionId: "",
      command: "authorize",
    } as {
      actorId: string;
      tenantId: string;
      applicationId: string;
      executionId: string;
      command: "authorize";
    };

    // Create through the healthy path.
    const receipt = await observing.createExecution(
      baseCreateInput(base.applicationId),
      "conv-create-1",
      { actorId: ACTOR_ID, tenantId: base.tenantId },
    );
    command.executionId = receipt.executionId;

    // The authority commits the transition; the projection fails →
    // the caller sees the typed fail-closed error.
    await expect(observing.transition(command, "conv-auth-1")).rejects.toBeInstanceOf(
      AuditProjectionError,
    );

    // The retry: the authority REPLAYS the durable outcome (same
    // from/to), the projection converges — exactly ONE evidence
    // record for the logical action.
    const outcome = await observing.transition(command, "conv-auth-1");
    expect(outcome.replayed).toBe(true);
    const records = await store.listRecords(base.applicationId);
    const transitionEvidence = records.filter(
      (record) => record.action.kind === "execution.transitioned",
    );
    expect(transitionEvidence).toHaveLength(1);
    expect(transitionEvidence[0]?.actionDetail).toEqual({
      from: "CREATED",
      to: "AUTHORIZED",
      sequence: 2,
    });
    const verification = await audit.verifyChain(base.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("the admission observer wraps the REAL policy authority; verdicts pass through with policy provenance", async () => {
    const base = await seedExecutionsWorld(ctx.port);
    const { store, audit } = auditServiceOver(base.db);

    const policyStore = new InMemoryPolicyStore();
    const authority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
    const policySet: PolicySet = {
      id: "default",
      version: 1,
      documents: [
        {
          scope: "platform",
          selector: {},
          restrictions: {
            cost: { maxCostMicroUsd: "10000000" },
            quality: { minQuality: 0.5 },
            latency: { maxLatencyMs: 60000 },
          },
        },
      ],
    };
    await authority.publish(policySet);
    // The REAL executions-authorize seam adapter (policies module
    // public contract) — my observer wraps it; the authority's verdict
    // and admission evidence pass through verbatim.
    const authorization = createObservingAdmission({
      inner: createExecutionAuthorization(authority),
      store,
      environment: "production",
      command: "authorize",
      now: NOW,
    });

    const receipt = await base.service.createExecution(
      baseCreateInput(base.applicationId),
      "pol-create-1",
      { actorId: ACTOR_ID, tenantId: base.tenantId },
    );
    const execution = await base.service.getExecution(base.applicationId, receipt.executionId);
    expect(execution).not.toBeNull();
    const verdict = await authorization.evaluate({
      execution: {
        id: execution!.id,
        applicationId: execution!.applicationId,
        tenantId: execution!.tenantId,
        status: execution!.status,
        userId: execution!.userId,
        task: execution!.task,
        constraints: execution!.constraints,
      },
      actorId: ACTOR_ID,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.evidence?.policySetVersion).toBe(1);

    const records = await store.listRecords(base.applicationId);
    expect(records.map((record) => record.action.kind)).toEqual(["policy.decision"]);
    const decision = records[0]!;
    expect(decision.rationale.policyContext).toMatchObject({
      policySetId: "default",
      policySetVersion: 1,
      policyContentHash: verdict.evidence?.policyContentHash,
      restrictionSetDigest: verdict.evidence?.restrictionSetDigest,
    });
    expect(decision.actionDetail).toEqual({ allowed: true, executionStatus: "CREATED" });
    const verification = await audit.verifyChain(base.applicationId);
    expect(verification.ok).toBe(true);
  });

  test("the decision-store observer wraps the REAL optimization decision store", async () => {
    const base = await seedExecutionsWorld(ctx.port);
    const { store, audit } = auditServiceOver(base.db);
    const decisionStore = new SqlOptimizationDecisionStore(ctx.port, digest, randomUUID);
    const observing = createObservingDecisionStore({
      inner: decisionStore,
      store,
      environment: "production",
      now: NOW,
    });

    // A REAL optimization decision record (the WORK-049 evidence
    // contract): governed plan -> derived IR -> decision.
    const plan = buildPlan(
      {
        revision: 2,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch-docs", stepClass: "retrieve", capabilityId: "document-retrieval" },
          {
            id: "summarize",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
          },
          { id: "check-output", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "fetch-docs", to: "summarize" },
          { from: "summarize", to: "check-output" },
        ],
      },
      (value) => planDigest.sha256Hex(canonicalJson(value)),
    );
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(plan), digest);
    const candidates: readonly CandidateRepresentation[] = [
      {
        candidateId: "deterministic-run",
        representationClass: "deterministic-computation",
        claim: {
          expectedCostMicroUsd: "20000",
          expectedLatencyMs: 200,
          expectedQuality: 0.95,
          expectedReliability: 1,
          basis: { basis: "observed", source: "learning.telemetry" },
        },
      },
    ];
    const record = buildOptimizationDecision(
      {
        applicationId: base.applicationId,
        tenantId: base.tenantId,
        executionId: undefined,
        ir,
        constraints: [
          {
            constraintId: "verification-anchor",
            kind: "verification",
            enforcement: "hard",
            source: { authority: "verification" },
            payload: { requiresVerificationAnchor: true },
          },
        ],
        candidates,
        qualityThreshold: 0.9,
        selectedCandidateId: "deterministic-run",
        transformationBasis: {
          code: "identity",
          detail:
            "The governed plan's model route is the base representation; verification anchor preserved.",
        },
        recordedAt: "2026-09-20T12:00:00.000Z",
      },
      digest,
    );

    const outcome = await observing.append(record);
    expect(outcome).toEqual({ decisionId: record.decisionId, replayed: false });

    const records = await store.listRecords(base.applicationId);
    expect(records.map((record_) => record_.action.kind)).toEqual(["decision.recorded"]);
    const evidence = records[0]!;
    expect(evidence.target).toEqual({ kind: "decision", id: record.decisionId });
    expect(evidence.provenance.seam).toBe("optimization-decisions");
    expect(evidence.actionDetail).toEqual({
      planId: record.planId,
      irId: record.irId,
      selectedCandidateId: "deterministic-run",
      transformationBasisCode: "identity",
    });
    const verification = await audit.verifyChain(base.applicationId);
    expect(verification.ok).toBe(true);
  });
});
