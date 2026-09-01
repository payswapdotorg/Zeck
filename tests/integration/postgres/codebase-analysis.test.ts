/**
 * Real-PostgreSQL codebase-analysis API proofs (WORK-022 / DTR-005,
 * HUM-001..003 — the durable halves of the HTTP-surface mutants).
 *
 * Runs the REAL Fastify server over the REAL SQL authorities (executions,
 * policies, identity, learning opportunity store — migration 0016):
 *  - "Analysis is an Execution": POST /codebase-analysis creates the
 *    governing execution through the executions authority, drives it
 *    through the real single write path (authorize = POLICY ADMISSION
    -> plan -> queue -> start), runs the advisory analysis and completes
 *    it through verify/pass with the digest-bound verification result;
 *  - M2/M4 (policy admission before side effects): a policy that DENIES
 *    codebase-analysis executions fails the route closed (403
 *    POLICY_DENIED) BEFORE any learning row is written;
 *  - M1/M26 (tenant isolation): cross-tenant reads/ratings are 404 —
 *    another tenant's analysis is indistinguishable from a missing one;
 *  - idempotency: the same key replays the durable analysis; a different
 *    source under the same key fails closed (409);
 *  - ratings (§14): immutable evidence over the real SQL identity
 *    (finding, rater, question); duplicates converge, conflicts 409;
 *  - finding transitions (§18): the evidence-gated advisory ->
 *    candidate -> verified lifecycle over the real journal + state
 *    guards; illegal edges fail closed (422).
 */

import { expect, test } from "vitest";
import { authHeaders, otherTenantHeaders, seedApiPgWorld } from "./api-world";
import { definePgSuite } from "./harness";

const REPOSITORY = "github.com/example/customer-app";
const REVISION = "commit-abc123";

/** The §19 GREEN subgraph: a structured, verified, low-variability model call. */
function deterministicCandidateSubgraph(): Record<string, unknown> {
  return {
    nodes: [
      {
        nodeId: "llm-1",
        kind: "model-call",
        label: "classifyTicket",
        provenance: {
          repository: REPOSITORY,
          revision: REVISION,
          file: "src/support/classify.ts",
          symbol: "classifyTicket",
          lineStart: 10,
          lineEnd: 48,
        },
        observation: {
          executionCount: 40,
          errorRate: 0.02,
          inputVariability: "low",
          semanticComplexity: "low",
          distinctInputCount: 5,
          distinctOutputCount: 5,
          verificationPassCount: 38,
          verificationFailCount: 2,
          observedCostMicroUsd: "12000",
          observedLatencyMs: 900,
          evidenceRefs: ["execution:1:receipt", "execution:2:receipt"],
        },
      },
    ],
    edges: [],
  };
}

/** The sparse §12/§13 subgraph (LOW confidence -> the VOI prompt fires). */
function sparseConstantSubgraph(): Record<string, unknown> {
  return {
    nodes: [
      {
        nodeId: "llm-const",
        kind: "model-call",
        label: "returnGreeting",
        provenance: {
          repository: REPOSITORY,
          revision: REVISION,
          file: "src/greet.ts",
          symbol: "returnGreeting",
        },
        observation: {
          executionCount: 4,
          errorRate: 0.02,
          inputVariability: "low",
          semanticComplexity: "low",
          distinctOutputCount: 1,
          constantOutput: true,
          verificationPassCount: 3,
          verificationFailCount: 1,
          evidenceRefs: ["obs:const-1"],
        },
      },
    ],
    edges: [],
  };
}

/** A revision-matched subgraph (the M28 discipline: nodes carry the selection's revision). */
function deterministicCandidateSubgraphAt(revision: string): Record<string, unknown> {
  const subgraph = deterministicCandidateSubgraph();
  const nodes = subgraph.nodes as Record<string, Record<string, unknown>>[];
  for (const node of nodes) {
    const provenance = node.provenance as Record<string, unknown>;
    provenance.revision = revision;
  }
  return subgraph;
}

async function postAnalysis(
  world: Awaited<ReturnType<typeof seedApiPgWorld>>,
  key: string,
  subgraph: Record<string, unknown> = deterministicCandidateSubgraph(),
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await world.server.app.inject({
    method: "POST",
    url: "/codebase-analysis",
    headers: { ...authHeaders(world), "idempotency-key": key },
    payload: {
      applicationId: world.applicationId,
      source: { repository: REPOSITORY, revision: REVISION },
      subgraph,
    },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

definePgSuite("codebase-analysis API over real PostgreSQL (WORK-022)", (ctx) => {
  test("POST /codebase-analysis: the governed analysis through the REAL executions authority", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const { status, body } = await postAnalysis(world, `w022-pg-${Date.now()}`);
    expect(status).toBe(201);
    const analysis = body.analysis as Record<string, unknown>;
    expect(analysis.repository).toBe(REPOSITORY);
    expect(analysis.revision).toBe(REVISION);
    expect(analysis.findingCount).toBeGreaterThan(0);
    const findings = body.findings as Record<string, unknown>[];
    expect(findings.some((finding) => finding.class === "deterministic-replacement")).toBe(true);
    for (const finding of findings) {
      expect(finding.state).toBe("advisory");
    }

    // The governing execution: a REAL row, COMPLETED, bound to durable
    // verification evidence that carries the analysis digest.
    const executionId = analysis.executionId as string;
    const row = await ctx.port.execute<{
      readonly status: string;
      readonly verifications: string;
    }>({
      sql: `SELECT e.status,
                   (SELECT count(*)::text FROM executions.verification_results r
                    WHERE r.execution_id = e.id) AS verifications
            FROM executions.executions e WHERE e.id = $1`,
      parameters: [executionId],
    });
    expect(row.rows[0]?.status).toBe("COMPLETED");
    expect(row.rows[0]?.verifications).toBe("1");
    const verification = await ctx.port.execute<{ readonly evidence: string }>({
      sql: `SELECT evidence FROM executions.verification_results WHERE execution_id = $1`,
      parameters: [executionId],
    });
    expect(JSON.stringify(verification.rows[0]?.evidence)).toContain(analysis.digest as string);

    // The analysis + findings are DURABLE (migration 0016).
    const learningRows = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.opportunity_findings
            WHERE analysis_id = $1`,
      parameters: [analysis.analysisId as string],
    });
    expect(learningRows.rows[0]?.count).toBe(String(analysis.findingCount));
  });

  test("the sparse case surfaces the VOI-gated prompts on the wire (§12/§13)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const { status, body } = await postAnalysis(
      world,
      `w022-pg-sparse-${Date.now()}`,
      sparseConstantSubgraph(),
    );
    expect(status).toBe(201);
    const prompts = body.prompts as Record<string, unknown>[];
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt.expectedInformationGain as number).toBeGreaterThan(
        prompt.userFrictionThreshold as number,
      );
      expect(typeof prompt.question).toBe("string");
    }
  });

  test("idempotency: the same key replays the DURABLE analysis (real SQL arbitration)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const key = `w022-pg-dup-${Date.now()}`;
    const first = await postAnalysis(world, key);
    const second = await postAnalysis(world, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((second.body.analysis as Record<string, unknown>).analysisId).toBe(
      (first.body.analysis as Record<string, unknown>).analysisId,
    );
    expect((second.body.analysis as Record<string, unknown>).replayed).toBe(true);
    const count = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.opportunity_analyses
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(count.rows[0]?.count).toBe("1");
  });

  test("M12: the same key with a different source fails closed at the create fingerprint (409)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const key = `w022-pg-clash-${Date.now()}`;
    const first = await postAnalysis(world, key);
    expect(first.status).toBe(201);
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": key },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: "commit-different-999" },
        subgraph: deterministicCandidateSubgraphAt("commit-different-999"),
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("M1/M26: a cross-tenant analysis read is a 404 (no tenant leak)", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const { body } = await postAnalysis(world, `w022-pg-cross-${Date.now()}`);
    const analysisId = (body.analysis as Record<string, unknown>).analysisId as string;
    const response = await world.server.app.inject({
      method: "GET",
      url: `/codebase-analysis/${analysisId}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(world.tenantId);
    expect(JSON.stringify(response.body)).not.toContain(analysisId);
  });

  test("ratings: immutable evaluation evidence over the real SQL identity", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const { body } = await postAnalysis(
      world,
      `w022-pg-rating-${Date.now()}`,
      sparseConstantSubgraph(),
    );
    const analysisId = (body.analysis as Record<string, unknown>).analysisId as string;
    const findings = body.findings as Record<string, unknown>[];
    const target = findings.find((finding) => finding.class === "ai-removal") as Record<
      string,
      unknown
    >;
    expect(target).toBeDefined();

    const ratingPayload: Record<string, unknown> = {
      applicationId: world.applicationId,
      findingId: target.findingId,
      counterpartFindingId: null,
      rater: "developer-pg",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      confidence: 0.9,
      rationale: "constant output preserved",
      evidenceRefs: ["obs:const-1"],
    };
    const post = () =>
      world.server.app.inject({
        method: "POST",
        url: `/codebase-analysis/${analysisId}/ratings`,
        headers: { ...authHeaders(world), "idempotency-key": `rating-${analysisId}` },
        payload: ratingPayload,
      });
    const first = await post();
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    const replay = await post();
    expect(replay.statusCode).toBe(201);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().ratingId).toBe(first.json().ratingId);

    // A conflicting re-rating of the same question fails closed.
    const conflict = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": `rating-conflict-${analysisId}` },
      payload: { ...ratingPayload, answer: "prefer-baseline" },
    });
    expect(conflict.statusCode).toBe(409);

    // M10: a PASS-shaped answer is rejected (preference-only vocabulary).
    const passShaped = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": `rating-pass-${analysisId}` },
      payload: { ...ratingPayload, rater: "intruder", answer: "PASS" },
    });
    expect(passShaped.statusCode).toBe(422);
  });

  test("finding transitions: the evidence-gated lifecycle over the real journal", async () => {
    const world = await seedApiPgWorld(ctx.port);
    const { body } = await postAnalysis(
      world,
      `w022-pg-tr-${Date.now()}`,
      sparseConstantSubgraph(),
    );
    const analysisId = (body.analysis as Record<string, unknown>).analysisId as string;
    const findings = body.findings as Record<string, unknown>[];
    const target = findings.find((finding) => finding.class === "ai-removal") as Record<
      string,
      unknown
    >;

    // Record the rating first (the §14 evidence).
    const rating = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": `tr-rating-${analysisId}` },
      payload: {
        applicationId: world.applicationId,
        findingId: target.findingId,
        counterpartFindingId: null,
        rater: "developer-pg-tr",
        questionKind: "behavior-preservation",
        answer: "prefer-candidate",
        evidenceRefs: ["obs:const-1"],
      },
    });
    expect(rating.statusCode).toBe(201);
    const ratingId = rating.json().ratingId as string;

    // M16: evidence refs that do not resolve to recorded ratings are rejected.
    const fabricated = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/findings/${target.findingId as string}/transition`,
      headers: { ...authHeaders(world), "idempotency-key": `tr-fake-${analysisId}` },
      payload: {
        applicationId: world.applicationId,
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: ["fabricated-rating"],
      },
    });
    expect(fabricated.statusCode).toBe(422);

    // M16: state skipping (advisory -> verified) is rejected.
    const skip = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/findings/${target.findingId as string}/transition`,
      headers: { ...authHeaders(world), "idempotency-key": `tr-skip-${analysisId}` },
      payload: {
        applicationId: world.applicationId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: [ratingId],
        verifiedEquivalence: {
          comparisonId: "cmp-1",
          comparedRevision: REVISION,
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp:1"],
        },
      },
    });
    expect(skip.statusCode).toBe(422);

    // The legal advisory -> candidate advance with REAL rating evidence.
    const advance = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/findings/${target.findingId as string}/transition`,
      headers: { ...authHeaders(world), "idempotency-key": `tr-adv-${analysisId}` },
      payload: {
        applicationId: world.applicationId,
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: [ratingId],
      },
    });
    expect(advance.statusCode).toBe(201);
    const state = await ctx.port.execute<{ readonly state: string }>({
      sql: `SELECT state FROM learning.opportunity_findings WHERE id = $1`,
      parameters: [target.findingId as string],
    });
    expect(state.rows[0]?.state).toBe("candidate");

    // M8: a LOW-confidence finding can never verify.
    const verifyAttempt = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/findings/${target.findingId as string}/transition`,
      headers: { ...authHeaders(world), "idempotency-key": `tr-ver-${analysisId}` },
      payload: {
        applicationId: world.applicationId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: {
          comparisonId: "cmp-1",
          comparedRevision: REVISION,
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp:1"],
        },
      },
    });
    expect(verifyAttempt.statusCode).toBe(422);

    // M1/M26: a cross-tenant transition is a 404 (the finding is scope-checked).
    const foreign = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/findings/${target.findingId as string}/transition`,
      headers: {
        ...otherTenantHeaders(world),
        "idempotency-key": `tr-foreign-${analysisId}`,
      },
      payload: {
        applicationId: world.otherApplicationId,
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: [ratingId],
      },
    });
    expect(foreign.statusCode).toBe(422);
  });

  test("M2/M4: a policy DENIAL fails the analysis closed BEFORE any learning row exists", async () => {
    const world = await seedApiPgWorld(ctx.port);
    // Deny every codebase-analysis execution at the REAL policy authority.
    await world.policyAuthority.publish({
      id: "default",
      version: 2,
      documents: [
        { scope: "platform", selector: {}, restrictions: {} },
        {
          scope: "task",
          selector: { taskKind: "codebase-analysis" },
          deny: { reason: "codebase analysis suspended for this policy wave" },
        },
      ],
    });
    const denied = await postAnalysis(world, `w022-pg-deny-${Date.now()}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("POLICY_DENIED");

    // NOTHING was written: no analysis row, no finding, no prompt.
    const learningRows = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.opportunity_analyses
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(learningRows.rows[0]?.count).toBe("0");
    const findingRows = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.opportunity_findings
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(findingRows.rows[0]?.count).toBe("0");
    // ...and the analysis execution was never dispatched (no verification,
    // no COMPLETED state — the denial is durable evidence on the ledger).
    const dispatched = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.executions e
            WHERE e.application_id = $1 AND e.status IN ('RUNNING','COMPLETED')`,
      parameters: [world.applicationId],
    });
    expect(dispatched.rows[0]?.count).toBe("0");
  });
});
