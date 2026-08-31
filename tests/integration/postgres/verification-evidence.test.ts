/**
 * Real-PostgreSQL: verification evidence surfaces (WORK-013; artifact and
 * plan-revision targets, candidate comparison, and the
 * revision/staleness discipline).
 *
 * Proves over real PostgreSQL:
 *   * artifact verification with the REAL artifacts service —
 *     content-addressed identity in the caller's tenant namespace; a
 *     wrong-tenant or unknown digest fails closed (M11);
 *   * plan-revision verification bound to the REAL executions ledger's
 *     planning decisions — an unrecorded revision fails closed, and a
 *     stale PASS for an older revision never satisfies the current one
 *     (M12);
 *   * candidate comparison: planner-gated, criteria-bound,
 *     identity-preserving, decisive only when the criteria select ONE
 *     winner — INCONCLUSIVE under unresolved uncertainty, never a
 *     forced pick (M16/M22, VER-004);
 *   * comparison and target evidence ride the canonical ledger.
 */

import { expect, test } from "vitest";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";
import { seedVerificationWorld, type VerificationPgWorld } from "./verification-world";

const generateId = createUuidv7Generator();

definePgSuite("verification evidence surfaces (real PG)", (ctx) => {
  interface Seeded {
    readonly world: VerificationPgWorld;
  }

  async function seed(): Promise<Seeded> {
    return { world: await seedVerificationWorld(ctx.port) };
  }

  test("artifact verification resolves through the REAL artifacts service in tenant scope (M11)", async () => {
    const { world } = await seed();
    await world.verificationService.declareCriteria({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      criteria: {
        criterionId: "artifact-schema",
        version: 1,
        kind: "schema",
        required: true,
        description: "the artifact payload satisfies the schema",
        definition: { fields: [{ name: "rows", type: "number", required: true }] },
      },
    });
    const executionId = await world.seedExecution("RUNNING");

    // Put a real artifact (content-addressed identity).
    const put = await world.artifacts.putArtifact({
      tenantId: world.tenantId,
      kind: "task-output",
      payload: { rows: 10 },
      parents: [],
      sourceRefs: [],
    });
    const digest = put.record.digest;

    const conclusion = await world.verificationService.verifyTarget(
      {
        applicationId: world.applicationId,
        executionId,
        actor: world.actor(),
        target: { kind: "artifact", ref: digest, revision: digest },
        criteria: [{ criterionId: "artifact-schema", version: 1 }],
        evidence: { facts: { rows: 10 }, evidenceRefs: [`artifact:${digest}`] },
      },
      `key-${generateId().slice(-8)}`,
    );
    expect(conclusion.criteriaMet).toBe(true);
    const results = await world.verificationService.listResults(world.applicationId, executionId);
    expect(results[0]?.target.kind).toBe("artifact");
    expect(results[0]?.target.revision).toBe(digest);
  });

  test("a foreign-tenant artifact digest fails closed (M11)", async () => {
    const { world } = await seed();
    await world.verificationService.declareCriteria({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      criteria: {
        criterionId: "artifact-schema",
        version: 1,
        kind: "schema",
        required: true,
        description: "the artifact payload satisfies the schema",
        definition: { fields: [{ name: "rows", type: "number", required: true }] },
      },
    });
    const executionId = await world.seedExecution("RUNNING");
    // Put the artifact in ANOTHER tenant's namespace.
    const foreignTenant = generateId();
    const foreign = await world.artifacts.putArtifact({
      tenantId: foreignTenant,
      kind: "task-output",
      payload: { rows: 10 },
      parents: [],
      sourceRefs: [],
    });
    await expect(
      world.verificationService.verifyTarget(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          target: { kind: "artifact", ref: foreign.record.digest },
          criteria: [{ criterionId: "artifact-schema", version: 1 }],
          evidence: { facts: { rows: 10 }, evidenceRefs: ["artifact:x"] },
        },
        `key-${generateId().slice(-8)}`,
      ),
    ).rejects.toThrow(/does not resolve in scope|another tenant/);
    expect(
      await world.verificationService.listResults(world.applicationId, executionId),
    ).toHaveLength(0);
  });

  test("plan-revision verification binds to the recorded planning decisions (M12 input half)", async () => {
    const { world } = await seed();
    await world.verificationService.declareCriteria({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      criteria: {
        criterionId: "plan-quality",
        version: 1,
        kind: "invariant",
        required: true,
        description: "the plan meets the quality bar",
        definition: { assertions: [{ path: "score", op: "gte", value: 8 }] },
      },
    });
    const executionId = await world.seedExecution("PLANNING");
    // Record a REAL planning decision (plan revision v1) on the ledger.
    const planIdV1 = generateId();
    await world.executionService.recordPlanningDecision(
      {
        applicationId: world.applicationId,
        executionId,
        tenantId: world.tenantId,
        actorId: world.actor().actorId,
        decisionId: generateId(),
        planId: planIdV1,
        payload: { selected: "deterministic-first" },
      },
      `decision-${generateId().slice(-8)}`,
    );

    // v1 verifies cleanly.
    const v1 = await world.verificationService.verifyTarget(
      {
        applicationId: world.applicationId,
        executionId,
        actor: world.actor(),
        target: { kind: "plan-revision", ref: planIdV1, revision: planIdV1 },
        criteria: [{ criterionId: "plan-quality", version: 1 }],
        evidence: { facts: { score: 9 }, evidenceRefs: [`plan:${planIdV1}`] },
      },
      `key-${generateId().slice(-8)}`,
    );
    expect(v1.criteriaMet).toBe(true);

    // An UNRECORDED revision fails closed.
    const ghost = generateId();
    await expect(
      world.verificationService.verifyTarget(
        {
          applicationId: world.applicationId,
          executionId,
          actor: world.actor(),
          target: { kind: "plan-revision", ref: ghost, revision: ghost },
          criteria: [{ criterionId: "plan-quality", version: 1 }],
          evidence: { facts: { score: 9 }, evidenceRefs: [`plan:${ghost}`] },
        },
        `key-${generateId().slice(-8)}`,
      ),
    ).rejects.toThrow(/does not resolve in scope|not a recorded planning decision/);

    // Record revision v2 (replan of v1): the v1 PASS is stale for v2.
    const planIdV2 = generateId();
    await world.executionService.recordPlanningDecision(
      {
        applicationId: world.applicationId,
        executionId,
        tenantId: world.tenantId,
        actorId: world.actor().actorId,
        decisionId: generateId(),
        planId: planIdV2,
        replanOf: planIdV1,
        payload: { selected: "deterministic-first", revision: 2 },
      },
      `decision-${generateId().slice(-8)}`,
    );
    const v2 = await world.verificationService.verifyTarget(
      {
        applicationId: world.applicationId,
        executionId,
        actor: world.actor(),
        target: { kind: "plan-revision", ref: planIdV2, revision: planIdV2 },
        criteria: [{ criterionId: "plan-quality", version: 1 }],
        evidence: { facts: { score: 3 }, evidenceRefs: [`plan:${planIdV2}`] },
      },
      `key-${generateId().slice(-8)}`,
    );
    expect(v2.criteriaMet).toBe(false);
    expect(v2.requiredUnmet[0]?.status).toBe("FAIL");
  });

  test("candidate comparison is planner-gated, identity-preserving and honest (VER-004/M16/M22)", async () => {
    const { world } = await seed();
    await world.verificationService.declareCriteria({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      criteria: {
        criterionId: "answer-quality",
        version: 1,
        kind: "invariant",
        required: true,
        description: "the answer meets the quality bar",
        definition: { assertions: [{ path: "score", op: "gte", value: 8 }] },
      },
    });
    const executionId = await world.seedExecution("RUNNING");
    const input = {
      applicationId: world.applicationId,
      executionId,
      actor: world.actor(),
      criterionId: "answer-quality",
      criteriaVersion: 1,
      plannerAuthorization: {
        initiator: "planner" as const,
        decisionRef: `decision-${generateId().slice(-8)}`,
        reason: "bounded comparison justified by planning uncertainty",
      },
    };

    // Decisive: exactly one candidate satisfies the criteria.
    const decisive = await world.verificationService.compareCandidates(
      {
        ...input,
        candidates: [
          { candidateId: "cand-a", evidenceRefs: ["e:a"], facts: { score: 9 } },
          { candidateId: "cand-b", evidenceRefs: ["e:b"], facts: { score: 4 } },
        ],
      },
      `key-${generateId().slice(-8)}`,
    );
    expect(decisive.comparison.status).toBe("PASS");
    expect(decisive.comparison.winner).toBe("cand-a");
    expect(decisive.comparison.candidates.map((candidate) => candidate.candidateId)).toEqual([
      "cand-a",
      "cand-b",
    ]);
    expect(decisive.comparison.plannerAuthorization.decisionRef).toBe(
      input.plannerAuthorization.decisionRef,
    );

    // Non-planner initiation is rejected BEFORE any evaluation.
    await expect(
      world.verificationService.compareCandidates(
        {
          ...input,
          candidates: [
            { candidateId: "x", evidenceRefs: [], facts: { score: 9 } },
            { candidateId: "y", evidenceRefs: [], facts: { score: 1 } },
          ],
          plannerAuthorization: {
            initiator: "user" as never,
            decisionRef: "d",
            reason: "curious",
          },
        },
        `key-${generateId().slice(-8)}`,
      ),
    ).rejects.toThrow(/initiator must be "planner"/);

    // Unresolved uncertainty ⇒ INCONCLUSIVE, never a forced winner.
    const ambiguous = await world.verificationService.compareCandidates(
      {
        ...input,
        candidates: [
          { candidateId: "cand-a", evidenceRefs: ["e:a"], facts: { score: 9 } },
          { candidateId: "cand-b", evidenceRefs: ["e:b"], facts: { score: 9 } },
        ],
      },
      `key-${generateId().slice(-8)}`,
    );
    expect(ambiguous.comparison.status).toBe("INCONCLUSIVE");
    expect(ambiguous.comparison.winner).toBeUndefined();

    // Idempotent replay by key.
    const key = `key-${generateId().slice(-8)}`;
    const first = await world.verificationService.compareCandidates(
      {
        ...input,
        candidates: [
          { candidateId: "cand-a", evidenceRefs: ["e:a"], facts: { score: 9 } },
          { candidateId: "cand-b", evidenceRefs: ["e:b"], facts: { score: 4 } },
        ],
      },
      key,
    );
    const replay = await world.verificationService.compareCandidates(
      {
        ...input,
        candidates: [
          { candidateId: "cand-a", evidenceRefs: ["e:a"], facts: { score: 9 } },
          { candidateId: "cand-b", evidenceRefs: ["e:b"], facts: { score: 4 } },
        ],
      },
      key,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.comparison.id).toBe(first.comparison.id);

    // The comparison evidence rides the canonical ledger.
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.some((event) => event.type === "execution.comparison-recorded")).toBe(true);
  });
});
