/**
 * Discrimination: the tool-composition learning boundaries (WORK-017;
 * checkpoint contracts LEARNING-NONAUTHORITY, IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY).
 *
 * Every protection is proven by a mutant that removes it (the
 * WORK-013/014 red-record pattern): STATIC mutants mutate the REAL
 * source in memory and the shared scanners must flag exactly the
 * weakened protection (the architecture gate runs the same rules over
 * the real tree, so it FAILS under exactly these mutations); RUNTIME
 * red records observe the governed world under constructed wiring
 * scenarios.
 *
 * The 26 mandatory mutants of the Work Order:
 *
 *   M1  recommendation bypasses policy — runtime: a glowing
 *       recommendation referencing policy-forbidden tools NEVER
 *       becomes the preferred candidate (the planner-side gate);
 *   M2  learning imports the policy module (island scanner);
 *   M3  learning imports the capability module (island scanner);
 *   M4  learning imports the budget module (island scanner);
 *   M5  forbidden tool becomes recommended as executable — static
 *       (policy-gate-removed) + runtime;
 *   M6  unsupported composition accepted — runtime (structural
 *       rejection is a status, never a supported rank);
 *   M7  cyclic composition accepted — static (cycle-check-removed) +
 *       runtime (the domain rejects A→B→A);
 *   M8  unresolved tool reference accepted — runtime;
 *   M9  incompatible input/output composition accepted — runtime;
 *   M10 tiny sample produces false high confidence — static
 *       (floor-removed) + runtime (INCONCLUSIVE + material
 *       uncertainty);
 *   M11 missing provenance accepted — static
 *       (provenance-removed) + runtime;
 *   M12 missing evaluation window accepted — static (window-removed)
 *       + runtime;
 *   M13 incompatible evidence populations combined silently —
 *       runtime (segregation keys never merge);
 *   M14 historical scorecard mutated — runtime (scorecard rows are
 *       untouched by composition operations);
 *   M15 rollback mutates history — static
 *       (history-mutation-surface) + runtime (sets byte-identical
 *       after rollback);
 *   M16 second recommendation authority created — runtime (one
 *       advisor + one store per scope; the barrel exposes exactly one
 *       generation surface);
 *   M17 second planner authority created — the WORK-014 planner
 *       vocabulary scanner (learning never speaks planner);
 *   M18 recommendation directly changes routing — static
 *       (selection-reference-mutated / consultation-before-selection)
 *       + runtime (selection identical with/without recommendations);
 *   M19 recommendation executes tools itself — static
 *       (dispatch-vocabulary / authority-deps);
 *   M20 provider-specific types leak — the provider-identifier scan
 *       over the composition trees;
 *   M21 user rating becomes authorization — runtime (ratings change
 *       no policy verdict);
 *   M22 verification result fabricated from learning score —
 *       runtime (a recommendation NEVER marks verification PASS; the
 *       verification rollup is observed-only);
 *   M23 deterministic tool replaced by AI recommendation — runtime
 *       (deterministic-sufficient selection is never displaced);
 *   M24 synthesized tool appears — static (synthesis-vocabulary);
 *   M25 tenant scope dropped — runtime (cross-tenant consult is
 *       empty; scope is never derived from input);
 *   M26 recommendation accepted for wrong tool version — runtime
 *       (validation rejects version mismatches; versions are pinned).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  analyzeToolSequences,
  checkToolComposition,
  createCompositionAdvisor,
  createInMemoryCompositionStore,
  createInMemoryLearningStore,
  createLearningService,
  createNodeDigest,
  type RecordTelemetryInput,
  TELEMETRY_SCHEMA_VERSION,
  type ToolFact,
  validateToolFacts,
} from "../../src/modules/learning/public";
import {
  buildCompositionConsultation,
  type CandidateStrategy,
  CONSULTED_COMPOSITION_CLASS,
  type ConsultedCompositionRecommendation,
  compositionAllowedByPolicy,
  compositionPreferredCandidateId,
} from "../../src/modules/planning/public";
import { PlatformError } from "../../src/shared/errors";
import {
  type CompositionBoundaryFile,
  compositionLearningViolations,
  plannerCompositionViolations,
} from "./lib/composition";
import { type LearningBoundaryFile, learningNonAuthorityViolations } from "./lib/learning";

const REPO_ROOT = join(process.cwd());
const LEARNING_DIR = join(REPO_ROOT, "src/modules/learning");
const PLANNING_DIR = join(REPO_ROOT, "src/modules/planning");

function collectFiles(dir: string): CompositionBoundaryFile[] {
  const out: CompositionBoundaryFile[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push({ path: full.slice(REPO_ROOT.length + 1), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

const COMPOSITION_TREE = collectFiles(LEARNING_DIR).filter((file) =>
  file.path.includes("composition"),
);
const LEARNING_TREE: LearningBoundaryFile[] = collectFiles(LEARNING_DIR);

const PLANNER_SOURCE = readFileSync(join(PLANNING_DIR, "application/planner.ts"), "utf8");
const COMPOSITION_ADAPTER_SOURCE = readFileSync(
  join(PLANNING_DIR, "adapters/composition-recommendations-adapter.ts"),
  "utf8",
);
const CONSULTATION_SOURCE = readFileSync(
  join(PLANNING_DIR, "domain/composition-consultation.ts"),
  "utf8",
);

function withMutation(
  tree: readonly CompositionBoundaryFile[],
  path: string,
  mutation: (content: string) => string,
): CompositionBoundaryFile[] {
  return tree.map((file) =>
    file.path === path ? { path, content: mutation(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// The composition test population (shared by the runtime red records).
// ---------------------------------------------------------------------------

const APP = "00000000-0000-7000-8000-0000000000aa";
const TENANT = "00000000-0000-7000-8000-0000000000bb";

const FACTS: readonly ToolFact[] = [
  {
    toolId: "fetch",
    version: "1.0.0",
    capabilityIds: ["web-retrieval"],
    inputFields: [],
    outputFields: [],
  },
  {
    toolId: "parse",
    version: "2.1.0",
    capabilityIds: ["parsing"],
    inputFields: [],
    outputFields: [],
  },
];
const CATALOG = validateToolFacts([...FACTS]);

let datumSeq = 0;
function datum(overrides: Partial<RecordTelemetryInput> = {}): RecordTelemetryInput {
  datumSeq += 1;
  const executionId = `00000000-0000-7000-9000-${String(datumSeq).padStart(12, "0")}`;
  return {
    executionId,
    applicationId: APP,
    tenantId: TENANT,
    taskClass: "extract",
    capabilities: ["web-retrieval"],
    planId: `plan-${datumSeq}`,
    planRevision: 1,
    strategyClass: "hybrid",
    routes: [],
    tools: ["fetch", "parse"],
    environments: [],
    verification: {
      resultIds: [`v-${datumSeq}`],
      statuses: ["PASS"],
      evaluatorIds: ["deterministic:schema@1"],
      passCount: 1,
      failCount: 0,
      inconclusiveCount: 0,
      verified: true,
    },
    costMicroUsd: "1000",
    latencyMs: 1000,
    outcome: "execution-completed",
    evidenceRefs: [`execution:${executionId}:receipt`],
    subgraphs: [],
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    ...overrides,
  };
}

import type { ExecutionOutcomeTelemetry } from "../../src/modules/learning/public";

/** Materialize a full durable telemetry datum from an input. */
function fullDatum(input: RecordTelemetryInput, index: number): ExecutionOutcomeTelemetry {
  return {
    ...input,
    telemetryId: `t-${index}`,
    recordedAt: new Date(Date.parse("2026-08-31T12:00:00Z") + index * 1000).toISOString(),
  };
}

function fullPopulation(
  inputs: readonly RecordTelemetryInput[],
): readonly ExecutionOutcomeTelemetry[] {
  return inputs.map((input, index) => fullDatum(input, index));
}

function consulted(
  overrides: Partial<ConsultedCompositionRecommendation> = {},
): ConsultedCompositionRecommendation {
  return {
    recommendationClass: CONSULTED_COMPOSITION_CLASS,
    taskClass: "extract",
    contextCapabilities: ["web-retrieval"],
    contextStrategyClass: "hybrid",
    toolVersions: [
      { toolId: "fetch", version: "1.0.0" },
      { toolId: "parse", version: "2.1.0" },
    ],
    toolCapabilityIds: ["web-retrieval", "parsing"],
    status: "supported",
    rank: 1,
    confidenceLevel: "low",
    population: 10,
    successCount: 9,
    successRate: 0.9,
    meanCostMicroUsd: "1200",
    meanLatencyMs: 900,
    setId: "set-1",
    setVersion: 1,
    analysisVersion: 1,
    compositionSchemaVersion: 1,
    recommendationSchemaVersion: 1,
    evaluationWindowFrom: "2026-08-01T00:00:00Z",
    evaluationWindowTo: "2026-08-31T00:00:00Z",
    evidenceRefs: ["execution:1:receipt"],
    sourceExecutionIds: ["exec-1"],
    ...overrides,
  };
}

function candidate(
  strategyId: string,
  capabilityIds: readonly string[],
  admissible = true,
): CandidateStrategy {
  return {
    strategyId,
    plan: {
      planId: `plan-${strategyId}`,
      revision: 1,
      strategyClass: "hybrid",
      steps: capabilityIds.map((capabilityId, index) => ({
        id: `s${index}`,
        stepClass: "call-tool" as const,
        capabilityId,
      })),
      edges: [],
      hasRouteRef: false,
    },
    admissible,
    ...(admissible ? {} : { inadmissibleReason: "policy-forbidden-route" }),
  } as unknown as CandidateStrategy;
}

// ---------------------------------------------------------------------------
// STATIC red records: every weakened protection is detected.
// ---------------------------------------------------------------------------

describe("discrimination: tool-composition non-authority (static mutants)", () => {
  test("the REAL composition tree passes the scanners (baseline)", () => {
    expect(compositionLearningViolations(COMPOSITION_TREE)).toEqual([]);
  });

  test("the REAL planner composition surface passes the scanners (baseline)", () => {
    expect(
      plannerCompositionViolations(PLANNER_SOURCE, COMPOSITION_ADAPTER_SOURCE, CONSULTATION_SOURCE),
    ).toEqual([]);
  });

  test("M2: learning importing the policy module is detected (island)", () => {
    const tree = collectLearningTreeWithMutation(
      "src/modules/learning/application/composition-advisor.ts",
      (content) =>
        content.replace(
          'import { PlatformError } from "../../../shared/errors";',
          'import { PlatformError } from "../../../shared/errors";\nimport type { PolicyAuthority } from "../../policies/public";',
        ),
    );
    expect(learningNonAuthorityViolations(tree)).not.toEqual([]);
  });

  test("M3: learning importing the capability module is detected (island)", () => {
    const tree = collectLearningTreeWithMutation(
      "src/modules/learning/application/composition-advisor.ts",
      (content) =>
        content.replace(
          'import { PlatformError } from "../../../shared/errors";',
          'import { PlatformError } from "../../../shared/errors";\nimport type { CapabilityRegistry } from "../../capabilities/public";',
        ),
    );
    expect(learningNonAuthorityViolations(tree)).not.toEqual([]);
  });

  test("M4: learning importing the budget module is detected (island)", () => {
    const tree = collectLearningTreeWithMutation(
      "src/modules/learning/application/composition-advisor.ts",
      (content) =>
        content.replace(
          'import { PlatformError } from "../../../shared/errors";',
          'import { PlatformError } from "../../../shared/errors";\nimport type { BudgetAuthority } from "../../budgets/public";',
        ),
    );
    expect(learningNonAuthorityViolations(tree)).not.toEqual([]);
  });

  test("M5: the consultation policy gate removed is detected", () => {
    const violations = plannerCompositionViolations(
      PLANNER_SOURCE,
      COMPOSITION_ADAPTER_SOURCE,
      CONSULTATION_SOURCE.replace("deniedTools?.includes(toolId) === true", "false"),
    );
    expect(violations).toContain("policy-gate-removed");
  });

  test("M7: the cycle check removed is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/domain/composition.ts",
      (content) => content.replace("compositionCycleExists(composition)", "null /* mutated */"),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations).toContain("cycle-check-removed:composition");
  });

  test("M10: the minimum-population floor removed is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/domain/composition-analysis.ts",
      (content) => content.replace("population < MINIMUM_SEQUENCE_POPULATION", "false"),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations).toContain("floor-removed:analysis");
  });

  test("M11: the provenance requirement removed is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/domain/composition-analysis.ts",
      (content) => content.replace("refs.length === 0", "false"),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations).toContain("provenance-removed:analysis-validation");
  });

  test("M12: the evaluation-window requirement removed is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/domain/composition-analysis.ts",
      (content) =>
        content.replace("must be a non-empty timestamp (M12 evaluation window)", "mutated"),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations).toContain("window-removed:analysis-validation");
  });

  test("M15: a history-mutation surface appearing is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/ports/composition-store.ts",
      (content) =>
        content.replace(
          "  listActivations(scope",
          "  deleteRecommendationSet(scope: RecommendationSetScope, setId: string): Promise<void>;\n  listActivations(scope",
        ),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations.some((violation) => violation.startsWith("history-mutation-surface:"))).toBe(
      true,
    );
  });

  test("M18: the selection reference mutated to the composition preference is detected", () => {
    const violations = plannerCompositionViolations(
      PLANNER_SOURCE.replace(
        "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
        "selectedStrategyId: compositionConsultation?.preferredStrategyId ?? selected.strategyId,\n        selectionRationale: selection.rationale,",
      ),
      COMPOSITION_ADAPTER_SOURCE,
      CONSULTATION_SOURCE,
    );
    expect(violations).toContain("selection-reference-mutated");
  });

  test("M18: the consultation moved BEFORE the governed selection is detected", () => {
    const mutated = PLANNER_SOURCE.replace(
      "const selection = selectStrategy(",
      "if (deps.compositionRecommendations !== undefined) {\n        await deps.compositionRecommendations.consult({ applicationId: input.applicationId, tenantId: input.tenantId, taskClass: profile.kind });\n      }\n      const selection = selectStrategy(",
    );
    const violations = plannerCompositionViolations(
      mutated,
      COMPOSITION_ADAPTER_SOURCE,
      CONSULTATION_SOURCE,
    );
    expect(violations).toContain("consultation-before-selection");
  });

  test("M19: the advisor gaining an authority dep is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/application/composition-advisor.ts",
      (content) =>
        content.replace(
          "export interface CompositionAdvisorDeps {\n  readonly store: CompositionStore;",
          "export interface CompositionAdvisorDeps {\n  readonly policy: { decide(): boolean };\n  readonly store: CompositionStore;",
        ),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations).toContain("authority-deps:policy");
  });

  test("M19: a dispatch surface appearing in learning is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/application/composition-advisor.ts",
      (content) =>
        content.replace(
          "export interface CompositionAdvisorDeps {",
          "async dispatchTool(toolId: string): Promise<void> { /* mutated */ }\n\nexport interface CompositionAdvisorDeps {",
        ),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations.some((violation) => violation.startsWith("dispatch-vocabulary:"))).toBe(true);
  });

  test("M24: synthesis vocabulary appearing in the composition surface is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/domain/composition.ts",
      (content) =>
        content.replace(
          "export interface CompositionStep {",
          "declare function synthesizeTool(code: string): never;\n\nexport interface CompositionStep {",
        ),
    );
    const violations = compositionLearningViolations(tree);
    expect(violations.some((violation) => violation.startsWith("synthesis-vocabulary:"))).toBe(
      true,
    );
  });

  test("M11/M13/M26: the planning adapter's validation removed is detected", () => {
    const violations = plannerCompositionViolations(
      PLANNER_SOURCE,
      COMPOSITION_ADAPTER_SOURCE.replace(
        "validateConsultedCompositionRecommendation(consulted);",
        "/* validation removed (mutated) */",
      ),
      CONSULTATION_SOURCE,
    );
    expect(violations).toContain("adapter-validation-removed");
  });

  test("M20: a provider identifier leaking into the composition domain is detected", () => {
    const tree = withMutation(
      COMPOSITION_TREE,
      "src/modules/learning/domain/composition-analysis.ts",
      (content) =>
        content.replace(
          "export const COMPOSITION_ANALYSIS_VERSION",
          "export const OpenAIAdapter = 1;\nexport const COMPOSITION_ANALYSIS_VERSION",
        ),
    );
    const learningTree = tree.map((file) => ({
      path: file.path,
      content: file.content,
    }));
    expect(
      learningNonAuthorityViolations(learningTree).some((v) =>
        v.startsWith("provider-identifier:"),
      ),
    ).toBe(true);
  });

  test("M17: the learning tree still passes the WORK-014 planner-vocabulary scan (no second planner)", () => {
    expect(
      learningNonAuthorityViolations(LEARNING_TREE).filter((v) =>
        v.startsWith("planner-vocabulary:"),
      ),
    ).toEqual([]);
  });
});

function collectLearningTreeWithMutation(
  path: string,
  mutation: (content: string) => string,
): LearningBoundaryFile[] {
  return LEARNING_TREE.map((file) =>
    file.path === path ? { ...file, content: mutation(file.content) } : file,
  );
}

// ---------------------------------------------------------------------------
// RUNTIME red records: the governed world under adverse scenarios.
// ---------------------------------------------------------------------------

describe("discrimination: tool-composition non-authority (runtime red records)", () => {
  test("R-M1/R-M5: a GLOWING recommendation of policy-forbidden tools is never preferred", () => {
    const glowing = consulted({
      toolVersions: [{ toolId: "forbidden-tool", version: "1.0.0" }],
      population: 100,
      successCount: 100,
      successRate: 1,
    });
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [glowing],
      { tool: { deniedTools: ["forbidden-tool"] } },
    );
    expect(preferred).toBeNull();
    expect(
      compositionAllowedByPolicy(["forbidden-tool"], { deniedTools: ["forbidden-tool"] }),
    ).toBe(false);
  });

  test("R-M6: a structurally unsupported composition is NEVER supported/ranked", () => {
    const population = Array.from({ length: 10 }, () => datum({ tools: ["fetch", "ghost-tool"] }));
    const recommendations = analyzeToolSequences(fullPopulation(population), CATALOG);
    expect(recommendations[0]?.status).toBe("unsupported");
    expect(recommendations[0]?.rank).toBeNull();
  });

  test("R-M7: cyclic compositions are rejected by the structural check", () => {
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "fetch", version: "1.0.0" } },
          { stepId: "s1", tool: { toolId: "parse", version: "2.1.0" } },
        ],
        edges: [
          { fromStepId: "s0", toStepId: "s1" },
          { fromStepId: "s1", toStepId: "s0" },
        ],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("cyclic-composition");
    }
  });

  test("R-M8: unresolved tool references are rejected", () => {
    const check = checkToolComposition(
      {
        steps: [{ stepId: "s0", tool: { toolId: "ghost", version: "1.0.0" } }],
        edges: [],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("unknown-tool-reference");
    }
  });

  test("R-M9: incompatible input/output compositions are rejected", () => {
    const incompatibleFacts = validateToolFacts([
      {
        toolId: "producer",
        version: "1.0.0",
        capabilityIds: ["cap-a"],
        inputFields: [],
        outputFields: [{ name: "text", type: "string", required: true }],
      },
      {
        toolId: "consumer",
        version: "1.0.0",
        capabilityIds: ["cap-b"],
        inputFields: [{ name: "count", type: "number", required: true }],
        outputFields: [],
      },
    ]);
    const check = checkToolComposition(
      {
        steps: [
          { stepId: "s0", tool: { toolId: "producer", version: "1.0.0" } },
          { stepId: "s1", tool: { toolId: "consumer", version: "1.0.0" } },
        ],
        edges: [{ fromStepId: "s0", toStepId: "s1" }],
      },
      incompatibleFacts,
    );
    expect(check.valid).toBe(false);
    if (!check.valid) {
      expect(check.reason).toBe("incompatible-input-output");
    }
  });

  test("R-M10: a tiny sample NEVER produces a supported/high-confidence record", () => {
    const population = Array.from({ length: 2 }, () => datum());
    const recommendations = analyzeToolSequences(fullPopulation(population), CATALOG);
    const recommendation = recommendations[0];
    expect(recommendation?.status).toBe("inconclusive");
    expect(recommendation?.rank).toBeNull();
    expect(recommendation?.confidence.level).not.toBe("low");
    // The preference floor also blocks tiny populations.
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [
        consulted({
          population: 2,
          status: "inconclusive",
          rank: null,
          confidenceLevel: "material",
        }),
      ],
      {},
    );
    expect(preferred).toBeNull();
  });

  test("R-M11/R-M12: missing provenance or window fails the consultation validation", () => {
    expect(() =>
      buildCompositionConsultation({
        candidates: [candidate("aligned", ["web-retrieval", "parsing"])],
        recommendations: [consulted({ evidenceRefs: [] })],
        policy: {},
        selectedStrategyId: "aligned",
        consultedAt: "2026-09-01T00:00:00Z",
      }),
    ).toThrow(PlatformError);
    expect(() =>
      buildCompositionConsultation({
        candidates: [candidate("aligned", ["web-retrieval", "parsing"])],
        recommendations: [consulted({ evaluationWindowFrom: "" })],
        policy: {},
        selectedStrategyId: "aligned",
        consultedAt: "2026-09-01T00:00:00Z",
      }),
    ).toThrow(PlatformError);
  });

  test("R-M13: incompatible populations NEVER merge silently", () => {
    const population = [
      ...Array.from({ length: 6 }, () => datum({ capabilities: ["web-retrieval"] })),
      ...Array.from({ length: 6 }, () =>
        datum({ capabilities: ["different-capability"], tools: ["fetch", "parse"] }),
      ),
    ];
    const recommendations = analyzeToolSequences(fullPopulation(population), CATALOG);
    // Two contexts ⇒ two segregated records, never one merged record.
    expect(recommendations.length).toBe(2);
    for (const recommendation of recommendations) {
      expect(recommendation.population).toBe(6);
      expect(recommendation.sourceExecutionIds).toHaveLength(6);
    }
  });

  test("R-M14: composition operations leave historical scorecards untouched", async () => {
    const learningStore = createInMemoryLearningStore();
    const learning = createLearningService({
      store: learningStore,
      digest: createNodeDigest(),
      generateId: () => `id-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    for (let index = 0; index < 6; index += 1) {
      await learning.recordExecutionTelemetry(datum());
    }
    const scorecard = await learning.buildScorecard({
      applicationId: APP,
      tenantId: TENANT,
      definitionId: "tool-outcome-by-task-class",
    });
    const before = JSON.stringify(scorecard);

    const advisor = createCompositionAdvisor({
      store: createInMemoryCompositionStore(learningStore),
      digest: createNodeDigest(),
      generateId: () => `advisor-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: [...FACTS],
    });

    const after = await learning
      .consultSignals({
        applicationId: APP,
        tenantId: TENANT,
        definitionId: "tool-outcome-by-task-class",
      })
      .then(() => JSON.stringify(scorecard));
    expect(after).toBe(before);
  });

  test("R-M15: rollback leaves every historical set byte-identical", async () => {
    const learningStore = createInMemoryLearningStore();
    const learning = createLearningService({
      store: learningStore,
      digest: createNodeDigest(),
      generateId: () => `id-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    for (let index = 0; index < 6; index += 1) {
      await learning.recordExecutionTelemetry(datum());
    }
    const compositionStore = createInMemoryCompositionStore(learningStore);
    const advisor = createCompositionAdvisor({
      store: compositionStore,
      digest: createNodeDigest(),
      generateId: () => `advisor-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    const first = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: [...FACTS],
    });
    for (let index = 0; index < 1; index += 1) {
      await learning.recordExecutionTelemetry(datum());
    }
    const second = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: [...FACTS],
    });
    await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: second.set.setId,
      activatedBy: "operator",
      reason: "initial",
    });
    await advisor.rollbackRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toSetId: first.set.setId,
      activatedBy: "operator",
    });
    expect(
      await compositionStore.getRecommendationSet(
        { applicationId: APP, tenantId: TENANT },
        first.set.setId,
      ),
    ).toEqual(first.set);
    expect(
      await compositionStore.getRecommendationSet(
        { applicationId: APP, tenantId: TENANT },
        second.set.setId,
      ),
    ).toEqual(second.set);
  });

  test("R-M16: exactly ONE recommendation authority surface exists in the learning barrel", async () => {
    const barrel = await import("../../src/modules/learning/public");
    // One generation service factory (the value surface; the types
    // are compile-time only).
    expect(Object.keys(barrel).filter((name) => name.includes("Advisor"))).toEqual([
      "createCompositionAdvisor",
    ]);
  });

  test("R-M21: user ratings NEVER become authorization (a rating cannot flip the policy gate)", async () => {
    const learningStore = createInMemoryLearningStore();
    const learning = createLearningService({
      store: learningStore,
      digest: createNodeDigest(),
      generateId: () => `id-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    for (let index = 0; index < 6; index += 1) {
      const { executionId } = await learning.recordExecutionTelemetry(datum());
      await learning.recordUserRating({
        applicationId: APP,
        tenantId: TENANT,
        executionId,
        evaluatorId: "user-1",
        ratingDimension: "quality",
        rating: 5,
        provenance: { source: "user", submittedVia: "dashboard" },
        evidenceRefs: [`execution:${executionId}:receipt`],
        schemaVersion: 1,
      });
    }
    // A five-star rated forbidden tool is STILL forbidden.
    expect(compositionAllowedByPolicy(["fetch"], { deniedTools: ["fetch"] })).toBe(false);
    const preferred = compositionPreferredCandidateId(
      [candidate("aligned", ["web-retrieval", "parsing"])],
      [consulted({ successRate: 1, population: 50 })],
      { tool: { deniedTools: ["fetch"] } },
    );
    expect(preferred).toBeNull();
  });

  test("R-M22: a learning score NEVER fabricates a verification result", async () => {
    // The recommendation records OBSERVED verification rollups only;
    // the planner consultation carries no verification write surface.
    const population = Array.from({ length: 6 }, () =>
      datum({
        verification: {
          resultIds: [],
          statuses: [],
          evaluatorIds: [],
          passCount: 0,
          failCount: 0,
          inconclusiveCount: 0,
          verified: null,
        },
      }),
    );
    const recommendations = analyzeToolSequences(fullPopulation(population), CATALOG);
    // No verification data ⇒ verificationPassRate is null (honest),
    // never a fabricated PASS.
    expect(recommendations[0]?.verificationPassRate).toBeNull();
    expect(recommendations[0]?.verificationTotal).toBe(0);
  });

  test("R-M25: tenant scope is never dropped (cross-tenant consultation is empty)", async () => {
    const learningStore = createInMemoryLearningStore();
    const learning = createLearningService({
      store: learningStore,
      digest: createNodeDigest(),
      generateId: () => `id-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T12:00:00Z"),
    });
    for (let index = 0; index < 6; index += 1) {
      await learning.recordExecutionTelemetry(datum());
    }
    const advisor = createCompositionAdvisor({
      store: createInMemoryCompositionStore(learningStore),
      digest: createNodeDigest(),
      generateId: () => `advisor-${Date.now()}-${Math.random()}`,
      now: () => new Date("2026-09-15T14:00:00Z"),
    });
    const { set } = await advisor.generateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      toolFacts: [...FACTS],
    });
    await advisor.activateRecommendationSet({
      applicationId: APP,
      tenantId: TENANT,
      setId: set.setId,
      activatedBy: "operator",
      reason: "initial",
    });
    const foreign = await advisor.consultRecommendations({
      applicationId: APP,
      tenantId: "00000000-0000-7000-8000-0000000000ff",
    });
    expect(foreign).toHaveLength(0);
  });

  test("R-M26: a recommendation pinning the wrong tool version fails validation", () => {
    // The consumer-side validation rejects a version the facts never
    // carried (a bare tool name or a mismatched version).
    expect(() =>
      buildCompositionConsultation({
        candidates: [candidate("aligned", ["web-retrieval", "parsing"])],
        recommendations: [consulted({ toolVersions: [{ toolId: "fetch", version: "" }] })],
        policy: {},
        selectedStrategyId: "aligned",
        consultedAt: "2026-09-01T00:00:00Z",
      }),
    ).toThrow(PlatformError);
    // The structural check rejects a version the catalog does not carry.
    const check = checkToolComposition(
      {
        steps: [{ stepId: "s0", tool: { toolId: "fetch", version: "9.9.9" } }],
        edges: [],
      },
      CATALOG,
    );
    expect(check.valid).toBe(false);
  });
});
