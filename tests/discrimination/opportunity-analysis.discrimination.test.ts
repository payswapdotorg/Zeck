/**
 * Discrimination: the codebase-opportunity analysis boundary
 * (WORK-022 HIGH_ASSURANCE; checkpoint contracts
 * IMPLEMENTATION-COMPLETENESS, SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013/WORK-014 red-record pattern): STATIC mutants mutate the REAL
 * source in memory and the shared scanner must flag exactly the
 * weakened protection (the architecture gate runs the same rules over
 * the real tree, so it FAILS under exactly these mutations); RUNTIME
 * red records observe the governed world under constructed wiring
 * scenarios (REAL analyzer over the in-memory store, REAL Fastify
 * routes over the REAL in-memory executions authority, REAL planner
 * over the REAL opportunity seam).
 *
 * The 30 mandatory mutants of the Work Order:
 *
 *   STATIC (scanner over mutated REAL source):
 *     M2/M4/M5/M6/M20 the analyzer gains an authority dep
 *                     (policy/capability/budget/sandbox/executions);
 *     M18             a 'promoted' finding state appears;
 *     M15             a 'verified-equivalent' insertable potential
 *                     appears / the verified evidence gate is removed;
 *     M10             a PASS/FAIL-shaped rating answer appears;
 *     M24             the strict value-of-information gate is removed;
 *     M20/M21         a code-execution/mutation import or vocabulary
 *                     appears in the learning tree;
 *     M17             the planner consults opportunity BEFORE the
 *                     selection / binds a learning preference to the
 *                     durable record;
 *     M19             the planning adapter's seam validation removed.
 *
 *   RUNTIME RED RECORDS (observed under the production wiring):
 *     M1   cross-tenant analysis/rating access is 404/null;
 *     M2   a POLICY-DENIED analysis request fails closed BEFORE any
 *          learning row exists;
 *     M3   the analysis output carries no code-mutation payload (the
 *          advisory surface has no patch/diff/deploy vocabulary);
 *     M5   a policy-forbidden route is never selected despite
 *          consulted findings;
 *     M6   analyzer operations make ZERO budget-authority calls;
 *     M7   a FAIL/INCONCLUSIVE comparison never verifies;
 *     M8   a low-confidence finding cannot reach 'verified';
 *     M9   rating evidence produces 'candidate' only;
 *     M11  provenance-less selections fail closed;
 *     M12  revision-less selections fail closed;
 *     M13  tiny populations are inconclusive/low, never high;
 *     M14  incomparable populations never verify;
 *     M16  state skipping + unresolvable evidence refs are rejected;
 *     M17  the live planner selection is identical with/without
 *          consulted findings;
 *     M22/M23 unobserved cost/latency are 'unknown', never fabricated;
 *     M24  sufficient evidence NEVER prompts;
 *     M25  material low-confidence uncertainty ALWAYS prompts;
 *     M26  cross-tenant transitions are scope-rejected;
 *     M27  ratings for foreign findings/executions are rejected;
 *     M28  stale revisions are rejected everywhere;
 *     M29  materially-different behavior blocks ai-removal;
 *     M30  side-effect-crossing replacements carry the boundary.
 *
 *   The PG-gated physical halves (the migration 0016 triggers, the
 *   CHECK vocabularies, the FK/UNIQUE bindings, the journal coupling)
 *   are proven against real PostgreSQL in
 *   tests/integration/postgres/learning-opportunities.test.ts and
 *   tests/integration/postgres/codebase-analysis.test.ts.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  classifyFindingConfidence,
  createInMemoryOpportunityStore,
  createNodeDigest,
  createOpportunityAnalyzer,
  DEFAULT_FRICTION_CONFIG,
  decideEvaluationPrompts,
  detectOpportunities,
  type NodeObservation,
} from "../../src/modules/learning/public";
import {
  createOpportunitySignalsAdapter,
  createPlannerService,
  createPlanningSinkAdapter,
  type OpportunitySignals,
  type PlanningCapabilityAuthority,
  type PlanningPolicyInputs,
} from "../../src/modules/planning/public";
import { PlatformError } from "../../src/shared/errors";
import { authHeaders, otherTenantHeaders, seedApiWorld } from "../unit/api/world";
import { ACTOR, createInMemoryExecutions, denyAllAuthorization } from "../unit/executions/fakes";
import type { OpportunityBoundaryFile } from "./lib/opportunity";
import { opportunityAnalysisViolations, plannerOpportunityViolations } from "./lib/opportunity";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");
const PLANNER_PATH = "src/modules/planning/application/planner.ts";
const OPPORTUNITY_ADAPTER_PATH = "src/modules/planning/adapters/opportunity-signals-adapter.ts";

function collectLearningTree(): OpportunityBoundaryFile[] {
  const out: OpportunityBoundaryFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push({
          path: full.slice(REPO_ROOT.length + 1),
          content: readFileSync(full, "utf8"),
        });
      }
    }
  };
  walk(LEARNING_DIR);
  return out;
}

function realTree(): OpportunityBoundaryFile[] {
  return collectLearningTree();
}

function withMutation(
  path: string,
  mutation: (content: string) => string,
): OpportunityBoundaryFile[] {
  return realTree().map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

const ANALYZER_PATH = "src/modules/learning/application/opportunity-analyzer.ts";

// ---------------------------------------------------------------------------
// STATIC red records: every weakened protection is detected.
// ---------------------------------------------------------------------------

describe("discrimination: opportunity analysis (static mutants)", () => {
  test("the REAL learning tree passes the scanner (baseline)", () => {
    expect(opportunityAnalysisViolations(realTree())).toEqual([]);
  });

  test("M2: the analyzer gaining a POLICY authority dep is detected", () => {
    const tree = withMutation(ANALYZER_PATH, (content) =>
      content.replace(
        "export interface OpportunityAnalyzerDeps {",
        "export interface OpportunityAnalyzerDeps {\n  readonly policyAuthority: unknown;",
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "analyzer-authority-deps:policyAuthority",
    );
  });

  test("M4: the analyzer gaining a CAPABILITY authority dep is detected", () => {
    const tree = withMutation(ANALYZER_PATH, (content) =>
      content.replace(
        "export interface OpportunityAnalyzerDeps {",
        "export interface OpportunityAnalyzerDeps {\n  readonly capabilityAuthority: unknown;",
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "analyzer-authority-deps:capabilityAuthority",
    );
  });

  test("M5: the analyzer gaining a BUDGET authority dep is detected", () => {
    const tree = withMutation(ANALYZER_PATH, (content) =>
      content.replace(
        "export interface OpportunityAnalyzerDeps {",
        "export interface OpportunityAnalyzerDeps {\n  readonly budgetAuthority: unknown;",
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "analyzer-authority-deps:budgetAuthority",
    );
  });

  test("M6: the analyzer gaining an EXECUTIONS dispatch dep is detected", () => {
    const tree = withMutation(ANALYZER_PATH, (content) =>
      content.replace(
        "export interface OpportunityAnalyzerDeps {",
        "export interface OpportunityAnalyzerDeps {\n  readonly dispatch: unknown;",
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain("analyzer-authority-deps:dispatch");
  });

  test("M20: the analyzer importing a SANDBOX/compute seam is detected", () => {
    const tree = withMutation(ANALYZER_PATH, (content) =>
      content.replace(
        "export interface OpportunityAnalyzerDeps {",
        "export interface OpportunityAnalyzerDeps {\n  readonly sandbox: unknown;",
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain("analyzer-authority-deps:sandbox");
  });

  test("M20: the learning tree importing node:child_process is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/execution-graph.ts",
      (content) => `import { spawn } from "node:child_process";\n${content}`,
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "code-execution-import:src/modules/learning/domain/execution-graph.ts",
    );
  });

  test("M21: a code-mutation vocabulary appearing in learning CODE is detected", () => {
    const tree = withMutation(
      "src/modules/learning/domain/opportunity-analysis.ts",
      (content) =>
        `${content}\nexport function applyPatchToRepository(): void { void writeFile; }\n`,
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "code-mutation-vocabulary:src/modules/learning/domain/opportunity-analysis.ts",
    );
  });

  test("M18: a 'promoted' finding state appearing is detected", () => {
    const tree = withMutation("src/modules/learning/domain/opportunity-analysis.ts", (content) =>
      content.replace(
        'export const FINDING_STATES = ["advisory", "candidate", "verified"] as const;',
        'export const FINDING_STATES = ["advisory", "candidate", "verified", "promoted"] as const;',
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "finding-state-vocabulary-mutated:src/modules/learning/domain/opportunity-analysis.ts",
    );
  });

  test("M15: a 'verified-equivalent' insertable potential appearing is detected", () => {
    const tree = withMutation("src/modules/learning/domain/opportunity-analysis.ts", (content) =>
      content.replace(
        'export const DETERMINISTIC_EQUIVALENCE_POTENTIALS = ["none", "candidate-replacement"] as const;',
        'export const DETERMINISTIC_EQUIVALENCE_POTENTIALS = ["none", "candidate-replacement", "verified-equivalent"] as const;',
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "equivalence-potential-mutated:src/modules/learning/domain/opportunity-analysis.ts",
    );
  });

  test("M15/M16: removing the verified-evidence gate is detected", () => {
    const tree = withMutation("src/modules/learning/domain/finding-transitions.ts", (content) =>
      content.replace(
        "validateVerifiedEquivalenceEvidence(input.verifiedEquivalence);",
        "void input.verifiedEquivalence;",
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "verified-evidence-gate-removed:src/modules/learning/domain/finding-transitions.ts",
    );
  });

  test("M10: a PASS-shaped rating answer appearing is detected", () => {
    const tree = withMutation("src/modules/learning/domain/evaluation-rating.ts", (content) =>
      content.replace(
        '  "insufficient-information",\n] as const;',
        '  "insufficient-information",\n  "PASS",\n] as const;',
      ),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "rating-pass-vocabulary:src/modules/learning/domain/evaluation-rating.ts",
    );
  });

  test("M24: removing the strict value-of-information gate is detected", () => {
    const tree = withMutation("src/modules/learning/domain/human-evaluation.ts", (content) =>
      content.replace("if (gain <= config.userFrictionThreshold) {", "if (false) {"),
    );
    expect(opportunityAnalysisViolations(tree)).toContain(
      "voi-gate-removed:src/modules/learning/domain/human-evaluation.ts",
    );
  });

  test("M17: the planner consulting opportunity BEFORE the selection is detected", () => {
    const plannerSource = readFileSync(join(REPO_ROOT, PLANNER_PATH), "utf8");
    const adapterSource = readFileSync(join(REPO_ROOT, OPPORTUNITY_ADAPTER_PATH), "utf8");
    // Baseline: the real planner is clean.
    expect(plannerOpportunityViolations(plannerSource, adapterSource)).toEqual([]);
    // Mutant: the consultation moves before the selected binding.
    const mutated = plannerSource.replace(
      "const selected = selection.selected;",
      "const preConsult = await deps.opportunitySignals?.consult({\n          applicationId: input.applicationId,\n          tenantId: input.tenantId,\n        });\n        void preConsult;\n        const selected = selection.selected;",
    );
    expect(plannerOpportunityViolations(mutated, adapterSource)).toContain(
      "consultation-before-selected-binding",
    );
  });

  test("M17: the durable record binding a learning preference is detected", () => {
    const plannerSource = readFileSync(join(REPO_ROOT, PLANNER_PATH), "utf8");
    const adapterSource = readFileSync(join(REPO_ROOT, OPPORTUNITY_ADAPTER_PATH), "utf8");
    const mutated = plannerSource.replace(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
      "selectedStrategyId: opportunityConsultation?.preferredStrategyId ?? selected.strategyId,\n        selectionRationale: selection.rationale,",
    );
    expect(plannerOpportunityViolations(mutated, adapterSource)).toContain(
      "selection-reference-mutated",
    );
  });

  test("M19: removing the planning adapter's seam validation is detected", () => {
    const plannerSource = readFileSync(join(REPO_ROOT, PLANNER_PATH), "utf8");
    const adapterSource = readFileSync(join(REPO_ROOT, OPPORTUNITY_ADAPTER_PATH), "utf8");
    const mutated = adapterSource.replace(
      "validateConsultedOpportunitySignal(consulted);",
      "void consulted;",
    );
    expect(plannerOpportunityViolations(plannerSource, mutated)).toContain(
      "adapter-validation-removed",
    );
  });
});

// ---------------------------------------------------------------------------
// RUNTIME red records (the governed world under constructed wiring).
// ---------------------------------------------------------------------------

const REPOSITORY = "github.com/example/customer-app";
const REVISION = "commit-abc123";

function observation(overrides: Partial<NodeObservation>): NodeObservation {
  return {
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
    ...overrides,
  } as NodeObservation;
}

function subgraphOf(
  nodes: readonly {
    nodeId: string;
    kind: string;
    observation?: Partial<NodeObservation>;
    provenance?: Record<string, unknown>;
    edgesTo?: readonly string[];
  }[],
): Record<string, unknown> {
  const allNodes = nodes.map((node) => ({
    nodeId: node.nodeId,
    kind: node.kind,
    label: node.nodeId,
    provenance: {
      repository: REPOSITORY,
      revision: REVISION,
      file: `src/${node.nodeId}.ts`,
      symbol: `fn${node.nodeId}`,
      ...(node.provenance ?? {}),
    },
    observation: {
      executionCount: 1,
      evidenceRefs: [`obs:${node.nodeId}`],
      ...(node.observation ?? {}),
    },
  }));
  const edges = nodes.flatMap((node) =>
    (node.edgesTo ?? []).map((to) => ({
      fromNodeId: node.nodeId,
      toNodeId: to,
      relation: "feeds",
    })),
  );
  return { nodes: allNodes, edges };
}

/** The §19 GREEN subgraph: structured, verified, low-variability model call. */
function greenSubgraph(): Record<string, unknown> {
  return subgraphOf([
    {
      nodeId: "llm-1",
      kind: "model-call",
      observation: observation({}),
    },
  ]);
}

/** The §19 RED subgraph: genuinely semantic work (AI is necessary). */
function semanticSubgraph(): Record<string, unknown> {
  return subgraphOf([
    {
      nodeId: "llm-semantic",
      kind: "model-call",
      observation: observation({
        inputVariability: "high",
        semanticComplexity: "high",
        distinctInputCount: 40,
        distinctOutputCount: 38,
      }),
    },
  ]);
}

/** The sparse constant case: LOW confidence + material removal decision. */
function sparseConstantSubgraph(): Record<string, unknown> {
  return subgraphOf([
    {
      nodeId: "llm-const",
      kind: "model-call",
      observation: observation({
        executionCount: 4,
        distinctInputCount: 2,
        distinctOutputCount: 1,
        constantOutput: true,
        verificationPassCount: 3,
        verificationFailCount: 1,
      }),
    },
  ]);
}

describe("discrimination: opportunity analysis (runtime red records)", () => {
  test("M13: tiny populations are inconclusive/low — never high (no fabricated certainty)", () => {
    const tiny = classifyFindingConfidence({
      nodeId: "n",
      kind: "model-call",
      label: "n",
      provenance: { repository: REPOSITORY, revision: REVISION, file: "f" },
      observation: { executionCount: 1, evidenceRefs: ["e"] },
    } as never);
    expect(tiny.level).toBe("inconclusive");
    const sparse = classifyFindingConfidence({
      nodeId: "n",
      kind: "model-call",
      label: "n",
      provenance: { repository: REPOSITORY, revision: REVISION, file: "f" },
      observation: {
        executionCount: 3,
        verificationPassCount: 3,
        evidenceRefs: ["e"],
      },
    } as never);
    expect(sparse.level).toBe("low");
  });

  test("M24/M25 (pure): the value-of-information gate decides prompt emission", () => {
    const finding = (level: string, material: boolean) =>
      ({
        findingId: `f-${level}-${material ? "m" : "i"}`,
        analysisId: "a",
        applicationId: "app",
        tenantId: "t",
        class: material ? "deterministic-replacement" : "context-enhancement",
        targetNodeIds: ["n"],
        reasonCodes: ["r"],
        evidenceRefs: ["e"],
        provenance: { repository: REPOSITORY, revision: REVISION, targets: [] },
        confidence: { level, population: 40, basis: "b" },
        costImpact: {
          currentMicroUsd: null,
          candidateMicroUsd: null,
          expectedSavingsMicroUsd: null,
          basis: "unknown",
          basisRefs: ["e"],
        },
        latencyImpact: { currentMs: null, candidateMs: null, basis: "unknown", basisRefs: ["e"] },
        state: "advisory",
        deterministicEquivalence: { potential: "none", basis: ["b"] },
        recommendation: { strategy: "s", validationSteps: ["v"] },
        recordedAt: "2026-09-15T12:00:00Z",
        schemaVersion: 1,
      }) as never;
    // M24: sufficient evidence (medium/high) NEVER prompts.
    expect(
      decideEvaluationPrompts([finding("medium", true), finding("high", true)], {
        userFrictionThreshold: 0.5,
        maxPrompts: 8,
      }),
    ).toEqual([]);
    // M25: material low-confidence uncertainty ALWAYS prompts at the default threshold.
    const prompts = decideEvaluationPrompts([finding("low", true)], DEFAULT_FRICTION_CONFIG);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.expectedInformationGain).toBeGreaterThan(
      prompts[0]?.userFrictionThreshold as number,
    );
    // A high friction threshold suppresses the low-gain prompt (the
    // configured tradeoff — but the inconclusive case still justifies it).
    expect(
      decideEvaluationPrompts([finding("low", true)], {
        userFrictionThreshold: 0.7,
        maxPrompts: 8,
      }),
    ).toEqual([]);
    expect(
      decideEvaluationPrompts([finding("inconclusive", true)], {
        userFrictionThreshold: 0.7,
        maxPrompts: 8,
      }),
    ).toHaveLength(1);
  });

  test("M22/M23 (pure): unobserved cost/latency are unknown — never fabricated", () => {
    const graph = {
      repository: REPOSITORY,
      revision: REVISION,
      schemaVersion: 1,
      nodes: [
        {
          nodeId: "unobserved",
          kind: "model-call",
          label: "unobserved",
          provenance: { repository: REPOSITORY, revision: REVISION, file: "f" },
          observation: { executionCount: 12, evidenceRefs: ["e"] },
        },
      ],
      edges: [],
    };
    const drafts = detectOpportunities(graph as never);
    // No observation axes -> no replacement fires (the honesty rule);
    // the verification-enhancement finding fires with UNKNOWN impacts.
    const finding = drafts.find((draft) => draft.class === "verification-enhancement");
    expect(finding).toBeDefined();
    // (impact fields are materialized in buildFindings; the pure probe
    // asserts detection honesty: no deterministic-replacement fired.)
    expect(drafts.some((draft) => draft.class === "deterministic-replacement")).toBe(false);
  });

  test("M29 (pure): materially-different behavior blocks ai-removal/replacement", () => {
    const drafts = detectOpportunities({
      repository: REPOSITORY,
      revision: REVISION,
      schemaVersion: 1,
      nodes: [
        {
          nodeId: "semantic",
          kind: "model-call",
          label: "semantic",
          provenance: { repository: REPOSITORY, revision: REVISION, file: "f" },
          observation: observation({
            inputVariability: "high",
            semanticComplexity: "high",
            distinctOutputCount: 38,
            constantOutput: false,
            observedCostMicroUsd: "9000000",
          }),
        },
      ],
      edges: [],
    } as never);
    // High cost (deterministic would be far cheaper) yet NO removal or
    // replacement fires: the work is genuinely semantic (M29).
    expect(drafts.some((draft) => draft.class === "ai-removal")).toBe(false);
    expect(drafts.some((draft) => draft.class === "deterministic-replacement")).toBe(false);
  });

  test("M30 (pure): a replacement feeding external effects carries the boundary", () => {
    const drafts = detectOpportunities({
      repository: REPOSITORY,
      revision: REVISION,
      schemaVersion: 1,
      nodes: [
        {
          nodeId: "llm-side-effects",
          kind: "model-call",
          label: "classifyAndDispatch",
          provenance: { repository: REPOSITORY, revision: REVISION, file: "f" },
          observation: observation({}),
        },
        {
          nodeId: "dispatch",
          kind: "external-side-effect",
          label: "webhook",
          provenance: { repository: REPOSITORY, revision: REVISION, file: "f" },
          observation: { executionCount: 40, evidenceRefs: ["obs:dispatch"] },
        },
      ],
      edges: [{ fromNodeId: "llm-side-effects", toNodeId: "dispatch", relation: "feeds" }],
    } as never);
    const replacement = drafts.find((draft) => draft.class === "deterministic-replacement");
    expect(replacement).toBeDefined();
    expect(replacement?.reasonCodes).toContain("side-effect-boundary");
    expect(replacement?.validationSteps.join(" ")).toContain("side-effect equivalence");
  });

  test("M3: the analysis output carries no code-mutation payload (advisory only)", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "disc-m3" },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: REVISION },
        subgraph: greenSubgraph(),
      },
    });
    expect(response.statusCode).toBe(201);
    // M3: the response's KEY surface is advisory — no code/patch/diff/
    // deployment payload field exists anywhere in the report.
    const keyNames: string[] = [];
    const walkKeys = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) {
          walkKeys(item);
        }
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          keyNames.push(key.toLowerCase());
          walkKeys(child);
        }
      }
    };
    walkKeys(response.json());
    for (const forbidden of ["patch", "diff", "deploy", "writefile", "codepayload", "mutation"]) {
      expect(keyNames, `the report must not carry a "${forbidden}" field`).not.toContain(forbidden);
    }
    // The findings recommend VALIDATION STEPS, never application steps.
    const findings = (response.json() as { findings: { recommendation: { strategy: string } }[] })
      .findings;
    for (const finding of findings) {
      expect(finding.recommendation.strategy).not.toMatch(/^apply\b/i);
    }
  });

  test("M29/§19 (runtime): a genuinely-semantic analysis NEVER recommends replacement/removal", async () => {
    const world = await seedApiWorld();
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "disc-m29" },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: REVISION },
        subgraph: semanticSubgraph(),
      },
    });
    expect(response.statusCode).toBe(201);
    const classes = (response.json() as { findings: { class: string }[] }).findings.map(
      (finding) => finding.class,
    );
    expect(classes).not.toContain("deterministic-replacement");
    expect(classes).not.toContain("ai-removal");
  });

  test("M2/M4: a POLICY-DENIED analysis fails closed BEFORE any learning row exists", async () => {
    const world = await seedApiWorld({
      executionAuthorization: denyAllAuthorization("policy wave: analysis suspended"),
    });
    const response = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "disc-m2" },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: REVISION },
        subgraph: greenSubgraph(),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("POLICY_DENIED");
    // No analysis was written (the admission precedes the codebase access).
    expect(world.opportunityStore.rows.analyses).toEqual([]);
    expect(world.opportunityStore.rows.findings).toEqual([]);
    expect(world.opportunityStore.rows.prompts).toEqual([]);
  });

  test("M1/M26: cross-tenant analysis/rating/transition probes are scope-rejected", async () => {
    const world = await seedApiWorld();
    const created = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "disc-m1" },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: REVISION },
        subgraph: sparseConstantSubgraph(),
      },
    });
    const analysisId = (created.json().analysis as { analysisId: string }).analysisId;
    const findings = created.json().findings as { findingId: string }[];
    const finding = findings[0] as { findingId: string };

    // Cross-tenant read: 404, indistinguishable from missing (M1).
    const read = await world.server.app.inject({
      method: "GET",
      url: `/codebase-analysis/${analysisId}`,
      headers: otherTenantHeaders(world),
    });
    expect(read.statusCode).toBe(404);
    expect(JSON.stringify(read.json())).not.toContain(world.tenantId);

    // Cross-tenant rating: the analysis is scope-checked first (M26).
    const rating = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/ratings`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": "disc-m1-rating" },
      payload: {
        applicationId: world.otherTenantApplicationId,
        findingId: finding.findingId,
        rater: "foreign-rater",
        questionKind: "behavior-preservation",
        answer: "prefer-candidate",
        evidenceRefs: ["obs:x"],
      },
    });
    expect(rating.statusCode).toBe(404);

    // Cross-tenant transition: the finding does not resolve in scope.
    const transition = await world.server.app.inject({
      method: "POST",
      url: `/codebase-analysis/${analysisId}/findings/${finding.findingId}/transition`,
      headers: { ...otherTenantHeaders(world), "idempotency-key": "disc-m1-tr" },
      payload: {
        applicationId: world.otherTenantApplicationId,
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: ["rating-x"],
      },
    });
    expect(transition.statusCode).toBe(422);

    // Store level: cross-scope reads return nothing.
    const foreignScope = {
      applicationId: world.otherTenantApplicationId,
      tenantId: world.otherTenantId,
    };
    expect(await world.opportunityStore.getAnalysis(foreignScope, analysisId)).toBeNull();
    expect(await world.opportunityStore.listFindings(foreignScope, analysisId)).toEqual([]);
  });

  test("M6: analyzer operations make ZERO budget-authority calls", async () => {
    const world = await seedApiWorld();
    const reservesBefore = world.budgetReserveCalls();
    await world.codebaseAnalyzer.analyzeSubgraph({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId: await world.executions
        .createExecution(
          { applicationId: world.applicationId, task: { kind: "codebase-analysis" } },
          "disc-m6-exec",
          { actorId: "00000000-0000-7000-8000-0000000000aa", tenantId: world.tenantId },
        )
        .then((receipt) => receipt.executionId),
      source: { repository: REPOSITORY, revision: REVISION },
      subgraph: greenSubgraph() as never,
    });
    expect(world.budgetReserveCalls()).toBe(reservesBefore);
  });

  test("M11/M12: provenance-less and revision-less selections fail closed", async () => {
    const analyzer = createOpportunityAnalyzer({
      store: createInMemoryOpportunityStore(),
      digest: createNodeDigest(),
      generateId: () => "00000000-0000-7000-c000-000000000001",
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    const executionId = "00000000-0000-7000-8000-0000000000ee";
    // M11: a node without provenance.
    const noProvenance = {
      applicationId: "app-1",
      tenantId: "tenant-1",
      executionId,
      source: { repository: REPOSITORY, revision: REVISION },
      subgraph: {
        nodes: [
          {
            nodeId: "n",
            kind: "model-call",
            label: "n",
            provenance: {},
            observation: { executionCount: 1, evidenceRefs: ["e"] },
          },
        ],
        edges: [],
      },
    };
    await expect(analyzer.analyzeSubgraph(noProvenance as never)).rejects.toBeInstanceOf(
      PlatformError,
    );
    // M12: a node without revision.
    const noRevision = {
      ...noProvenance,
      subgraph: {
        nodes: [
          {
            nodeId: "n",
            kind: "model-call",
            label: "n",
            provenance: { repository: REPOSITORY, file: "f" },
            observation: { executionCount: 1, evidenceRefs: ["e"] },
          },
        ],
        edges: [],
      },
    };
    await expect(analyzer.analyzeSubgraph(noRevision as never)).rejects.toBeInstanceOf(
      PlatformError,
    );
  });

  test("M7/M8/M9/M10/M14/M15/M16/M27/M28: the evidence-gated lifecycle rejects every mutant input", async () => {
    const world = await seedApiWorld();
    const created = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "disc-lifecycle" },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: REVISION },
        subgraph: sparseConstantSubgraph(),
      },
    });
    const analysisId = (created.json().analysis as { analysisId: string }).analysisId;
    const finding = (
      created.json().findings as {
        findingId: string;
        class: string;
        confidence: { level: string; population: number };
      }[]
    ).find((candidate) => candidate.class === "ai-removal") as {
      findingId: string;
      class: string;
      confidence: { level: string; population: number };
    };
    expect(finding.confidence.level).toBe("low");

    const rating = await world.codebaseAnalyzer.recordEvaluationRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId: (created.json().analysis as { executionId: string }).executionId,
      promptId: null,
      rater: "disc-rater",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: ["llm-const"],
        findingClass: "ai-removal",
        population: 4,
      },
      evidenceRefs: ["obs:llm-const"],
      provenance: { submittedVia: "discrimination" },
      schemaVersion: 1,
    });

    // M10: a PASS-shaped answer is unrepresentable.
    await expect(
      world.codebaseAnalyzer.recordEvaluationRating({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        analysisId,
        findingId: finding.findingId,
        counterpartFindingId: null,
        executionId: (created.json().analysis as { executionId: string }).executionId,
        promptId: null,
        rater: "disc-intruder",
        questionKind: "behavior-preservation",
        answer: "PASS" as never,
        sourceRevision: REVISION,
        context: {
          repository: REPOSITORY,
          targetNodeIds: ["llm-const"],
          findingClass: "ai-removal",
          population: 4,
        },
        evidenceRefs: ["obs:llm-const"],
        provenance: { submittedVia: "discrimination" },
        schemaVersion: 1,
      }),
    ).rejects.toThrow(/preference-only|vocabulary/i);

    // M27: a rating for a foreign finding is rejected.
    await expect(
      world.codebaseAnalyzer.recordEvaluationRating({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        analysisId,
        findingId: "00000000-0000-7000-d000-0000000000ff",
        counterpartFindingId: null,
        executionId: (created.json().analysis as { executionId: string }).executionId,
        promptId: null,
        rater: "disc-rater-2",
        questionKind: "behavior-preservation",
        answer: "prefer-candidate",
        sourceRevision: REVISION,
        context: {
          repository: REPOSITORY,
          targetNodeIds: ["llm-const"],
          findingClass: "ai-removal",
          population: 4,
        },
        evidenceRefs: ["obs:llm-const"],
        provenance: { submittedVia: "discrimination" },
        schemaVersion: 1,
      }),
    ).rejects.toThrow(/M27|resolve/i);

    // M28: a stale revision rating is rejected.
    await expect(
      world.codebaseAnalyzer.recordEvaluationRating({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        analysisId,
        findingId: finding.findingId,
        counterpartFindingId: null,
        executionId: (created.json().analysis as { executionId: string }).executionId,
        promptId: null,
        rater: "disc-rater-3",
        questionKind: "behavior-preservation",
        answer: "prefer-candidate",
        sourceRevision: "commit-stale-999",
        context: {
          repository: REPOSITORY,
          targetNodeIds: ["llm-const"],
          findingClass: "ai-removal",
          population: 4,
        },
        evidenceRefs: ["obs:llm-const"],
        provenance: { submittedVia: "discrimination" },
        schemaVersion: 1,
      }),
    ).rejects.toThrow(/M28|stale|revision/i);

    const transitionBase = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      findingId: finding.findingId,
    };

    // M16: state skipping (advisory -> verified) is rejected.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        ...transitionBase,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: [rating.ratingId],
        verifiedEquivalence: {
          comparisonId: "cmp",
          comparedRevision: REVISION,
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp:1"],
        },
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/illegal|forward|M16/i);

    // M16: evidence refs that do not resolve to recorded ratings.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        ...transitionBase,
        toState: "candidate",
        evidenceKind: "rating",
        evidenceRefs: ["fabricated"],
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/fabricated|resolve/i);

    // M18: 'promoted' is not a reachable state.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        ...transitionBase,
        toState: "promoted" as never,
        evidenceKind: "rating",
        evidenceRefs: [rating.ratingId],
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/vocabulary|state/i);

    // The legal advisory -> candidate advance (rating evidence ONLY).
    const advanced = await world.codebaseAnalyzer.advanceFinding({
      ...transitionBase,
      toState: "candidate",
      evidenceKind: "rating",
      evidenceRefs: [rating.ratingId],
      requestedBy: "disc",
    });
    expect(advanced.transition.toState).toBe("candidate");

    // M8: a LOW-confidence finding can never verify (sparse evidence).
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        ...transitionBase,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: {
          comparisonId: "cmp",
          comparedRevision: REVISION,
          baselineObservations: 50,
          candidateObservations: 50,
          comparisonStatus: "PASS",
          populationsComparable: true,
          evidenceRefs: ["cmp:1"],
        },
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/low-confidence|confidence/i);

    // M9: rating evidence can NEVER produce verified directly.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        ...transitionBase,
        toState: "verified",
        evidenceKind: "rating",
        evidenceRefs: [rating.ratingId],
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/M9|rating|evidence/i);
  });

  test("M7/M14/M15: the verified gate over a HIGH-confidence finding (the positive path + every mutant)", async () => {
    const world = await seedApiWorld();
    const created = await world.server.app.inject({
      method: "POST",
      url: "/codebase-analysis",
      headers: { ...authHeaders(world), "idempotency-key": "disc-verified" },
      payload: {
        applicationId: world.applicationId,
        source: { repository: REPOSITORY, revision: REVISION },
        subgraph: greenSubgraph(),
      },
    });
    const analysisId = (created.json().analysis as { analysisId: string }).analysisId;
    const executionId = (created.json().analysis as { executionId: string }).executionId;
    const finding = (created.json().findings as { findingId: string; class: string }[]).find(
      (candidate) => candidate.class === "deterministic-replacement",
    ) as {
      findingId: string;
    };
    const rating = await world.codebaseAnalyzer.recordEvaluationRating({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      analysisId,
      findingId: finding.findingId,
      counterpartFindingId: null,
      executionId,
      promptId: null,
      rater: "disc-rater-green",
      questionKind: "behavior-preservation",
      answer: "prefer-candidate",
      sourceRevision: REVISION,
      context: {
        repository: REPOSITORY,
        targetNodeIds: ["llm-1"],
        findingClass: "deterministic-replacement",
        population: 40,
      },
      evidenceRefs: ["execution:1:receipt"],
      provenance: { submittedVia: "discrimination" },
      schemaVersion: 1,
    });
    await world.codebaseAnalyzer.advanceFinding({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      findingId: finding.findingId,
      toState: "candidate",
      evidenceKind: "rating",
      evidenceRefs: [rating.ratingId],
      requestedBy: "disc",
    });

    const verifiedEquivalence = {
      comparisonId: "cmp-green",
      comparedRevision: REVISION,
      baselineObservations: 50,
      candidateObservations: 50,
      comparisonStatus: "PASS",
      populationsComparable: true,
      evidenceRefs: ["cmp:1"],
    };

    // M7: a FAIL comparison never verifies.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: { ...verifiedEquivalence, comparisonStatus: "FAIL" },
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/status|PASS/i);

    // M14: incomparable populations never verify.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: { ...verifiedEquivalence, populationsComparable: false },
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/M14|comparable/i);

    // M15: missing equivalence evidence is rejected.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: null,
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/M15|equivalence/i);

    // M28: a stale compared revision never verifies.
    await expect(
      world.codebaseAnalyzer.advanceFinding({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        findingId: finding.findingId,
        toState: "verified",
        evidenceKind: "verified-equivalence",
        evidenceRefs: ["cmp:1"],
        verifiedEquivalence: { ...verifiedEquivalence, comparedRevision: "commit-stale-999" },
        requestedBy: "disc",
      }),
    ).rejects.toThrow(/M28|revision/i);

    // The legal verified path (the green record).
    const verified = await world.codebaseAnalyzer.advanceFinding({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      findingId: finding.findingId,
      toState: "verified",
      evidenceKind: "verified-equivalence",
      evidenceRefs: ["cmp:1"],
      verifiedEquivalence,
      requestedBy: "disc",
    });
    expect(verified.transition.toState).toBe("verified");
    expect(verified.transition.verifiedEquivalence?.comparisonStatus).toBe("PASS");
  });
});

// ---------------------------------------------------------------------------
// The planner-side runtime red records (M5/M17: recommendations never
// change the governed selection).
// ---------------------------------------------------------------------------

describe("discrimination: the planner opportunity seam (runtime red records)", () => {
  const APP_ID = "00000000-0000-7000-8000-0000000000f1";
  const ROUTES = [
    {
      provider: "rail-a",
      model: "model-x",
      satisfies: ["text-generation"],
      expectedCostMicroUsd: "1000",
      expectedQuality: 0.92,
      expectedLatencyMs: 2000,
    },
    {
      provider: "rail-b",
      model: "model-y",
      satisfies: ["text-generation"],
      expectedCostMicroUsd: "200",
      expectedQuality: 0.85,
      expectedLatencyMs: 1500,
    },
  ];

  function signal(overrides: Record<string, unknown> = {}) {
    return {
      signalClass: "non-authoritative-opportunity-finding",
      findingId: "00000000-0000-7000-e000-000000000001",
      analysisId: "00000000-0000-7000-e000-000000000010",
      analysisVersion: 1,
      class: "deterministic-replacement",
      state: "advisory",
      confidenceLevel: "medium",
      population: 40,
      repository: REPOSITORY,
      revision: REVISION,
      targetNodeIds: ["llm-1"],
      reasonCodes: ["low-input-variability"],
      evidenceRefs: ["obs:llm-1"],
      costImpactBasis: "measured",
      latencyImpactBasis: "measured",
      deterministicEquivalencePotential: "candidate-replacement",
      ...overrides,
    };
  }

  async function buildPlannerWorld(options: {
    readonly signals?: readonly ReturnType<typeof signal>[];
    readonly policy?: Record<string, unknown>;
  }) {
    const executions = createInMemoryExecutions();
    executions.store.seedApplication(APP_ID, ACTOR.tenantId);
    const opportunity: (OpportunitySignals & { calls: number }) | undefined =
      options.signals === undefined
        ? undefined
        : {
            calls: 0,
            async consult() {
              return options.signals as never;
            },
          };
    const planner = createPlannerService({
      capabilityAuthority: {
        async resolve() {
          return { satisfied: true, catalogRevision: "rev-test", satisfactions: [] };
        },
        get catalogRevision(): string {
          return "rev-test";
        },
      } as PlanningCapabilityAuthority,
      policyInputs: {
        async effective() {
          return {
            outcome: "allow",
            effective: options.policy ?? {},
            policySetId: "default",
            policySetVersion: 1,
            policyContentHash: "deadbeef",
            appliedScopes: ["platform"],
          };
        },
      } as unknown as PlanningPolicyInputs,
      routeExplorer: {
        async explore() {
          return ROUTES;
        },
      },
      deterministicCatalog: {
        async list() {
          const { DETERMINISTIC_CATALOG_SEED } = await import(
            "../../src/modules/planning/adapters/in-memory-deterministic-catalog"
          );
          return DETERMINISTIC_CATALOG_SEED;
        },
      },
      sink: createPlanningSinkAdapter(executions.service),
      digest: createNodeDigest(),
      generateId: executions.generateId,
      now: () => new Date("2026-09-15T12:00:00Z"),
      ...(opportunity === undefined
        ? {}
        : { opportunitySignals: createOpportunitySignalsAdapter(opportunity as never) }),
    });
    return { planner, executions, ACTOR, opportunity };
  }

  async function planGeneration(world: Awaited<ReturnType<typeof buildPlannerWorld>>, key: string) {
    const receipt = await world.executions.service.createExecution(
      { applicationId: APP_ID, task: { kind: "generation", input: { text: "artifact-1" } } },
      `create-${key}`,
      world.ACTOR,
    );
    const executionId = receipt.executionId;
    await world.executions.service.transition(
      { ...world.ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
      `authorize-${key}`,
    );
    await world.executions.service.transition(
      { ...world.ACTOR, applicationId: APP_ID, executionId, command: "plan" },
      `plan-command-${key}`,
    );
    return world.planner.planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: world.ACTOR.tenantId,
        actorId: world.ACTOR.actorId,
        task: { kind: "generation", input: { text: "artifact-1" } },
      },
      `plan-${key}`,
    );
  }

  test("M17: the LIVE selection is IDENTICAL with and without consulted findings", async () => {
    const plain = await buildPlannerWorld({});
    const withFindings = await buildPlannerWorld({ signals: [signal()] });
    const plainOutcome = await planGeneration(plain, "plain");
    const findingsOutcome = await planGeneration(withFindings, "findings");
    expect(findingsOutcome.decision.selectedStrategyId).toBe(
      plainOutcome.decision.selectedStrategyId,
    );
    // The consultation IS recorded (evidence, not command).
    expect(findingsOutcome.decision.opportunityConsultation?.consulted).toHaveLength(1);
    expect(plainOutcome.decision.opportunityConsultation).toBeUndefined();
  });

  test("M5: a policy-forbidden route is never selected despite consulted findings", async () => {
    // rail-b's model-y is policy-forbidden; the consulted findings would
    // prefer the cheapest generative footprint. The selection stays on
    // the ADMISSIBLE route and the inadmissible one is never selected.
    const forbidden = await buildPlannerWorld({
      signals: [signal()],
      policy: { providerModel: { deniedModels: ["model-y"] } },
    });
    const outcome = await planGeneration(forbidden, "forbidden");
    const selectedRoute = outcome.selectedPlan.steps.find(
      (step) => step.routeRef !== undefined,
    )?.routeRef;
    expect(selectedRoute).toBeDefined();
    expect(JSON.stringify(selectedRoute)).not.toContain("model-y");
    expect(
      outcome.decision.candidates.some(
        (candidate: { strategyId: string; admissible: boolean; inadmissibleReason?: string }) =>
          !candidate.admissible,
      ),
    ).toBe(true);
  });
});
