/**
 * The negative controls and the discriminating control matrix (PCS-004
 * — ACR-009 §6 "negative controls", the hard gate).
 *
 * THE HARD GATE (the work order's words): tasks declaring
 * `requires-semantic-retrieval-quality` offered ONLY a deterministic
 * substitute must FAIL CLOSED with the typed inadmissibility reason —
 * **a task requiring semantic retrieval must not pass merely because a
 * deterministic vector is produced**. Every hard-gate control below is
 * a task-authored quality contract (the acceptance basis is the
 * task's own) whose candidate plan is satisfied ONLY by the
 * deterministic lexical/hash substitute — the gate's verdict must be
 * INADMISSIBLE with `semantic-quality-contract-forbids-substitute`,
 * asserted mechanically in-suite against the REAL planner gate
 * (`applySemanticQualityGating` from `src/modules/planning/public`,
 * driven by the pcs-004 suites; the local projection in gate.ts is
 * pinned verdict-for-verdict against it).
 *
 * THE DISCRIMINATING MATRIX (the gate's precision — the controls that
 * prove the gate does NOT over-block): a model-backed representation
 * satisfies a declared contract; a substitute NOT on the plan does not
 * trip the contract; the explicit `{kind: "absent"}` spelling permits
 * the substitute (with the substitution fact + disclosure recorded);
 * an undeclared contract is today's byte-identical behavior; a
 * malformed contract is fail-closed INADMISSIBLE
 * (`semantic-quality-contract-malformed`); and an already-inadmissible
 * candidate is returned UNCHANGED (the invariant-13 composition — the
 * policy verdict is never revised).
 *
 * THE CONTROL VOCABULARY (closed): `hard-gate` (must fail closed) and
 * `discriminating` (the precision matrix). Every control carries its
 * expected verdict — the suite asserts the REAL gate produces exactly
 * it (a fabricated pass is unrepresentable).
 */

import type { SemanticQualityContract } from "./fidelity";
import type { NeutralCandidate, NeutralRepresentationSummary } from "./gate";

// ---------------------------------------------------------------------------
// The representations the controls are offered (the two arms' claims)
// ---------------------------------------------------------------------------

/**
 * The deterministic-substitute representation summary every negative
 * control is offered (the REAL PPR-025 executor's provenance — the
 * same substitute identity the era's evidence records).
 */
export const SUBSTITUTED_RAG_EMBEDDINGS: NeutralRepresentationSummary = {
  requirementId: "rag-embeddings",
  representationKind: "deterministic-substitute",
  claimId: "rag-embeddings",
  claimVersion: "1.0.0",
  publisher: "pcs-004:evaluation",
  basis: {
    executionId: "exec-ppr-025-openwebui-embeddings",
    capabilityId: "rag-embeddings",
    substituteId: "ppr-025-deterministic-embeddings",
  },
} as const;

/**
 * The semantic-model-backed representation summary (the synthetic
 * semantic supply's claim — honestly labeled synthetic provenance in
 * its execution identity; NEVER a live provider claim).
 */
export const MODEL_BACKED_SEMANTIC_EMBEDDINGS: NeutralRepresentationSummary = {
  requirementId: "semantic-embeddings",
  representationKind: "semantic-model-backed",
  claimId: "semantic-embeddings",
  claimVersion: "1.0.0",
  publisher: "pcs-004:evaluation",
  basis: {
    executionId: "exec-pcs004-synthetic-semantic-supply",
    capabilityId: "semantic-embeddings",
  },
} as const;

/** The declared quality contract spelling (the task-authored requirement). */
export const DECLARED_SEMANTIC_RETRIEVAL_CONTRACT: SemanticQualityContract = {
  kind: "declared",
  requirement: "requires-semantic-retrieval-quality",
  acceptanceBasis:
    "the retrieval must rank the semantically faithful neighbor above the lexically closer distractor",
} as const;

// ---------------------------------------------------------------------------
// The control shape (neutral data — the suites construct the REAL
// CandidateStrategy + classification from it and drive the REAL gate)
// ---------------------------------------------------------------------------

/** The closed control vocabulary. */
export const CONTROL_KINDS = ["hard-gate", "discriminating"] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/** The expected gate verdict (asserted mechanically against the REAL gate). */
export interface ExpectedVerdict {
  readonly admissible: boolean;
  /** The expected inadmissibility reason (the typed `InadmissibleReasonCode`). */
  readonly reason?: string;
  /** True when the gate must return an already-inadmissible candidate UNCHANGED. */
  readonly unchanged?: boolean;
  /** The expected disclosure entries (when a verdict admits a substitute or blocks one). */
  readonly disclosureStatuses: readonly string[];
}

/** One control (a task + a candidate + the offered representations + the expected verdict). */
export interface GatingControl {
  readonly controlTaskId: string;
  readonly kind: ControlKind;
  /** The human-legible control intent (never read by the gate — documentation only). */
  readonly intent: string;
  /** The task's declared quality contract (undefined = undeclared). */
  readonly contract: SemanticQualityContract | undefined;
  readonly candidate: NeutralCandidate;
  readonly representations: readonly NeutralRepresentationSummary[];
  readonly expected: ExpectedVerdict;
}

/** The admissible-again candidate plan shape shared by the controls. */
function candidateWith(
  strategyId: string,
  planSteps: readonly { stepId: string; capabilityId?: string }[],
): NeutralCandidate {
  return { strategyId, admissible: true, planSteps };
}

// ---------------------------------------------------------------------------
// The hard-gate controls (declared contract + substitute ONLY → fail closed)
// ---------------------------------------------------------------------------

/** The fixture-class tasks (one per fixture class — the quality-fixture ground). */
const FIXTURE_CLASS_TASKS = [
  {
    controlTaskId: "task:paraphrase-retrieval",
    intent:
      "a paraphrase-retrieval task declaring requires-semantic-retrieval-quality, offered only the deterministic lexical/hash substitute — must FAIL CLOSED (the substitute measurably ranks the lexically-closer distractor first on every paraphrase fixture)",
  },
  {
    controlTaskId: "task:cross-lingual-retrieval",
    intent:
      "a cross-lingual nearest-neighbor task declaring requires-semantic-retrieval-quality, offered only the deterministic substitute — must FAIL CLOSED (zero cross-lingual lexical overlap)",
  },
  {
    controlTaskId: "task:polysemy-sense-retrieval",
    intent:
      "a polysemy-sense-retrieval task declaring requires-semantic-retrieval-quality, offered only the deterministic substitute — must FAIL CLOSED (the substitute measurably ranks the wrong-sense distractor first)",
  },
] as const;

/** The era-task negative controls (the PPR-025/026 corpus tasks re-run under the gate). */
const ERA_TASKS = [
  {
    controlTaskId: "openwebui-rag-grounded-qa",
    intent:
      "the PPR-025 corpus's RAG grounded-QA task (the era's own task-authored instruction) declaring requires-semantic-retrieval-quality, offered only the era's deterministic embeddings executor — must FAIL CLOSED under the gated configuration",
  },
  {
    controlTaskId: "openwebui-memories-embeddings",
    intent:
      "the PPR-025 corpus's pure-embedding memories task declaring requires-semantic-retrieval-quality, offered only the era's deterministic embeddings executor — must FAIL CLOSED",
  },
  {
    controlTaskId: "anythingllm-rag-grounded-qa",
    intent:
      "the PPR-026 corpus's RAG grounded-QA task declaring requires-semantic-retrieval-quality, offered only the era's deterministic embeddings executor — must FAIL CLOSED under the gated configuration",
  },
] as const;

/** The hard-gate control set (every one must fail closed with the typed reason). */
export const HARD_GATE_CONTROLS: readonly GatingControl[] = [
  ...FIXTURE_CLASS_TASKS.map(
    (task): GatingControl => ({
      controlTaskId: task.controlTaskId,
      kind: "hard-gate",
      intent: task.intent,
      contract: DECLARED_SEMANTIC_RETRIEVAL_CONTRACT,
      candidate: candidateWith("deterministic-substitute-only", [
        { stepId: "det-0", capabilityId: "rag-embeddings" },
        { stepId: "verify" },
      ]),
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
      expected: {
        admissible: false,
        reason: "semantic-quality-contract-forbids-substitute",
        disclosureStatuses: ["unmet-no-admissible-semantic-representation"],
      },
    }),
  ),
  ...ERA_TASKS.map(
    (task): GatingControl => ({
      controlTaskId: task.controlTaskId,
      kind: "hard-gate",
      intent: task.intent,
      contract: DECLARED_SEMANTIC_RETRIEVAL_CONTRACT,
      candidate: candidateWith("deterministic-substitute-only", [
        { stepId: "det-0", capabilityId: "rag-embeddings" },
        { stepId: "verify" },
      ]),
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
      expected: {
        admissible: false,
        reason: "semantic-quality-contract-forbids-substitute",
        disclosureStatuses: ["unmet-no-admissible-semantic-representation"],
      },
    }),
  ),
] as const;

// ---------------------------------------------------------------------------
// The discriminating matrix (the gate's precision)
// ---------------------------------------------------------------------------

/** The discriminating controls (the closed precision matrix). */
export const DISCRIMINATING_CONTROLS: readonly GatingControl[] = [
  {
    controlTaskId: "control:declared-model-backed",
    kind: "discriminating",
    intent:
      "a declared contract is SATISFIABLE: a semantic-model-backed representation on the plan is admissible (the gate forbids substitutes, never semantic representations)",
    contract: DECLARED_SEMANTIC_RETRIEVAL_CONTRACT,
    candidate: candidateWith("semantic-model-backed", [
      { stepId: "sem-0", capabilityId: "semantic-embeddings" },
      { stepId: "verify" },
    ]),
    representations: [MODEL_BACKED_SEMANTIC_EMBEDDINGS],
    expected: { admissible: true, disclosureStatuses: [] },
  },
  {
    controlTaskId: "control:declared-substitute-not-on-plan",
    kind: "discriminating",
    intent:
      "the contract question does not arise: a substitute representation whose requirement is NOT on the candidate's plan does not trip the declared contract",
    contract: DECLARED_SEMANTIC_RETRIEVAL_CONTRACT,
    candidate: candidateWith("clean-text-plan", [
      { stepId: "gen-0", capabilityId: "text-generation" },
      { stepId: "verify" },
    ]),
    representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    expected: { admissible: true, disclosureStatuses: [] },
  },
  {
    controlTaskId: "control:declared-mixed-plan",
    kind: "discriminating",
    intent:
      "a declared contract forbids ANY substitute riding the plan: a mixed plan (substitute for rag-embeddings + model-backed for semantic-embeddings) is INADMISSIBLE",
    contract: DECLARED_SEMANTIC_RETRIEVAL_CONTRACT,
    candidate: candidateWith("mixed-plan", [
      { stepId: "det-0", capabilityId: "rag-embeddings" },
      { stepId: "sem-0", capabilityId: "semantic-embeddings" },
    ]),
    representations: [SUBSTITUTED_RAG_EMBEDDINGS, MODEL_BACKED_SEMANTIC_EMBEDDINGS],
    expected: {
      admissible: false,
      reason: "semantic-quality-contract-forbids-substitute",
      disclosureStatuses: ["unmet-no-admissible-semantic-representation"],
    },
  },
  {
    controlTaskId: "control:absent-substitute-permitted",
    kind: "discriminating",
    intent:
      'the explicit {kind: "absent"} spelling PERMITS the substitute — admissible, with the substitution fact recorded and the met-by-deterministic-substitute disclosure projected',
    contract: { kind: "absent" },
    candidate: candidateWith("deterministic-substitute-only", [
      { stepId: "det-0", capabilityId: "rag-embeddings" },
      { stepId: "verify" },
    ]),
    representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    expected: {
      admissible: true,
      disclosureStatuses: ["met-by-deterministic-substitute"],
    },
  },
  {
    controlTaskId: "control:undeclared-substitute-permitted",
    kind: "discriminating",
    intent:
      "an UNDECLARED contract (no field at all) is today's byte-identical behavior — the substitute is permitted (absence equivalence, ACR-009 §5)",
    contract: undefined,
    candidate: candidateWith("deterministic-substitute-only", [
      { stepId: "det-0", capabilityId: "rag-embeddings" },
      { stepId: "verify" },
    ]),
    representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    expected: {
      admissible: true,
      disclosureStatuses: ["met-by-deterministic-substitute"],
    },
  },
  {
    controlTaskId: "control:malformed-contract-fail-closed",
    kind: "discriminating",
    intent:
      "an UNKNOWN requirement is fail-closed INADMISSIBLE (never a permissive default): a malformed declared contract with a substitute on the plan trips semantic-quality-contract-malformed",
    contract: {
      kind: "declared",
      requirement: "requires-good-vibes" as never,
      acceptanceBasis: "an unknown requirement outside the closed vocabulary",
    },
    candidate: candidateWith("deterministic-substitute-only", [
      { stepId: "det-0", capabilityId: "rag-embeddings" },
      { stepId: "verify" },
    ]),
    representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    expected: {
      admissible: false,
      reason: "semantic-quality-contract-malformed",
      disclosureStatuses: [],
    },
  },
  {
    controlTaskId: "control:policy-verdict-preserved",
    kind: "discriminating",
    intent:
      "the invariant-13 composition: an already-inadmissible (policy) candidate is returned UNCHANGED — the gating never revises a policy verdict, it can only ADD inadmissibility",
    contract: DECLARED_SEMANTIC_RETRIEVAL_CONTRACT,
    candidate: {
      strategyId: "policy-inadmissible",
      admissible: false,
      inadmissibleReason: "policy-forbidden-route",
      planSteps: [{ stepId: "det-0", capabilityId: "rag-embeddings" }, { stepId: "verify" }],
    },
    representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    expected: {
      admissible: false,
      reason: "policy-forbidden-route",
      unchanged: true,
      disclosureStatuses: [],
    },
  },
  {
    controlTaskId: "control:malformed-shape-absent-with-requirement",
    kind: "discriminating",
    intent:
      "the incoherent absence shape (an absent contract carrying a requirement) is MALFORMED — fail-closed, never silently read as permission",
    contract: {
      kind: "absent",
      requirement: "requires-semantic-retrieval-quality",
    } as unknown as SemanticQualityContract,
    candidate: candidateWith("deterministic-substitute-only", [
      { stepId: "det-0", capabilityId: "rag-embeddings" },
      { stepId: "verify" },
    ]),
    representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    expected: {
      admissible: false,
      reason: "semantic-quality-contract-malformed",
      disclosureStatuses: [],
    },
  },
] as const;

/** The complete control set (stable order — the digest covers this exact order). */
export const ALL_CONTROLS: readonly GatingControl[] = [
  ...HARD_GATE_CONTROLS,
  ...DISCRIMINATING_CONTROLS,
] as const;

/** The control census (pinned in-suite). */
export function controlCensus(): Readonly<Record<ControlKind, number>> {
  const out = { "hard-gate": 0, discriminating: 0 } as Record<ControlKind, number>;
  for (const control of ALL_CONTROLS) {
    out[control.kind] += 1;
  }
  return out;
}
