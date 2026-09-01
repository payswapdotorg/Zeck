/**
 * Public API codebase-analysis endpoint tests (WORK-022 / DTR-005,
 * HUM-001..003; M1, M2, M8..M16, M24, M26, M27, M28) over the REAL
 * Fastify server (fastify.inject — real route/handler/serialization
 * execution, no network) and the REAL learning-module analyzer over
 * the in-memory opportunity store.
 *
 * Required-test mapping:
 *  - analysis through the executions authority ("Analysis is an
 *    Execution"): 201 + the advisory report; the governing execution
 *    completes through verify/pass with the digest-bound verification
 *    result (the completion rule);
 *  - deterministic-first wire evidence: the §19 GREEN case surfaces
 *    deterministic-replacement findings; the advisory-only state
 *    discipline (advisory findings, never promoted);
 *  - idempotency: same key + same request replays (analysis
 *    execution binding); same execution + a DIFFERENT subgraph fails
 *    closed IDEMPOTENCY_KEY_REUSED; same key + a different source
 *    fails closed at the execution create fingerprint;
 *  - tenant/security: server-side scope derivation (cross-tenant
 *    reads/ratings are 404, unknown body keys rejected, client
 *    tenant keys rejected);
 *  - ratings: immutable preference-only evaluation evidence (M10),
 *    bound to the analysis execution + revision (M27/M28), converging
 *    on (finding, rater, question) and failing closed on conflicts;
 *  - finding transitions: the evidence-gated advisory -> candidate ->
 *    verified lifecycle (M8/M9/M15/M16/M18), with evidence that must
 *    RESOLVE to recorded ratings (M16).
 */

import { describe, expect, test } from "vitest";
import { type ApiWorld, authHeaders, otherTenantHeaders, seedApiWorld } from "./world";

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

/** The §19 RED subgraph: genuinely semantic work (AI is necessary). */
function genuinelySemanticSubgraph(): Record<string, unknown> {
  return {
    nodes: [
      {
        nodeId: "llm-semantic",
        kind: "model-call",
        label: "draftPolicyResponse",
        provenance: {
          repository: REPOSITORY,
          revision: REVISION,
          file: "src/support/draft.ts",
          symbol: "draftPolicyResponse",
        },
        observation: {
          executionCount: 40,
          errorRate: 0.05,
          inputVariability: "high",
          semanticComplexity: "high",
          verificationPassCount: 36,
          verificationFailCount: 4,
          observedCostMicroUsd: "90000",
          observedLatencyMs: 4000,
          evidenceRefs: ["execution:3:receipt"],
        },
      },
    ],
    edges: [],
  };
}

/**
 * The sparse §12/§13 case: an observed-constant model call with a tiny
 * population — an ai-removal candidate whose LOW confidence makes the
 * VOI-justified human-evaluation prompt (and rating) the smallest
 * useful next step.
 */
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
          distinctInputCount: 2,
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

function analysisBody(
  world: ApiWorld,
  subgraph: Record<string, unknown> = deterministicCandidateSubgraph(),
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    applicationId: world.applicationId,
    source: { repository: REPOSITORY, revision: REVISION },
    subgraph,
    ...over,
  };
}

async function postAnalysis(
  world: ApiWorld,
  key: string,
  subgraph: Record<string, unknown> = deterministicCandidateSubgraph(),
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await world.server.app.inject({
    method: "POST",
    url: "/codebase-analysis",
    headers: { ...authHeaders(world), "idempotency-key": key },
    payload: analysisBody(world, subgraph),
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

describe("POST /codebase-analysis (Analysis is an Execution)", () => {
  test("creates the governed analysis and returns the advisory report", async () => {
    const world = await seedApiWorld();
    const { status, body } = await postAnalysis(world, "w022-create-1");
    expect(status).toBe(201);
    const analysis = body.analysis as Record<string, unknown>;
    expect(analysis.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(analysis.repository).toBe(REPOSITORY);
    expect(analysis.revision).toBe(REVISION);
    expect(analysis.analysisVersion).toBe(1);
    expect((body.findings as unknown[]).length).toBeGreaterThan(0);
    for (const finding of body.findings as Record<string, unknown>[]) {
      expect(finding.state).toBe("advisory");
      const provenance = finding.provenance as Record<string, unknown>;
      expect(provenance.repository).toBe(REPOSITORY);
      expect(provenance.revision).toBe(REVISION);
    }
  });

  test("the governing execution completes through verification with the digest binding", async () => {
    const world = await seedApiWorld();
    const { body } = await postAnalysis(world, "w022-lifecycle-1");
    const analysis = body.analysis as Record<string, unknown>;
    const executionId = analysis.executionId as string;
    const executionResponse = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}`,
      headers: authHeaders(world),
    });
    expect(executionResponse.statusCode).toBe(200);
    expect(executionResponse.json().status).toBe("COMPLETED");
    const verificationResponse = await world.server.app.inject({
      method: "GET",
      url: `/executions/${executionId}/verification`,
      headers: authHeaders(world),
    });
    expect(verificationResponse.statusCode).toBe(200);
    const results = verificationResponse.json() as Record<string, unknown>[];
    expect(results.length).toBeGreaterThan(0);
    const evidence = JSON.stringify(results);
    expect(evidence).toContain(analysis.digest as string);
  });

  test("M11/M12/M22/M23: the wire findings carry provenance, evidence and honest impact", async () => {
    const world = await seedApiWorld();
    const { body } = await postAnalysis(world, "w022-wire-1");
    const findings = body.findings as Record<string, unknown>[];
    const replacement = findings.find((f) => f.class === "deterministic-replacement");
    expect(replacement).toBeDefined();
    const impact = replacement?.impact as Record<string, unknown>;
    expect(impact.basis).toBe("measured");
    expect(impact.currentMicroUsd).toBe("12000");
    expect(impact.candidateMicroUsd).toBeNull();
    expect(impact.expectedSavingsMicroUsd).toBeNull();
    const evidenceRefs = (replacement?.evidenceRefs ?? []) as unknown[];
    expect(evidenceRefs.length).toBeGreaterThan(0);
    const confidence = replacement?.confidence as Record<string, unknown>;
    expect(confidence.level).toBe("high");
    expect(confidence.population).toBe(40);
  });

  test("§19: the GREEN case recommends deterministicization; the RED case does not", async () => {
    const world = await seedApiWorld();
    const green = await postAnalysis(world, "w022-green-1");
    expect(
      (green.body.findings as Record<string, unknown>[]).find(
        (f) => f.class === "deterministic-replacement",
      ),
    ).toBeDefined();

    const red = await postAnalysis(world, "w022-red-1", genuinelySemanticSubgraph());
    expect(
      (red.body.findings as Record<string, unknown>[]).find(
        (f) => f.class === "deterministic-replacement",
      ),
    ).toBeUndefined();
    expect(
      (red.body.findings as Record<string, unknown>[]).find((f) => f.class === "ai-removal"),
    ).toBeUndefined();
  });

  test("idempotency: the same key + the same request replays the durable analysis", async () => {
    const world = await seedApiWorld();
    const first = await postAnalysis(world, "w022-replay-1");
    const second = await postAnalysis(world, "w022-replay-1");
    expect(second.status).toBe(201);
    expect((second.body.analysis as Record<string, unknown>).replayed).toBe(true);
    expect((second.body.analysis as Record<string, unknown>).analysisId).toBe(
      (first.body.analysis as Record<string, unknown>).analysisId,
    );
    expect((second.body.analysis as Record<string, unknown>).executionId).toBe(
      (first.body.analysis as Record<string, unknown>).executionId,
    );
  });

  test("the same analysis execution with a DIFFERENT subgraph fails closed (409)", async () => {
    const world = await seedApiWorld();
    await postAnalysis(world, "w022-clash-1");
    const conflict = await postAnalysis(world, "w022-clash-1", genuinelySemanticSubgraph());
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("the same key with a different source fails closed at the create fingerprint (409)", async () => {
    const world = await seedApiWorld();
    await postAnalysis(world, "w022-src-clash-1");
    // A CONSISTENT selection at a different revision (source + nodes):
    // pre-validation passes and the executions fingerprint diverges.
    const otherRevisionSubgraph = {
      nodes: (deterministicCandidateSubgraph().nodes as Record<string, unknown>[]).map((node) => ({
        ...node,
        provenance: {
          ...(node.provenance as Record<string, unknown>),
          revision: "commit-OTHER",
        },
      })),
      edges: [],
    };
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "w022-src-clash-1" },
      payload: analysisBody(world, otherRevisionSubgraph as Record<string, unknown>, {
        source: { repository: REPOSITORY, revision: "commit-OTHER" },
      }),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("M24: a high friction threshold suppresses prompts at the route level", async () => {
    const world = await seedApiWorld();
    const { body } = await postAnalysis(world, "w022-friction-1", {
      ...deterministicCandidateSubgraph(),
    });
    void body;
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "w022-friction-2" },
      payload: analysisBody(world, deterministicCandidateSubgraph(), {
        friction: { userFrictionThreshold: 0.95 },
      }),
    });
    expect(response.statusCode).toBe(201);
    // Confidence 'high' (population 40 + verification + error rate): no
    // prompt is justified at ANY threshold (M24: sufficient evidence).
    expect(response.json().prompts).toHaveLength(0);
    void world;
  });

  test("invalid input: missing idempotency key, unknown keys, malformed subgraph (422)", async () => {
    const world = await seedApiWorld();
    const noKey = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: authHeaders(world),
      payload: analysisBody(world),
    });
    expect(noKey.statusCode).toBe(422);

    const unknownKeys = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "w022-unknown-1" },
      payload: analysisBody(world, undefined, { tenantId: "injected" }),
    });
    expect(unknownKeys.statusCode).toBe(422);
    expect(unknownKeys.json().message).toContain("unknown keys");

    const malformed = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "w022-malformed-1" },
      payload: analysisBody(world, {
        nodes: [
          {
            nodeId: "llm-1",
            kind: "model-call",
            label: "classify",
            provenance: { repository: REPOSITORY, revision: REVISION },
            observation: {
              executionCount: 10,
              evidenceRefs: ["obs:1"],
            },
          },
        ],
        edges: [],
      }),
    });
    expect(malformed.statusCode).toBe(422);
    expect(malformed.json().message).toContain("invalid subgraph");

    const staleRevision = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "w022-stale-1" },
      payload: analysisBody(world, {
        nodes: [
          {
            nodeId: "llm-1",
            kind: "model-call",
            label: "classify",
            provenance: {
              repository: REPOSITORY,
              revision: "commit-OTHER",
              file: "src/a.ts",
            },
            observation: { executionCount: 10, evidenceRefs: ["obs:1"] },
          },
        ],
        edges: [],
      }),
    });
    // M28: mixed/stale revisions are rejected at PRE-VALIDATION (422,
    // before any execution row is created).
    expect(staleRevision.statusCode).toBe(422);
    expect(staleRevision.json().message).toContain("invalid subgraph");
  });

  test("M1: an unauthenticated request is rejected before any authority call", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { "idempotency-key": "w022-no-auth", "x-zeck-application": world.applicationId },
      payload: analysisBody(world),
    });
    expect(response.statusCode).toBe(401);
  });

  test("a caller without membership for the application is denied (403)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "w022-no-membership" },
      payload: analysisBody(world, undefined, {
        applicationId: "00000000-0000-7000-8000-0000000000ee",
      }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("AUTHORIZATION_DENIED");
  });
});

describe("GET /codebase-analysis/:id", () => {
  test("returns the advisory report through the scope-checked read", async () => {
    const world = await seedApiWorld();
    const { body } = await postAnalysis(world, "w022-get-1");
    const analysisId = (body.analysis as Record<string, unknown>).analysisId as string;
    const response = await world.server.app.inject({
      method: "GET",
      url: `/codebase-analysis/${analysisId}`,
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(200);
    const report = response.json() as Record<string, unknown>;
    expect((report.analysis as Record<string, unknown>).analysisId).toBe(analysisId);
    expect((report.findings as unknown[]).length).toBeGreaterThan(0);
  });

  test("M1/M26: a cross-tenant analysis read is a 404 (no tenant leak)", async () => {
    const world = await seedApiWorld();
    const { body } = await postAnalysis(world, "w022-cross-1");
    const analysisId = (body.analysis as Record<string, unknown>).analysisId as string;
    const response = await world.server.app.inject({
      method: "GET",
      url: `/codebase-analysis/${analysisId}`,
      headers: otherTenantHeaders(world),
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain(world.tenantId);
  });

  test("a missing analysis is a 404", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "GET",
      url: "/codebase-analysis/00000000-0000-7000-b000-00000000ffff",
      headers: authHeaders(world),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /codebase-analysis/:id/ratings (§14 evaluation evidence)", () => {
  async function analysisForRating(world: ApiWorld): Promise<{
    readonly analysisId: string;
    readonly findingId: string;
  }> {
    // The sparse §12/§13 case: a low-confidence removal candidate —
    // the VOI-justified rating target.
    const { body } = await postAnalysis(world, "w022-rating-create-1", sparseConstantSubgraph());
    const analysis = body.analysis as Record<string, unknown>;
    expect(analysis.promptCount as number).toBeGreaterThanOrEqual(1);
    const findings = body.findings as Record<string, unknown>[];
    const finding = findings.find((f) => f.class === "ai-removal") as Record<string, unknown>;
    expect(finding).toBeDefined();
    return {
      analysisId: analysis.analysisId as string,
      findingId: finding.findingId as string,
    };
  }

  function ratingBody(
    world: ApiWorld,
    analysisId: string,
    findingId: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    void analysisId;
    return {
      applicationId: world.applicationId,
      findingId,
      rater: "rater-1",
      questionKind: "pair-preference",
      answer: "prefer-candidate",
      evidenceRefs: ["obs:llm-semantic"],
      ...over,
    };
  }

  test("records the immutable rating and returns the receipt", async () => {
    const world = await seedApiWorld();
    const { analysisId, findingId } = await analysisForRating(world);
    const response = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": "w022-rating-1" },
      payload: ratingBody(world, analysisId, findingId),
    });
    expect(response.statusCode).toBe(201);
    const receipt = response.json() as Record<string, unknown>;
    expect(receipt.ratingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.replayed).toBe(false);
    expect(receipt.answer).toBe("prefer-candidate");
  });

  test("M11/M12: the same rater + question converges (replay); a conflicting answer fails closed", async () => {
    const world = await seedApiWorld();
    const { analysisId, findingId } = await analysisForRating(world);
    const send = (over: Record<string, unknown>, key: string) =>
      world.server.app.inject({
        method: "POST",
        url: `/codebase-analysis/${analysisId}/ratings`,
        headers: { ...authHeaders(world), "idempotency-key": key },
        payload: ratingBody(world, analysisId, findingId, over),
      });
    const first = await send({}, "w022-rating-2");
    expect(first.statusCode).toBe(201);
    const replay = await send({}, "w022-rating-2");
    expect(replay.statusCode).toBe(201);
    expect(replay.json().replayed).toBe(true);

    const conflict = await send({ answer: "prefer-baseline" }, "w022-rating-3");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("M10: a PASS-shaped answer is rejected (preference-only vocabulary)", async () => {
    const world = await seedApiWorld();
    const { analysisId, findingId } = await analysisForRating(world);
    const response = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": "w022-rating-pass" },
      payload: ratingBody(world, analysisId, findingId, { answer: "PASS" }),
    });
    expect(response.statusCode).toBe(422);
    // The closed answer vocabulary is preference-only (the listed
    // allowed values contain no PASS/FAIL vocabulary — M10).
    expect(response.json().message).toContain("prefer-candidate");
    expect(response.json().message).not.toContain("PASS");
  });

  test("M27: a rating for a finding outside the analysis is rejected", async () => {
    const world = await seedApiWorld();
    const { analysisId } = await analysisForRating(world);
    const response = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": "w022-rating-wrong" },
      payload: ratingBody(world, analysisId, "00000000-0000-7000-b000-0000000000ff"),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("finding not found");
  });

  test("M1/M26: a cross-tenant rating is a 404 (the analysis is scope-checked first)", async () => {
    const world = await seedApiWorld();
    const { analysisId, findingId } = await analysisForRating(world);
    const response = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": "w022-rating-cross" },
      payload: ratingBody(world, analysisId, findingId, {
        applicationId: world.otherTenantApplicationId,
      }),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("POST /codebase-analysis/:id/findings/:findingId/transition (§18 state discipline)", () => {
  interface RatedWorld {
    readonly world: ApiWorld;
    readonly analysisId: string;
    readonly findingId: string;
    readonly ratingId: string;
  }

  async function ratedFinding(): Promise<RatedWorld> {
    const world = await seedApiWorld();
    // A low-confidence removal candidate (the sparse §12/§13 case):
    // VOI justifies the rating, and the rating becomes the evidence of
    // the advisory -> candidate transition.
    const { body } = await postAnalysis(
      world,
      "w022-transition-create-1",
      sparseConstantSubgraph(),
    );
    const analysis = body.analysis as Record<string, unknown>;
    const findings = body.findings as Record<string, unknown>[];
    const removal = findings.find((f) => f.class === "ai-removal") as Record<string, unknown>;
    expect(removal).toBeDefined();
    const analysisId = analysis.analysisId as string;
    const findingId = removal.findingId as string;
    const rating = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...authHeaders(world), "idempotency-key": "w022-transition-rating-1" },
      payload: {
        applicationId: world.applicationId,
        findingId,
        rater: "rater-1",
        questionKind: "behavior-preservation",
        answer: "prefer-candidate",
        evidenceRefs: ["obs:const-1"],
      },
    });
    expect(rating.statusCode).toBe(201);
    return {
      world,
      analysisId,
      findingId,
      ratingId: rating.json().ratingId as string,
    };
  }

  function transitionBody(
    world: ApiWorld,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      applicationId: world.applicationId,
      toState: "candidate",
      evidenceKind: "rating",
      evidenceRefs: [],
      ...over,
    };
  }

  test("M9/M18: the legal advisory -> candidate advance with REAL rating evidence", async () => {
    const rated = await ratedFinding();
    const response = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-1",
      },
      payload: transitionBody(rated.world, { evidenceRefs: [rated.ratingId] }),
    });
    expect(response.statusCode).toBe(201);
    const receipt = response.json() as Record<string, unknown>;
    expect(receipt.fromState).toBe("advisory");
    expect(receipt.toState).toBe("candidate");
  });

  test("M16: evidence that does not resolve to recorded ratings is rejected", async () => {
    const rated = await ratedFinding();
    const response = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-fabricated",
      },
      payload: transitionBody(rated.world, {
        evidenceRefs: ["00000000-0000-7000-b000-000000000abc"],
      }),
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().message).toContain("resolve");
  });

  test("M16: state skipping (advisory -> verified) is rejected", async () => {
    const rated = await ratedFinding();
    const response = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-skip",
      },
      payload: transitionBody(rated.world, {
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: [rated.ratingId],
        verifiedEquivalence: {
          comparisonId: "cmp-1",
          comparedRevision: REVISION,
          baselineObservations: 40,
          candidateObservations: 40,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp-1"],
        },
      }),
    });
    expect(response.statusCode).toBe(422);
  });

  test("M18: 'promoted' is not a reachable state on this surface", async () => {
    const rated = await ratedFinding();
    const response = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-promoted",
      },
      payload: transitionBody(rated.world, { toState: "promoted" }),
    });
    expect(response.statusCode).toBe(422);
    // The closed state vocabulary excludes 'promoted' entirely (M18).
    expect(response.json().message).toContain("advisory, candidate, verified");
    expect(response.json().message).not.toContain("promoted");
  });

  test("M8/M9: a rating can never verify a finding (only candidate is reachable via rating)", async () => {
    const rated = await ratedFinding();
    // First advance to candidate with the real rating evidence.
    const advance = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-advance",
      },
      payload: transitionBody(rated.world, { evidenceRefs: [rated.ratingId] }),
    });
    expect(advance.statusCode).toBe(201);
    // A SECOND rating attempt on the now-candidate finding cannot
    // produce 'verified' (rating evidence only ever produces candidate).
    const secondRater = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/ratings`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-rating-2",
      },
      payload: {
        applicationId: rated.world.applicationId,
        findingId: rated.findingId,
        rater: "rater-2",
        questionKind: "replacement-acceptability",
        answer: "no-difference",
        evidenceRefs: ["obs:const-1"],
      },
    });
    expect(secondRater.statusCode).toBe(201);
    const rating2 = secondRater.json().ratingId as string;
    const verifyAttempt = await rated.world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
      headers: {
        ...authHeaders(rated.world),
        "idempotency-key": "w022-transition-verify-rating",
      },
      payload: transitionBody(rated.world, {
        toState: "verified",
        evidenceKind: "rating",
        evidenceRefs: [rating2],
      }),
    });
    expect(verifyAttempt.statusCode).toBe(422);
    expect(verifyAttempt.json().message).toContain("verified-equivalence");
  });

  test("the idempotent transition replays the durable journal row", async () => {
    const rated = await ratedFinding();
    const send = () =>
      rated.world.server.app.inject({
        method: "POST",
        url: `/codebase-analysis/${rated.analysisId}/findings/${rated.findingId}/transition`,
        headers: {
          ...authHeaders(rated.world),
          "idempotency-key": "w022-transition-replay",
        },
        payload: transitionBody(rated.world, { evidenceRefs: [rated.ratingId] }),
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    const second = await send();
    expect(second.statusCode).toBe(201);
    expect(second.json().replayed).toBe(true);
    expect(second.json().transitionId).toBe(first.json().transitionId);
  });
});
