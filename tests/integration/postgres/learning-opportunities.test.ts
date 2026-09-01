/**
 * Real-PostgreSQL codebase-opportunity proofs (WORK-022 / DTR-005,
 * HUM-001..003; migration `0016_opportunity_analysis.sql`).
 *
 * Required-test mapping (the Work Order's real-PostgreSQL axis, §21):
 *  - "Analysis is an Execution": the analysis row FK-binds to a REAL
 *    execution created and driven through the executions single write
 *    path; one authoritative analysis per analysis execution (UNIQUE
 *    execution_id — M2/M26);
 *  - tenant isolation (M1/M26): cross-application/cross-tenant reads
 *    return nothing through the real SQL scope filters;
 *  - source provenance (M11/M12): repository + revision are CHECK-bound
 *    on every row; findings carry the full provenance targets;
 *  - candidate identity (M27): findings bind the exact selected node
 *    ids; ratings bind the real finding + analysis + execution;
 *  - ratings (§14/M9/M10): immutable preference-only evidence; duplicate
 *    ratings converge; conflicting re-ratings fail closed;
 *  - human-evaluation evidence (§12/§13/M24): prompts satisfy the
 *    PHYSICAL value-of-information CHECK (gain > friction);
 *  - recommendation history (§18/M8/M15/M16): the append-only
 *    transition journal; state advances only through matching journal
 *    rows; a direct UPDATE without a journal row is rejected by the
 *    coupling trigger;
 *  - stale revision handling (M28): ratings and verified-equivalence
 *    evidence bound to the finding's revision fail closed on mismatch;
 *  - no unauthorized mutation: the analyzer leaves the executions ledger
 *    and every other authority table untouched (it writes ONLY its own
 *    learning evidence tables); UPDATE/DELETE are rejected by the
 *    immutability triggers everywhere.
 */

import { expect, test } from "vitest";
import {
  createNodeDigest,
  createOpportunityAnalyzer,
  type OpportunityAnalyzer,
  SqlOpportunityStore,
} from "../../../src/modules/learning/public";
import { PlatformError } from "../../../src/shared/errors";
import { definePgSuite } from "./harness";
import { generateId, seedLearningWorld } from "./learning-world";

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

/**
 * The sparse §12/§13 subgraph: an observed-constant model call with a
 * tiny population — LOW confidence, so the human-evaluation prompt (the
 * physical VOI gate) fires.
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

definePgSuite("learning opportunities (real PostgreSQL, migration 0016)", (ctx) => {
  async function seedAnalyzerWorld() {
    const world = await seedLearningWorld(ctx.port);
    const analyzer: OpportunityAnalyzer = createOpportunityAnalyzer({
      store: new SqlOpportunityStore(ctx.port),
      digest: createNodeDigest(),
      generateId,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    return { world, analyzer };
  }

  /** Drive a REAL analysis execution to RUNNING (the route's composition). */
  async function seedRunningAnalysisExecution(
    world: Awaited<ReturnType<typeof seedLearningWorld>>,
    repository: string,
    revision: string,
  ): Promise<string> {
    const receipt = await world.executionService.createExecution(
      {
        applicationId: world.applicationId,
        task: { kind: "codebase-analysis", repository, revision },
      },
      `create-${generateId()}`,
      world.actor(),
    );
    const executionId = receipt.executionId;
    for (const command of ["authorize", "plan", "queue", "start"] as const) {
      await world.executionService.transition(
        {
          command,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
          actorId: world.actor().actorId,
        } as never,
        `${command}-${generateId()}`,
      );
    }
    return executionId;
  }

  async function analyze(
    analyzer: OpportunityAnalyzer,
    world: Awaited<ReturnType<typeof seedLearningWorld>>,
    options: {
      readonly executionId: string;
      readonly subgraph?: Record<string, unknown>;
      readonly repository?: string;
      readonly revision?: string;
    },
  ) {
    return analyzer.analyzeSubgraph({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId: options.executionId,
      source: {
        repository: options.repository ?? REPOSITORY,
        revision: options.revision ?? REVISION,
      },
      subgraph: (options.subgraph ?? deterministicCandidateSubgraph()) as never,
    });
  }

  test("migration 0016 applies on fresh databases: the five opportunity tables exist", async () => {
    const { world } = await seedAnalyzerWorld();
    void world;
    const result = await ctx.port.execute<{ table_name: string }>({
      sql: `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'learning' AND table_name LIKE 'opportunity%'
            ORDER BY table_name`,
    });
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "opportunity_analyses",
      "opportunity_finding_transitions",
      "opportunity_findings",
      "opportunity_prompts",
      "opportunity_ratings",
    ]);
    const claim = await ctx.port.execute<{ readonly name: string }>({
      sql: `SELECT name FROM platform.schema_migrations WHERE version = 16`,
    });
    expect(claim.rows[0]?.name).toBe("opportunity_analysis");
  });

  test("the governed analysis persists provenance-pinned advisory findings bound to a REAL execution (M11/M12/M2)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, { executionId });
    expect(outcome.replayed).toBe(false);

    // The analysis row binds the REAL execution (the FK proves it exists).
    const row = await ctx.port.execute<{
      readonly repository: string;
      readonly revision: string;
      readonly execution_id: string;
      readonly execution_status: string;
      readonly finding_count: number;
    }>({
      sql: `SELECT a.repository, a.revision, a.execution_id, e.status AS execution_status,
                   a.finding_count
            FROM learning.opportunity_analyses a
            JOIN executions.executions e ON e.id = a.execution_id
            WHERE a.id = $1`,
      parameters: [outcome.analysis.analysisId],
    });
    expect(row.rows[0]?.repository).toBe(REPOSITORY);
    expect(row.rows[0]?.revision).toBe(REVISION);
    expect(row.rows[0]?.execution_id).toBe(executionId);
    expect(row.rows[0]?.execution_status).toBe("RUNNING");
    expect(row.rows[0]?.finding_count).toBe(outcome.findings.length);

    // The findings: born advisory, provenance-pinned, evidence-backed (M27).
    for (const finding of outcome.findings) {
      expect(finding.state).toBe("advisory");
      expect(finding.provenance.repository).toBe(REPOSITORY);
      expect(finding.provenance.revision).toBe(REVISION);
      expect(finding.provenance.targets.length).toBe(finding.targetNodeIds.length);
      expect(finding.evidenceRefs.length).toBeGreaterThan(0);
      const findingRow = await ctx.port.execute<{ readonly state: string }>({
        sql: `SELECT state FROM learning.opportunity_findings WHERE id = $1`,
        parameters: [finding.findingId],
      });
      expect(findingRow.rows[0]?.state).toBe("advisory");
    }
    // The §19 GREEN case recommends deterministicization (a CANDIDATE,
    // never a verified equivalent).
    const classes = outcome.findings.map((finding) => finding.class);
    expect(classes).toContain("deterministic-replacement");
    for (const finding of outcome.findings) {
      expect(finding.deterministicEquivalence.potential).not.toBe("verified-equivalent");
    }
  });

  test("the sparse case emits the VOI-gated human-evaluation prompt (M25) and persists it (§14)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, {
      executionId,
      subgraph: sparseConstantSubgraph(),
    });
    expect(outcome.prompts.length).toBeGreaterThan(0);
    for (const prompt of outcome.prompts) {
      expect(prompt.expectedInformationGain).toBeGreaterThan(prompt.userFrictionThreshold);
      const promptRow = await ctx.port.execute<{ readonly finding_id: string }>({
        sql: `SELECT finding_id FROM learning.opportunity_prompts WHERE id = $1`,
        parameters: [prompt.promptId],
      });
      expect(promptRow.rows[0]?.finding_id).toBe(prompt.findingId);
    }
    // M24 (physical): a prompt that does not justify its friction is uninsertable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.opportunity_prompts
              (id, analysis_id, finding_id, application_id, tenant_id, question_kind,
               question, expected_information_gain, user_friction_threshold, basis,
               emitted_at, schema_version)
              SELECT $1, analysis_id, id, application_id, tenant_id, 'pair-preference',
                     'Which output is better?', 0.3, 0.5, '["probe"]'::jsonb,
                     NOW(), 1
              FROM learning.opportunity_findings WHERE id = $2`,
        parameters: [generateId(), outcome.findings[0]?.findingId],
      }),
    ).rejects.toThrow(/voi|friction|information/i);
  });

  test("execution binding: retries converge; a different analysis on the SAME execution fails closed (M2/M26)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const first = await analyze(analyzer, world, { executionId });
    const retry = await analyze(analyzer, world, { executionId });
    expect(retry.replayed).toBe(true);
    expect(retry.analysis.analysisId).toBe(first.analysis.analysisId);
    const count = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM learning.opportunity_analyses WHERE execution_id = $1`,
      parameters: [executionId],
    });
    expect(count.rows[0]?.count).toBe("1");

    // The same analysis execution carrying a DIFFERENT analysis basis:
    // one authoritative analysis per execution — conflicts fail closed.
    await expect(
      analyze(analyzer, world, { executionId, subgraph: sparseConstantSubgraph() }),
    ).rejects.toThrow(/IDEMPOTENCY_KEY_REUSED|authoritative analysis/i);
  });

  test("M1/M26: cross-application scope reads return nothing (real tenant isolation)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, { executionId });
    const foreignScope = {
      applicationId: "00000000-0000-7000-8000-0123456789cd",
      tenantId: world.tenantId,
    };
    // Scope-checked misses are indistinguishable from missing rows.
    const miss = await analyzer
      .getAnalysis({ ...foreignScope, analysisId: outcome.analysis.analysisId })
      .catch((error: unknown) => error);
    expect(miss).toBeInstanceOf(PlatformError);
    const store = new SqlOpportunityStore(ctx.port);
    expect(await store.getAnalysis(foreignScope, outcome.analysis.analysisId)).toBeNull();
    expect(await store.listFindings(foreignScope, outcome.analysis.analysisId)).toEqual([]);
    expect(await store.listAnalyses(foreignScope)).toEqual([]);
    const transitionMiss = await analyzer
      .advanceFinding({
        ...foreignScope,
        findingId: outcome.findings[0]?.findingId ?? "",
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: ["rating-x"],
        requestedBy: "foreign-actor",
      })
      .catch((error: unknown) => error);
    expect(transitionMiss).toBeInstanceOf(PlatformError);
  });

  test("ratings: immutable evaluation evidence (§14/M9/M10) — duplicates converge, conflicts fail closed", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, {
      executionId,
      subgraph: sparseConstantSubgraph(),
    });
    const target = outcome.findings.find((finding) => finding.class === "ai-removal");
    expect(target).toBeDefined();
    const finding = target as NonNullable<typeof target>;

    const rating = await analyzer.recordEvaluationRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId: outcome.analysis.analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId,
      promptId: outcome.prompts[0]?.promptId ?? null,
      rater: "developer-42",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      confidence: 0.8,
      rationale: "the observed constant output is preserved",
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: [...finding.targetNodeIds],
        findingClass: finding.class,
        population: finding.confidence.population,
      },
      evidenceRefs: ["obs:const-1"],
      provenance: { submittedVia: "pg-test" },
      schemaVersion: 1,
    });
    expect(rating.replayed).toBe(false);

    // A duplicate submission (same identity) converges.
    const replay = await analyzer.recordEvaluationRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId: outcome.analysis.analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId,
      promptId: outcome.prompts[0]?.promptId ?? null,
      rater: "developer-42",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      confidence: 0.8,
      rationale: "the observed constant output is preserved",
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: [...finding.targetNodeIds],
        findingClass: finding.class,
        population: finding.confidence.population,
      },
      evidenceRefs: ["obs:const-1"],
      provenance: { submittedVia: "pg-test" },
      schemaVersion: 1,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.ratingId).toBe(rating.ratingId);

    // A CONFLICTING re-rating of the same question fails closed.
    const conflict = await analyzer
      .recordEvaluationRating({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        analysisId: outcome.analysis.analysisId,
        findingId: finding.findingId,
        counterpartFindingId: null,
        executionId,
        promptId: null,
        rater: "developer-42",
        questionKind: "behavior-preservation",
        answer: "prefer-baseline",
        sourceRevision: REVISION,
        context: {
          repository: REPOSITORY,
          targetNodeIds: [...finding.targetNodeIds],
          findingClass: finding.class,
          population: finding.confidence.population,
        },
        evidenceRefs: ["obs:const-1"],
        provenance: { submittedVia: "pg-test" },
        schemaVersion: 1,
      })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(PlatformError);
    expect((conflict as PlatformError).code).toBe("IDEMPOTENCY_KEY_REUSED");

    // M10 (physical): a PASS-shaped answer is unrepresentable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.opportunity_ratings
              (id, analysis_id, finding_id, application_id, tenant_id, execution_id,
               prompt_id, rater, question_kind, answer, confidence, rationale,
               source_revision, context, evidence_refs, provenance, recorded_at,
               schema_version, fingerprint)
              VALUES ($1, $2, $3, $4, $5, $6, NULL, 'intruder', 'pair-preference',
                      'PASS', NULL, NULL, $7, $8::jsonb, '["x"]'::jsonb,
                      '{"submittedVia":"intruder"}'::jsonb, NOW(), 1, 'fp-x')`,
        parameters: [
          generateId(),
          outcome.analysis.analysisId,
          finding.findingId,
          world.applicationId,
          world.tenantId,
          executionId,
          REVISION,
          JSON.stringify({
            repository: REPOSITORY,
            targetNodeIds: ["llm-const"],
            findingClass: "ai-removal",
            population: 4,
          }),
        ],
      }),
    ).rejects.toThrow(/answer|vocabulary/i);

    // §14 (physical): rating rows are immutable (no update, no delete).
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.opportunity_ratings SET answer = 'prefer-baseline' WHERE id = $1`,
        parameters: [rating.ratingId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.opportunity_ratings WHERE id = $1`,
        parameters: [rating.ratingId],
      }),
    ).rejects.toThrow(/immutable/i);
  });

  test("M27/M28: ratings bind the real finding/analysis/execution and the analyzed revision", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, {
      executionId,
      subgraph: sparseConstantSubgraph(),
    });
    const finding = outcome.findings[0] as NonNullable<(typeof outcome.findings)[number]>;
    const ratingBase = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId: outcome.analysis.analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId,
      promptId: null,
      rater: "developer-7",
      questionKind: "pair-preference" as const,
      answer: "no-difference" as const,
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: [...finding.targetNodeIds],
        findingClass: finding.class,
        population: finding.confidence.population,
      },
      evidenceRefs: ["obs:const-1"],
      provenance: { submittedVia: "pg-test" },
      schemaVersion: 1,
    };

    // M28: a stale revision fails closed.
    const stale = await analyzer
      .recordEvaluationRating({ ...ratingBase, sourceRevision: "commit-stale-999" })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(PlatformError);

    // M27: a rating for a finding outside the analysis fails closed.
    const ghost = await analyzer
      .recordEvaluationRating({ ...ratingBase, findingId: generateId() })
      .catch((error: unknown) => error);
    expect(ghost).toBeInstanceOf(PlatformError);

    // M27: the analysis/execution binding is validated, not asserted.
    const wrongExecution = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const wrongExec = await analyzer
      .recordEvaluationRating({ ...ratingBase, executionId: wrongExecution })
      .catch((error: unknown) => error);
    expect(wrongExec).toBeInstanceOf(PlatformError);

    const good = await analyzer.recordEvaluationRating(ratingBase);
    expect(good.replayed).toBe(false);
  });

  test("the recommendation history: evidence-gated advisory -> candidate -> verified (M8/M15/M16/M18)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, {
      executionId,
      subgraph: sparseConstantSubgraph(),
    });
    const finding = outcome.findings.find(
      (candidate) => candidate.class === "ai-removal",
    ) as NonNullable<(typeof outcome.findings)[number]>;

    // A rating on the finding (the §14 evidence).
    const rating = await analyzer.recordEvaluationRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId: outcome.analysis.analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId,
      promptId: null,
      rater: "developer-9",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: [...finding.targetNodeIds],
        findingClass: finding.class,
        population: finding.confidence.population,
      },
      evidenceRefs: ["obs:const-1"],
      provenance: { submittedVia: "pg-test" },
      schemaVersion: 1,
    });

    // M16: evidence refs that do not resolve to recorded ratings are rejected.
    await expect(
      analyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: ["fabricated-rating"],
        requestedBy: "developer-9",
      }),
    ).rejects.toThrow(/fabricated|resolve/i);

    // The legal advisory -> candidate advance with REAL rating evidence.
    const advance = await analyzer.advanceFinding({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      findingId: finding.findingId,
      toState: "candidate",
      evidenceKind: "rating",
      evidenceRefs: [rating.ratingId],
      requestedBy: "developer-9",
    });
    expect(advance.replayed).toBe(false);
    const stateAfterCandidate = await ctx.port.execute<{ readonly state: string }>({
      sql: `SELECT state FROM learning.opportunity_findings WHERE id = $1`,
      parameters: [finding.findingId],
    });
    expect(stateAfterCandidate.rows[0]?.state).toBe("candidate");

    // M8: a LOW-confidence finding can never verify (sparse evidence).
    await expect(
      analyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: [rating.ratingId],
        verifiedEquivalence: {
          comparisonId: "cmp-1",
          comparedRevision: REVISION,
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp:1"],
        },
        requestedBy: "developer-9",
      }),
    ).rejects.toThrow(/low-confidence|confidence/i);
  });

  test("the verified transition over a medium+ confidence finding persists the full equivalence evidence (M15)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    // The §19 GREEN subgraph: population 40, verification + error rate
    // observed -> 'high' confidence.
    const outcome = await analyze(analyzer, world, { executionId });
    const finding = outcome.findings.find(
      (candidate) => candidate.class === "deterministic-replacement",
    ) as NonNullable<(typeof outcome.findings)[number]>;
    expect(finding.confidence.level).toBe("high");

    const rating = await analyzer.recordEvaluationRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId: outcome.analysis.analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId,
      promptId: null,
      rater: "developer-11",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: [...finding.targetNodeIds],
        findingClass: finding.class,
        population: finding.confidence.population,
      },
      evidenceRefs: ["execution:1:receipt"],
      provenance: { submittedVia: "pg-test" },
      schemaVersion: 1,
    });
    await analyzer.advanceFinding({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      findingId: finding.findingId,
      toState: "candidate",
      evidenceKind: "rating",
      evidenceRefs: [rating.ratingId],
      requestedBy: "developer-11",
    });

    // M28: a comparison at a different revision never verifies.
    await expect(
      analyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: {
          comparisonId: "cmp-1",
          comparedRevision: "commit-stale-999",
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp:1"],
        },
        requestedBy: "developer-11",
      }),
    ).rejects.toThrow(/revision/i);

    // M14: incomparable populations never verify.
    await expect(
      analyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: {
          comparisonId: "cmp-1",
          comparedRevision: REVISION,
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: false,
          evidenceRefs: ["cmp:1"],
        },
        requestedBy: "developer-11",
      }),
    ).rejects.toThrow(/comparable/i);

    const verified = await analyzer.advanceFinding({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      findingId: finding.findingId,
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
      requestedBy: "developer-11",
    });
    expect(verified.replayed).toBe(false);
    const stateAfterVerified = await ctx.port.execute<{ readonly state: string }>({
      sql: `SELECT state FROM learning.opportunity_findings WHERE id = $1`,
      parameters: [finding.findingId],
    });
    expect(stateAfterVerified.rows[0]?.state).toBe("verified");

    // The journal (the recommendation history) is append-only and ordered.
    const history = await analyzer
      .getAnalysis({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        analysisId: outcome.analysis.analysisId,
      })
      .then((report) =>
        report.findings.find((candidate) => candidate.findingId === finding.findingId),
      );
    expect(history?.state).toBe("verified");
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.opportunity_finding_transitions WHERE finding_id = $1`,
        parameters: [finding.findingId],
      }),
    ).rejects.toThrow(/immutable/i);
  });

  test("no unauthorized mutation: a direct state UPDATE without a journal row is rejected (M8/M16/M18)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, { executionId });
    const finding = outcome.findings[0] as NonNullable<(typeof outcome.findings)[number]>;

    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.opportunity_findings SET state = 'candidate' WHERE id = $1`,
        parameters: [finding.findingId],
      }),
    ).rejects.toThrow(/journal|transition/i);
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.opportunity_findings SET state = 'promoted' WHERE id = $1`,
        parameters: [finding.findingId],
      }),
    ).rejects.toThrow(/advance|promoted|state/i);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.opportunity_findings WHERE id = $1`,
        parameters: [finding.findingId],
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.opportunity_analyses SET finding_count = 999 WHERE id = $1`,
        parameters: [outcome.analysis.analysisId],
      }),
    ).rejects.toThrow(/immutable/i);

    // The analyzer itself never creates executions: the executions ledger
    // holds EXACTLY the executions the test drove through the authority.
    const executions = await ctx.port.execute<{ readonly count: string }>({
      sql: `SELECT count(*)::text AS count FROM executions.executions
            WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    expect(executions.rows[0]?.count).toBe("1");
    // ...and the analysis rows stay advisory (no promotion happened).
    const states = await ctx.port.execute<{ readonly state: string }>({
      sql: `SELECT state FROM learning.opportunity_findings WHERE application_id = $1`,
      parameters: [world.applicationId],
    });
    for (const row of states.rows) {
      expect(row.state).toBe("advisory");
    }
  });

  test("the physical closed vocabularies (born-advisory insert guard, equivalence, transition edges)", async () => {
    const { world, analyzer } = await seedAnalyzerWorld();
    const executionId = await seedRunningAnalysisExecution(world, REPOSITORY, REVISION);
    const outcome = await analyze(analyzer, world, { executionId });
    const finding = outcome.findings[0] as NonNullable<(typeof outcome.findings)[number]>;

    // A finding is BORN advisory only.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.opportunity_findings
              (id, analysis_id, application_id, tenant_id, finding_class, state,
               target_node_ids, reason_codes, evidence_refs, provenance, confidence,
               cost_impact, latency_impact, deterministic_equivalence, recommendation,
               recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, 'ai-addition', 'verified', '["n"]'::jsonb,
                      '["r"]'::jsonb, '["e"]'::jsonb,
                      '{"repository":"r","revision":"v","targets":[{"nodeId":"n","file":"f","symbol":null}]}'::jsonb,
                      '{"level":"high","population":40,"basis":"b"}'::jsonb,
                      '{"currentMicroUsd":null,"candidateMicroUsd":null,"expectedSavingsMicroUsd":null,"basis":"unknown","basisRefs":["e"]}'::jsonb,
                      '{"currentMs":null,"candidateMs":null,"basis":"unknown","basisRefs":["e"]}'::jsonb,
                      '{"potential":"none","basis":["b"]}'::jsonb,
                      '{"strategy":"s","validationSteps":["v"]}'::jsonb,
                      NOW(), 1)`,
        parameters: [
          generateId(),
          outcome.analysis.analysisId,
          world.applicationId,
          world.tenantId,
        ],
      }),
    ).rejects.toThrow(/advisory/i);

    // 'promoted' is not a state of this module (§18).
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.opportunity_findings
              (id, analysis_id, application_id, tenant_id, finding_class, state,
               target_node_ids, reason_codes, evidence_refs, provenance, confidence,
               cost_impact, latency_impact, deterministic_equivalence, recommendation,
               recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, 'ai-addition', 'promoted', '["n"]'::jsonb,
                      '["r"]'::jsonb, '["e"]'::jsonb,
                      '{"repository":"r","revision":"v","targets":[{"nodeId":"n","file":"f","symbol":null}]}'::jsonb,
                      '{"level":"high","population":40,"basis":"b"}'::jsonb,
                      '{"currentMicroUsd":null,"candidateMicroUsd":null,"expectedSavingsMicroUsd":null,"basis":"unknown","basisRefs":["e"]}'::jsonb,
                      '{"currentMs":null,"candidateMs":null,"basis":"unknown","basisRefs":["e"]}'::jsonb,
                      '{"potential":"none","basis":["b"]}'::jsonb,
                      '{"strategy":"s","validationSteps":["v"]}'::jsonb,
                      NOW(), 1)`,
        parameters: [
          generateId(),
          outcome.analysis.analysisId,
          world.applicationId,
          world.tenantId,
        ],
      }),
    ).rejects.toThrow(/state|vocabulary/i);

    // 'verified-equivalent' potential is unrepresentable at insert (M15/M16).
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.opportunity_findings
              SET deterministic_equivalence = jsonb_set(deterministic_equivalence, '{potential}', '"verified-equivalent"')
              WHERE id = $1`,
        parameters: [finding.findingId],
      }),
    ).rejects.toThrow();

    // The transition journal rejects the illegal edges physically.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.opportunity_finding_transitions
              (id, finding_id, application_id, tenant_id, from_state, to_state,
               evidence_kind, evidence_refs, verified_equivalence, requested_by,
               recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, 'advisory', 'verified', 'verified-equivalence',
                      '["e"]'::jsonb, NULL, 'actor', NOW(), 1)`,
        parameters: [
          `probe-illegal-${generateId().slice(0, 8)}`,
          finding.findingId,
          world.applicationId,
          world.tenantId,
        ],
      }),
    ).rejects.toThrow(/forward|edge|transition/i);
    // A verified transition without equivalence evidence is uninsertable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.opportunity_finding_transitions
              (id, finding_id, application_id, tenant_id, from_state, to_state,
               evidence_kind, evidence_refs, verified_equivalence, requested_by,
               recorded_at, schema_version)
              VALUES ($1, $2, $3, $4, 'candidate', 'verified', 'verified-equivalence',
                      '["e"]'::jsonb, NULL, 'actor', NOW(), 1)`,
        parameters: [
          `probe-noequiv-${generateId().slice(0, 8)}`,
          finding.findingId,
          world.applicationId,
          world.tenantId,
        ],
      }),
    ).rejects.toThrow(/equivalence|verified/i);
  });
});
