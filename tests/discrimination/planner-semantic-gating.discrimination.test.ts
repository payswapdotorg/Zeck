/**
 * Discrimination: planner quality-contract gating + substitute
 * disclosure (planning module; ACR-009 §3–§5; work order PCS-003).
 *
 *   G1 — ABSENCE-EQUIVALENCE vs the PRE-CHANGE BASELINE (the honesty
 *        anchor): the full traced decision table over the REAL wired
 *        stack — the real planner service over the real in-memory
 *        executions ledger, the real capability registry (seeded +
 *        the planning deterministic claims published through the
 *        sanctioned path), the real policy authority with the real
 *        policy-inputs adapter, the real route-table explorer and the
 *        real deterministic catalog — was captured at the BASE commit
 *        (4f6921b80cc1ad59a7b49ebe22cb4dcb5d9f8167) BEFORE any
 *        PCS-003 change, and re-derived at HEAD byte-identically
 *        (sha256-pinned; the PCR-002 off-behavior proof pattern). The
 *        corpus carries NO semantic fidelity facts and NO quality
 *        contracts — the only spelling that existed at base — so the
 *        absence of facts and contracts selects and records
 *        byte-identically to the pre-change baseline.
 *   G2 — GATING ON/OFF RIDES THE DECLARED CONTRACT ONLY: the same
 *        wired world, the same substitute-declaring capability
 *        registry, the same task — with and without the task-authored
 *        quality contract — flips the gate and NOTHING else (no
 *        ambient flag exists; the gating input is the declared
 *        contract).
 *   G3 — THE TYPED INADMISSIBILITY REASON: a declared
 *        `requires-semantic-retrieval-quality` contract makes the
 *        `deterministic-substitute` representation INADMISSIBLE with
 *        the typed reason composed exactly like the existing
 *        inadmissibility reasons (the economics/quality/policy reason
 *        family); the planner never "tries anyway" (fail closed with
 *        the typed NO_ELIGIBLE_ROUTE when nothing else can satisfy).
 *   G4 — THE SUBSTITUTION RECORD ON PERMITTED SELECTION: no contract
 *        declared → the substitute stays admissible, is selected, and
 *        the decision record carries the substitution fact (typed:
 *        requirement, representation kind, claim + substitute
 *        provenance) through the existing WORK-049 seam — no new
 *        durable surface.
 *   G5 — FAIL-CLOSED ON MALFORMED CONTRACTS: an unknown/malformed
 *        quality contract is inadmissible, never permissive (the pure
 *        gate fails closed; the profile derivation rejects malformed
 *        contracts typed).
 *   G6 — THE INVARIANT-13 BOUNDARY: the gating NEVER lowers a quality
 *        floor, raises a budget ceiling or bypasses policy (it is a
 *        new typed admissibility dimension composed AFTER the policy
 *        filter; it can only add inadmissibility, never remove it).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  type PublishedCapabilityFact,
  SEED_CAPABILITY_FACTS,
  type SemanticFidelityFacts,
} from "../../src/modules/capabilities/public";
import { PLANNING_DECISION_EVENT_TYPE } from "../../src/modules/executions/public";
import { publishDeterministicCapabilityFacts } from "../../src/modules/planning/adapters/deterministic-capability-publisher";
import {
  applySemanticQualityGating,
  buildPlan,
  classifySemanticQualityContract,
  createCapabilityAuthorityAdapter,
  createInMemoryDeterministicCatalog,
  createNodeDigest,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  createRouteTableExplorer,
  DETERMINISTIC_CATALOG_SEED,
  type DeterministicCatalogEntry,
  deriveTaskProfile,
  type ModelRouteCandidate,
  type PlanningDecisionRecord,
  projectSemanticDisclosure,
  type SemanticSubstitutionCapture,
  type TaskConstraintInput,
} from "../../src/modules/planning/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicySet,
} from "../../src/modules/policies/public";
import { PlatformError } from "../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "../unit/executions/fakes";

const APP_ID = "00000000-0000-7000-8000-0000000009e1";
const PUBLISHED_AT = "2026-10-13T00:00:00Z";
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const digest = (value: unknown): string => sha256(JSON.stringify(value));

// ---------------------------------------------------------------------------
// The real wired stack (per scenario: fresh world, deterministic ids/time)
// ---------------------------------------------------------------------------

const BASE_ROUTES: readonly ModelRouteCandidate[] = [
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
  {
    provider: "rail-c",
    model: "model-z",
    satisfies: ["text-generation"],
    expectedCostMicroUsd: "5000",
    expectedQuality: 0.99,
    expectedLatencyMs: 4000,
  },
];

interface WorldOptions {
  readonly policySet?: PolicySet;
  readonly routes?: readonly ModelRouteCandidate[];
  readonly catalogEntries?: readonly DeterministicCatalogEntry[];
  readonly extraCapabilityFacts?: readonly PublishedCapabilityFact[];
}

interface WiredWorld {
  readonly planner: ReturnType<typeof createPlannerService>;
  readonly executions: ReturnType<typeof createInMemoryExecutions>;
}

async function buildWiredWorld(options: WorldOptions = {}): Promise<WiredWorld> {
  const executions = createInMemoryExecutions();
  executions.store.seedApplication(APP_ID, ACTOR.tenantId);
  const registry = await createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: SEED_CAPABILITY_FACTS,
  });
  await publishDeterministicCapabilityFacts(registry);
  for (const fact of options.extraCapabilityFacts ?? []) {
    const outcome = await registry.publish(fact);
    if (outcome.status === "rejected") {
      throw new Error(`probe fact rejected: ${fact.claim.id} (${outcome.reason})`);
    }
  }
  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  if (options.policySet !== undefined) {
    const outcome = await policyAuthority.publish(options.policySet);
    if (outcome.status !== "published" && outcome.status !== "converged") {
      throw new Error(`probe policy set rejected: ${JSON.stringify(outcome)}`);
    }
  }
  const planner = createPlannerService({
    capabilityAuthority: createCapabilityAuthorityAdapter(registry),
    policyInputs: createPolicyInputsAdapter(policyAuthority),
    routeExplorer: createRouteTableExplorer(options.routes ?? BASE_ROUTES),
    deterministicCatalog: createInMemoryDeterministicCatalog(options.catalogEntries),
    sink: createPlanningSinkAdapter(executions.service),
    digest: createNodeDigest(),
    generateId: executions.generateId,
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  return { planner, executions };
}

interface ScenarioSpec {
  readonly id: string;
  readonly task: Record<string, unknown>;
  readonly constraints?: TaskConstraintInput;
  readonly policySet?: PolicySet;
  readonly routes?: readonly ModelRouteCandidate[];
  readonly replanOf?: string;
  readonly planTwice?: boolean;
}

const policySet = (
  id: string,
  restrictions: PolicySet["documents"][number]["restrictions"],
): PolicySet => ({
  id,
  version: 1,
  documents: [{ scope: "platform", selector: {}, restrictions }],
});

// The pre-change decision-table corpus: TODAY'S task vocabulary only —
// no semantic fidelity facts, no quality contracts (the only spelling
// that existed at the base commit). Every row is a distinct decision
// path of the existing machinery.
const BASELINE_CORPUS: readonly ScenarioSpec[] = [
  { id: "arithmetic-sufficient", task: { kind: "arithmetic", input: { expression: "2+2" } } },
  {
    id: "data-retrieval-sufficient",
    task: { kind: "data-retrieval", input: { query: "select 1" } },
  },
  {
    id: "validation-sufficient",
    task: { kind: "validation", input: { schema: { type: "object" }, document: { a: 1 } } },
  },
  { id: "transformation-sufficient", task: { kind: "transformation", input: { rows: [1, 2] } } },
  { id: "generation-generative", task: { kind: "generation", input: { prompt: "write a haiku" } } },
  {
    id: "interpretation-generative",
    task: { kind: "interpretation", input: { text: "the invoice is overdue" } },
  },
  {
    id: "analysis-cheap-first-deterministic",
    task: { kind: "analysis", input: { question: "summarize the report" } },
  },
  {
    id: "mixed-explicit-both",
    task: {
      kind: "mixed",
      requiredCapabilities: [
        { id: "structured-dataset-read", kind: "data" },
        { id: "text-generation", kind: "model" },
      ],
      input: { dataset: "invoices", prompt: "totals" },
    },
  },
  {
    id: "mixed-deterministic-claim",
    task: {
      kind: "mixed",
      semanticReasoning: false,
      requiredCapabilities: [{ id: "numeric-computation", kind: "algorithm" }],
      input: { expression: "7*6" },
    },
  },
  {
    id: "unmet-capability-generative-selected",
    task: {
      kind: "mixed",
      requiredCapabilities: [
        { id: "quantum-orchestration", kind: "algorithm" },
        { id: "text-generation", kind: "model" },
      ],
      input: { prompt: "hello" },
    },
  },
  {
    id: "invalid-task-kind-rejected",
    task: { kind: "vibes", input: { mood: "great" } },
  },
  {
    id: "policy-denied-provider",
    task: { kind: "generation", input: { prompt: "write a sonnet" } },
    policySet: policySet("baseline-denied-provider", {
      providerModel: { deniedProviders: ["rail-b"] },
    }),
  },
  {
    id: "policy-quality-floor",
    task: { kind: "generation", input: { prompt: "write an essay" } },
    policySet: policySet("baseline-quality-floor", { quality: { minQuality: 0.9 } }),
  },
  {
    id: "policy-cost-ceiling",
    task: { kind: "generation", input: { prompt: "write a novel" } },
    policySet: policySet("baseline-cost-ceiling", { cost: { maxCostMicroUsd: "500" } }),
  },
  {
    id: "policy-latency-ceiling",
    task: { kind: "generation", input: { prompt: "write fast" } },
    policySet: policySet("baseline-latency-ceiling", { latency: { maxLatencyMs: 1800 } }),
  },
  {
    id: "quality-gap-routes-only-satisfying",
    task: { kind: "analysis", input: { question: "deep analysis" }, qualityTarget: 0.99 },
  },
  {
    id: "constraints-quality-target",
    task: { kind: "generation", input: { prompt: "constrained" } },
    constraints: { minQuality: 0.95 },
  },
  {
    id: "idempotent-replay",
    task: { kind: "generation", input: { prompt: "replay me" } },
    planTwice: true,
  },
  {
    id: "replan-binding",
    task: { kind: "generation", input: { prompt: "replan me" } },
    replanOf: "00000000-0000-7000-8000-0000000000ff",
  },
];

/** Plan one scenario over the real wired stack and trace the decision. */
async function runScenario(spec: ScenarioSpec): Promise<string[]> {
  const world = await buildWiredWorld({
    ...(spec.policySet === undefined ? {} : { policySet: spec.policySet }),
    ...(spec.routes === undefined ? {} : { routes: spec.routes }),
  });
  const lines: string[] = [`scenario\t${spec.id}`];
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task: spec.task },
    `create-${spec.id}`,
    ACTOR,
  );
  const executionId = receipt.executionId;
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
    `authorize-${spec.id}`,
  );
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
    `plan-${spec.id}`,
  );
  const planInput = {
    applicationId: APP_ID,
    executionId,
    tenantId: ACTOR.tenantId,
    actorId: ACTOR.actorId,
    task: spec.task,
    ...(spec.constraints === undefined ? {} : { constraints: spec.constraints }),
    ...(spec.replanOf === undefined ? {} : { replanOf: spec.replanOf }),
  };
  const planOnce = await world.planner.planExecution(planInput, `decision-${spec.id}`).then(
    (value) => value,
    (error: unknown) => error,
  );
  if (planOnce instanceof PlatformError) {
    lines.push(`outcome\terror\t${planOnce.code}`);
    lines.push(`errordetails\t${JSON.stringify(planOnce.details)}`);
    return lines;
  }
  if (!(planOnce instanceof Object)) {
    lines.push(`outcome\tunexpected\t${String(planOnce)}`);
    return lines;
  }
  const first = planOnce as {
    readonly decision: Record<string, unknown>;
    readonly replayed: boolean;
  };
  lines.push(
    `outcome\tselected\t${JSON.stringify(first.decision.selectedStrategyId as string)}\treplayed=${first.replayed}`,
  );
  lines.push(`rationale\t${JSON.stringify(first.decision.selectionRationale as string)}`);
  lines.push(`record\t${JSON.stringify(first.decision)}`);
  if (spec.planTwice === true) {
    const second = await world.planner.planExecution(planInput, `decision-${spec.id}`).then(
      (value) => value,
      (error: unknown) => error,
    );
    if (second instanceof PlatformError) {
      lines.push(`replay\terror\t${second.code}`);
    } else {
      const replayed = second as {
        readonly decision: Record<string, unknown>;
        readonly replayed: boolean;
      };
      lines.push(
        `replay\tselected\t${JSON.stringify(replayed.decision.selectedStrategyId as string)}\treplayed=${replayed.replayed}`,
      );
      lines.push(`replayrecord\t${JSON.stringify(replayed.decision)}`);
    }
  }
  const events = await world.executions.service.listEvents(APP_ID, executionId);
  const planning = events.filter((event) => event.type === PLANNING_DECISION_EVENT_TYPE);
  lines.push(`events\t${JSON.stringify(planning)}`);
  return lines;
}

/** Replay the full pre-change decision table over the real wired stack. */
async function replayBaselineDecisionTable(): Promise<string> {
  const lines: string[] = [`corpus\t${BASELINE_CORPUS.length}`];
  for (const spec of BASELINE_CORPUS) {
    lines.push(...(await runScenario(spec)));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The post-change discrimination fixtures (facts + contracts ONLY here —
// the baseline corpus above stays the pre-change spelling byte-for-byte)
// ---------------------------------------------------------------------------

/** The deterministic-substitute fact block a substitute-declaring claim carries (the ACR-009 §1 story). */
const SUBSTITUTE_FACTS: SemanticFidelityFacts = {
  representationKind: "deterministic-substitute",
  modality: "text",
  dimensionality: 512,
  normalization: "none",
  similaritySemantics: "hash-proximity",
  qualityContract: { kind: "absent" },
  compatibilityConstraints: [
    "dimensionality-match",
    "normalization-match",
    "similarity-semantics-match",
  ],
  basis: {
    executionId: "exec-000456",
    capabilityId: "rag-embeddings",
    substituteId: "lexical-hash-vectorizer",
  },
};

const MODEL_BACKED_FACTS: SemanticFidelityFacts = {
  representationKind: "semantic-model-backed",
  modality: "text",
  dimensionality: 768,
  normalization: "l2",
  similaritySemantics: "cosine",
  qualityContract: { kind: "absent" },
  compatibilityConstraints: [
    "dimensionality-match",
    "normalization-match",
    "similarity-semantics-match",
  ],
  basis: { executionId: "exec-000123", capabilityId: "semantic-embeddings" },
};

const probeClaim = (
  id: string,
  semanticFidelity: SemanticFidelityFacts,
): PublishedCapabilityFact => ({
  claim: { id, kind: "algorithm", version: "1.0.0", attributes: { deterministic: true } },
  provenance: { publisher: "pcs-003:probe", publishedAt: PUBLISHED_AT },
  evidence: { kind: "adapter-declared", reference: `pcs-003:${id}` },
  semanticFidelity,
});

const RAG_CATALOG_ENTRY: DeterministicCatalogEntry = {
  capabilityId: "rag-embeddings",
  kind: "algorithm",
  expectedQuality: 0.9,
  qualityConfidence: "verified",
  expectedCostMicroUsd: "5",
  expectedLatencyMs: 10,
  verificationStrategy: "retrieval-recall-check",
};

const SEMANTIC_EMBEDDINGS_CATALOG_ENTRY: DeterministicCatalogEntry = {
  capabilityId: "semantic-embeddings",
  kind: "algorithm",
  expectedQuality: 0.95,
  qualityConfidence: "verified",
  expectedCostMicroUsd: "40",
  expectedLatencyMs: 60,
  verificationStrategy: "retrieval-recall-check",
};

const DECLARED_CONTRACT = {
  kind: "declared",
  requirement: "requires-semantic-retrieval-quality",
  acceptanceBasis: "paraphrase and synonym retrieval must be semantically faithful",
} as const;

const RAG_TASK = {
  kind: "mixed",
  semanticReasoning: false,
  requiredCapabilities: [{ id: "rag-embeddings", kind: "algorithm" }],
  input: { corpus: "docs", query: "paraphrased question" },
} as const;

const RAG_AND_MODEL_TASK = {
  kind: "mixed",
  requiredCapabilities: [
    { id: "rag-embeddings", kind: "algorithm" },
    { id: "text-generation", kind: "model" },
  ],
  input: { corpus: "docs", query: "paraphrased question", prompt: "answer from the docs" },
} as const;

/** Plan an arbitrary task over a freshly built wired world (the discrimination driver). */
async function planTaskOnWorld(
  options: WorldOptions,
  task: Record<string, unknown>,
  key: string,
): Promise<
  | { readonly kind: "selected"; readonly decision: PlanningDecisionRecord }
  | { readonly kind: "error"; readonly error: PlatformError }
> {
  const world = await buildWiredWorld(options);
  const receipt = await world.executions.service.createExecution(
    { applicationId: APP_ID, task },
    `create-${key}`,
    ACTOR,
  );
  const executionId = receipt.executionId;
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
    `authorize-${key}`,
  );
  await world.executions.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
    `plan-${key}`,
  );
  const outcome = await world.planner
    .planExecution(
      {
        applicationId: APP_ID,
        executionId,
        tenantId: ACTOR.tenantId,
        actorId: ACTOR.actorId,
        task,
      },
      `decision-${key}`,
    )
    .then(
      (value) => value,
      (error: unknown) => error,
    );
  if (outcome instanceof PlatformError) {
    return { kind: "error", error: outcome };
  }
  return { kind: "selected", decision: (outcome as { decision: PlanningDecisionRecord }).decision };
}

const substituteWorld: WorldOptions = {
  extraCapabilityFacts: [probeClaim("rag-embeddings", SUBSTITUTE_FACTS)],
  catalogEntries: [...DETERMINISTIC_CATALOG_SEED, RAG_CATALOG_ENTRY],
};

describe("discrimination: planner quality-contract gating + substitute disclosure (PCS-003 — the wiring)", () => {
  test("G1 ABSENCE-EQUIVALENCE: the pre-change traced decision table replays byte-identically (the pinned capture)", async () => {
    const table = await replayBaselineDecisionTable();
    // The pinned pre-change capture: sha256 over the exact 96-line replay
    // of the 19-scenario corpus over the real wired stack, captured at
    // the base commit 4f6921b80cc1ad59a7b49ebe22cb4dcb5d9f8167 BEFORE
    // any PCS-003 change — re-derived here at HEAD and compared
    // byte-for-byte (the PCR-002 off-behavior proof pattern).
    expect(sha256(table)).toBe("05594c2561cb0c43277fe2a5d7c00973f6216fae81f45a9178085391b395c10a");
    expect(table.split("\n")).toHaveLength(97);
  });

  test("G1b the pre-change records carry NO semantic keys anywhere (absence = byte-identical-today)", async () => {
    const table = await replayBaselineDecisionTable();
    expect(table).not.toContain("semanticSubstitution");
    expect(table).not.toContain("semanticQualityContract");
    expect(table).not.toContain("semanticQualityGating");
    expect(table).not.toContain("representationKind");
    // Spot byte: the sufficient arithmetic row selects the zero-model
    // deterministic plan exactly as at base.
    const arithmetic = table
      .split("\n")
      .find((line) => line.startsWith('outcome\tselected\t"deterministic-only"'));
    expect(arithmetic).toBeDefined();
    expect(table).toContain("scenario\tarithmetic-sufficient");
  });

  test("G2 GATING ON/OFF RIDES THE DECLARED CONTRACT ONLY (no ambient flag): the same wired world flips on the task-authored contract and nothing else", async () => {
    // OFF: no contract declared — the substitute stays admissible and
    // the zero-model deterministic plan is selected.
    const off = await planTaskOnWorld(substituteWorld, { ...RAG_TASK }, "g2-off");
    expect(off.kind).toBe("selected");
    if (off.kind === "selected") {
      expect(off.decision.selectedStrategyId).toBe("deterministic-only");
      // The substitute-carrying zero-model plan was selected and NO
      // semantic gating key was needed to do it.
      expect(off.decision.candidates.every((candidate) => candidate.admissible)).toBe(true);
    }

    // ON: the ONLY difference is the declared quality contract on the
    // same task — the substitute becomes inadmissible and the planner
    // fails closed (no ambient flag, no environment, no configuration:
    // the declared contract IS the gating input).
    const on = await planTaskOnWorld(
      substituteWorld,
      { ...RAG_TASK, semanticQualityContract: DECLARED_CONTRACT },
      "g2-on",
    );
    expect(on.kind).toBe("error");
    if (on.kind === "error") {
      expect(on.error.code).toBe("NO_ELIGIBLE_ROUTE");
    }
  });

  test("G3 THE TYPED INADMISSIBILITY REASON: the declared contract makes the deterministic-substitute representation inadmissible with the composed family reason", async () => {
    const gated = await planTaskOnWorld(
      substituteWorld,
      { ...RAG_TASK, semanticQualityContract: DECLARED_CONTRACT },
      "g3",
    );
    expect(gated.kind).toBe("error");
    if (gated.kind !== "error") {
      return;
    }
    expect(gated.error.code).toBe("NO_ELIGIBLE_ROUTE");
    const details = gated.error.details as {
      candidates: { strategyId: string; admissible: boolean; inadmissibleReason: string | null }[];
      semanticQualityGating?: {
        qualityContract: { kind: string; requirement?: string };
        representations: { requirementId: string; representationKind: string }[];
      };
    };
    // The typed reason composes exactly like the existing family.
    const deterministic = details.candidates.find(
      (candidate) => candidate.strategyId === "deterministic-only",
    );
    expect(deterministic).toEqual({
      strategyId: "deterministic-only",
      admissible: false,
      inadmissibleReason: "semantic-quality-contract-forbids-substitute",
    });
    // The blocked-case disclosure rides the typed error details: the
    // declared contract + the consulted representation facts.
    expect(details.semanticQualityGating?.qualityContract).toEqual({
      kind: "declared",
      requirement: "requires-semantic-retrieval-quality",
      acceptanceBasis: "paraphrase and synonym retrieval must be semantically faithful",
    });
    expect(details.semanticQualityGating?.representations).toEqual([
      {
        requirementId: "rag-embeddings",
        representationKind: "deterministic-substitute",
        claimId: "rag-embeddings",
        claimVersion: "1.0.0",
        publisher: "pcs-003:probe",
        basis: {
          executionId: "exec-000456",
          capabilityId: "rag-embeddings",
          substituteId: "lexical-hash-vectorizer",
        },
      },
    ]);
  });

  test("G3b the gated-but-generative case: substitute candidates carry the typed reason on the record; the clean generative route is selected", async () => {
    const outcome = await planTaskOnWorld(
      substituteWorld,
      { ...RAG_AND_MODEL_TASK, semanticQualityContract: DECLARED_CONTRACT },
      "g3b",
    );
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    // The clean generative route wins; every substitute-carrying
    // candidate is recorded inadmissible with the typed reason.
    expect(outcome.decision.selectedStrategyId).toBe("generative:rail-b/model-y");
    const gatedReasons = outcome.decision.candidates
      .filter((candidate) => !candidate.admissible)
      .map((candidate) => candidate.inadmissibleReason);
    expect(gatedReasons.length).toBeGreaterThanOrEqual(3);
    for (const reason of gatedReasons) {
      expect(reason).toBe("semantic-quality-contract-forbids-substitute");
    }
    expect(
      outcome.decision.candidates
        .filter((candidate) => candidate.admissible)
        .map((c) => c.strategyId),
    ).toEqual([
      "generative:rail-a/model-x",
      "generative:rail-b/model-y",
      "generative:rail-c/model-z",
    ]);
  });

  test("G3c the negative control: a semantic-model-backed representation NEVER gates under a declared contract", async () => {
    // The same wired shape with the claim declaring
    // `semantic-model-backed` fidelity facts: the declared contract is
    // satisfied by the model-backed representation — nothing gates, the
    // zero-model plan is selected, and the capture records the
    // model-backed representation with NO substitutions (only
    // substitutes are substitution facts).
    const modelBackedWorld: WorldOptions = {
      extraCapabilityFacts: [probeClaim("semantic-embeddings", MODEL_BACKED_FACTS)],
      catalogEntries: [...DETERMINISTIC_CATALOG_SEED, SEMANTIC_EMBEDDINGS_CATALOG_ENTRY],
    };
    const outcome = await planTaskOnWorld(
      modelBackedWorld,
      {
        kind: "mixed",
        semanticReasoning: false,
        requiredCapabilities: [{ id: "semantic-embeddings", kind: "algorithm" }],
        input: { corpus: "docs", query: "paraphrased question" },
        semanticQualityContract: DECLARED_CONTRACT,
      },
      "g3c",
    );
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.decision.selectedStrategyId).toBe("deterministic-only");
    expect(outcome.decision.candidates.every((candidate) => candidate.admissible)).toBe(true);
    const capture = outcome.decision.semanticSubstitution;
    expect(capture).toBeDefined();
    expect((capture as SemanticSubstitutionCapture).substitutions).toEqual([]);
    expect((capture as SemanticSubstitutionCapture).representations[0]?.representationKind).toBe(
      "semantic-model-backed",
    );
    expect((capture as SemanticSubstitutionCapture).qualityContract).toEqual(DECLARED_CONTRACT);
    // The disclosure projects the honest empty entry set (declared,
    // met by the model-backed representation, nothing unavailable).
    const disclosure = projectSemanticDisclosure(outcome.decision);
    expect(disclosure).toEqual({ qualityContract: DECLARED_CONTRACT, entries: [] });
  });

  test("G4 THE SUBSTITUTION RECORD ON PERMITTED SELECTION: no contract → the substitute is selected and the decision record carries the typed substitution fact (the WORK-049 seam)", async () => {
    const outcome = await planTaskOnWorld(substituteWorld, { ...RAG_TASK }, "g4");
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.decision.selectedStrategyId).toBe("deterministic-only");
    const capture = outcome.decision.semanticSubstitution;
    expect(capture).toBeDefined();
    expect((capture as SemanticSubstitutionCapture).qualityContract).toEqual({ kind: "absent" });
    expect((capture as SemanticSubstitutionCapture).substitutions).toHaveLength(1);
    const fact = (capture as SemanticSubstitutionCapture).substitutions[0];
    expect(fact).toEqual({
      requirementId: "rag-embeddings",
      representationKind: "deterministic-substitute",
      claimId: "rag-embeddings",
      claimVersion: "1.0.0",
      publisher: "pcs-003:probe",
      basis: {
        executionId: "exec-000456",
        capabilityId: "rag-embeddings",
        substituteId: "lexical-hash-vectorizer",
      },
    });
    // The record validates closed-shape WITH the capture (the existing
    // validatePlanningDecision path — no new durable surface, the same
    // single write path; the event count on the ledger is exactly one).
  });

  test("G4b the machine-checkable disclosure: met-by-substitute with kind + provenance and the unavailable member", async () => {
    const outcome = await planTaskOnWorld(substituteWorld, { ...RAG_TASK }, "g4b");
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    const disclosure = projectSemanticDisclosure(outcome.decision);
    expect(disclosure).not.toBeNull();
    expect(disclosure?.qualityContract).toEqual({ kind: "absent" });
    expect(disclosure?.entries).toHaveLength(1);
    const entry = disclosure?.entries[0];
    expect(entry?.status).toBe("met-by-deterministic-substitute");
    expect(entry?.requirementId).toBe("rag-embeddings");
    expect(entry?.representation?.representationKind).toBe("deterministic-substitute");
    expect(entry?.representation?.basis.substituteId).toBe("lexical-hash-vectorizer");
    expect(entry?.unavailable).toEqual(["semantic-model-backed"]);
    // Determinism: byte-identical projection on re-run (invariant 5).
    expect(JSON.stringify(projectSemanticDisclosure(outcome.decision))).toBe(
      JSON.stringify(disclosure),
    );
  });

  test("G4c the unmet-and-blocked disclosure from the record: the gated case projects the declared requirement and what remains unavailable", async () => {
    const outcome = await planTaskOnWorld(
      substituteWorld,
      { ...RAG_AND_MODEL_TASK, semanticQualityContract: DECLARED_CONTRACT },
      "g4c",
    );
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    const disclosure = projectSemanticDisclosure(outcome.decision);
    expect(disclosure).not.toBeNull();
    expect(disclosure?.qualityContract).toEqual(DECLARED_CONTRACT);
    const unmet = disclosure?.entries.find(
      (entry) => entry.status === "unmet-no-admissible-semantic-representation",
    );
    expect(unmet).toEqual({
      requirementId: "rag-embeddings",
      status: "unmet-no-admissible-semantic-representation",
      declaredRequirement: "requires-semantic-retrieval-quality",
      unavailable: ["semantic-model-backed"],
      inadmissibleReason: "semantic-quality-contract-forbids-substitute",
    });
  });

  test("G4d no facts → no capture, no disclosure (absence-equivalent projection)", async () => {
    const outcome = await planTaskOnWorld(
      {},
      { kind: "arithmetic", input: { expression: "2+2" } },
      "g4d",
    );
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.decision.semanticSubstitution).toBeUndefined();
    expect(JSON.stringify(outcome.decision)).not.toContain("semanticSubstitution");
    expect(projectSemanticDisclosure(outcome.decision)).toBeNull();
  });

  test("G5 FAIL-CLOSED ON MALFORMED CONTRACTS: the pure gate treats malformed as inadmissible, never permissive; the profile derivation rejects typed", () => {
    const substituteRepresentations = [
      {
        requirementId: "rag-embeddings",
        representationKind: "deterministic-substitute" as const,
        claimId: "rag-embeddings",
        claimVersion: "1.0.0",
        publisher: "pcs-003:probe",
        basis: {
          executionId: "exec-000456",
          capabilityId: "rag-embeddings",
          substituteId: "lexical-hash-vectorizer",
        },
      },
    ];
    const candidate = {
      strategyId: "deterministic-only",
      plan: buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [
            { id: "det-0", stepClass: "run-algorithm", capabilityId: "rag-embeddings" },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "det-0", to: "verify" }],
        },
        digest,
      ),
      expectedCostMicroUsd: "5",
      expectedQuality: 0.9,
      expectedLatencyMs: 10,
      verificationStrategy: "retrieval-recall-check",
      routeRationale: { code: "deterministic-sufficient" as const, detail: "test" },
      modelCalls: 0,
      admissible: true,
    };

    // Malformed spellings reach the pure gate (defense in depth): every
    // one is INADMISSIBLE with the fail-closed typed reason.
    const malformedContracts: unknown[] = [
      { kind: "declared", requirement: "requires-good-vibes", acceptanceBasis: "x" },
      { kind: "declared", requirement: "requires-semantic-retrieval-quality", acceptanceBasis: "" },
      { kind: "maybe" },
      { kind: "absent", requirement: "requires-semantic-retrieval-quality" },
      "declared",
      42,
    ];
    for (const malformed of malformedContracts) {
      const classification = classifySemanticQualityContract(malformed);
      expect(classification.kind, JSON.stringify(malformed)).toBe("malformed");
      const gated = applySemanticQualityGating(candidate, {
        contract: classification,
        representations: substituteRepresentations,
      });
      expect(gated.admissible, JSON.stringify(malformed)).toBe(false);
      expect(gated.inadmissibleReason).toBe("semantic-quality-contract-malformed");
    }
    // The permissive defaults are exactly the two absence spellings.
    expect(
      applySemanticQualityGating(candidate, {
        contract: classifySemanticQualityContract(undefined),
        representations: substituteRepresentations,
      }).admissible,
    ).toBe(true);
    expect(
      applySemanticQualityGating(candidate, {
        contract: classifySemanticQualityContract({ kind: "absent" }),
        representations: substituteRepresentations,
      }).admissible,
    ).toBe(true);

    // The task-authoring boundary: deriveTaskProfile rejects a malformed
    // declared contract typed (fail closed at derivation).
    expect(() =>
      deriveTaskProfile(
        {
          task: {
            kind: "mixed",
            semanticReasoning: false,
            requiredCapabilities: [{ id: "rag-embeddings", kind: "algorithm" }],
            input: { q: 1 },
            semanticQualityContract: {
              kind: "declared",
              requirement: "requires-good-vibes",
              acceptanceBasis: "x",
            },
          },
        },
        (value) => sha256(JSON.stringify(value)),
      ),
    ).toThrowError(/semanticQualityContract is malformed/);
  });

  test("G6 THE INVARIANT-13 BOUNDARY: the gating never lowers a quality floor, raises a budget ceiling or bypasses policy", async () => {
    // (a) Policy verdicts are never overridden: a policy-forbidden route
    //     keeps its policy reason whether the contract is declared or not.
    const forbiddenPolicy = policySet("g6-forbidden", {
      providerModel: { deniedProviders: ["rail-b"] },
    });
    for (const withContract of [false, true]) {
      const outcome = await planTaskOnWorld(
        {
          ...substituteWorld,
          policySet: forbiddenPolicy,
        },
        {
          ...RAG_AND_MODEL_TASK,
          ...(withContract ? { semanticQualityContract: DECLARED_CONTRACT } : {}),
        },
        `g6a-${withContract}`,
      );
      expect(outcome.kind).toBe("selected");
      if (outcome.kind !== "selected") {
        return;
      }
      const forbidden = outcome.decision.candidates.find(
        (candidate) => candidate.strategyId === "generative:rail-b/model-y",
      );
      expect(forbidden?.admissible).toBe(false);
      expect(forbidden?.inadmissibleReason).toBe("policy-forbidden-route");
    }

    // (b) The quality floor is never lowered: a candidate below the
    //     policy quality floor stays inadmissible with the POLICY reason
    //     under a declared contract (the gate cannot lift it).
    const floorPolicy = policySet("g6-floor", { quality: { minQuality: 0.93 } });
    const floored = await planTaskOnWorld(
      { ...substituteWorld, policySet: floorPolicy },
      { ...RAG_AND_MODEL_TASK, semanticQualityContract: DECLARED_CONTRACT },
      "g6b",
    );
    expect(floored.kind).toBe("selected");
    if (floored.kind === "selected") {
      const below = floored.decision.candidates.find(
        (candidate) => candidate.strategyId === "generative:rail-b/model-y",
      );
      expect(below?.admissible).toBe(false);
      expect(below?.inadmissibleReason).toBe("policy-quality-floor");
    }

    // (c) The budget ceiling is never raised: an over-budget candidate
    //     stays inadmissible with the POLICY reason under a declared
    //     contract.
    const ceilingPolicy = policySet("g6-ceiling", { cost: { maxCostMicroUsd: "300" } });
    const ceilinged = await planTaskOnWorld(
      { ...substituteWorld, policySet: ceilingPolicy },
      { ...RAG_AND_MODEL_TASK, semanticQualityContract: DECLARED_CONTRACT },
      "g6c",
    );
    expect(ceilinged.kind).toBe("selected");
    if (ceilinged.kind === "selected") {
      const over = ceilinged.decision.candidates.find(
        (candidate) => candidate.strategyId === "generative:rail-a/model-x",
      );
      expect(over?.admissible).toBe(false);
      expect(over?.inadmissibleReason).toBe("policy-cost-ceiling");
    }

    // (d) The gating can only ADD inadmissibility: the gated verdict set
    //     is a subset of the ungated verdict set on the admissible axis —
    //     an already-inadmissible candidate is returned UNCHANGED (never
    //     revived, never re-reasoned).
    const representations = [
      {
        requirementId: "rag-embeddings",
        representationKind: "deterministic-substitute" as const,
        claimId: "rag-embeddings",
        claimVersion: "1.0.0",
        publisher: "pcs-003:probe",
        basis: {
          executionId: "exec-000456",
          capabilityId: "rag-embeddings",
          substituteId: "lexical-hash-vectorizer",
        },
      },
    ];
    const policyInadmissible = {
      strategyId: "deterministic-only",
      plan: buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [
            { id: "det-0", stepClass: "run-algorithm", capabilityId: "rag-embeddings" },
            { id: "verify", stepClass: "verify" },
          ],
          edges: [{ from: "det-0", to: "verify" }],
        },
        digest,
      ),
      expectedCostMicroUsd: "5",
      expectedQuality: 0.5,
      expectedLatencyMs: 10,
      verificationStrategy: "x",
      routeRationale: { code: "deterministic-sufficient" as const, detail: "test" },
      modelCalls: 0,
      admissible: false,
      inadmissibleReason: "policy-quality-floor" as const,
    };
    const untouched = applySemanticQualityGating(policyInadmissible, {
      contract: classifySemanticQualityContract(DECLARED_CONTRACT),
      representations,
    });
    expect(untouched).toBe(policyInadmissible);
  });
});
