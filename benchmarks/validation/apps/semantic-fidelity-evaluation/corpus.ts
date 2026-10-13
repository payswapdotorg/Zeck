/**
 * The evaluation's pinned corpus, thresholds and labels (PCS-004).
 *
 * THE PINNED EVALUATION CORPUS: the committed quality fixtures
 * (fixtures.ts), the curated semantic dictionaries, the gating control
 * matrix (controls.ts) and the PPR-025/PPR-026 replay lines (replay.ts)
 * — one canonical corpus projection, digest-pinned (the corpus digest
 * is stable across runs; a corpus change is a different digest).
 *
 * THE EXPLICIT OUTCOME THRESHOLDS (declared BEFORE the run — the
 * PCR-003 threshold-report pattern): every threshold below is
 * committed with the corpus and the report derives its verdicts
 * against THESE declarations, never against post-hoc numbers. A
 * threshold miss with honest attribution is a VALID delivery (the
 * program's truth discipline).
 *
 * HONEST LABELS (binding on every number this evaluation emits):
 * synthetic-supply (the deterministic executors and the curated
 * dictionaries — never a live provider), synthetic-semantic-supply
 * (the oracle's curated-knowledge upper bound — never a live model
 * measurement), and NO cost or latency measurements at all (this
 * evaluation measures retrieval quality distinctions and gating
 * verdicts, nothing else).
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical";
import { ALL_CONTROLS, CONTROL_KINDS, controlCensus } from "./controls";
import {
  CURATED_SEMANTIC_DICTIONARY,
  FIXTURE_GROUPS,
  fixtureCensusByGroup,
  fixtureCorpusIntegrity,
  QUALITY_FIXTURES,
} from "./fixtures";
import { PPR_025_ERA, PPR_026_ERA, REPLAY_LINES } from "./replay";

/** The evaluation's identity. */
export const EVALUATION_ID = "semantic-fidelity-evaluation";
/** The corpus version (pinned; a corpus change is a new version). */
export const CORPUS_VERSION = "pcs-004-semantic-fidelity-evaluation-v1";
/** The task kind the evaluation's corpus rows carry. */
export const TASK_KIND = "semantic-fidelity-evaluation.evaluation.v1";
/**
 * The governed base revision the evaluation runs at (the PCS-004
 * branch point — 086e039, the PCS-003 delivered-records head).
 */
export const BASE_REVISION = "086e0399942ff2666dc7fd2888d153a671051922";

// ---------------------------------------------------------------------------
// The two representation arms (the closed arm vocabulary)
// ---------------------------------------------------------------------------

/** The closed arm vocabulary (the two representations compared). */
export const ARM_IDS = ["deterministic-substitute", "synthetic-semantic-supply"] as const;
export type ArmId = (typeof ARM_IDS)[number];

/** The arms' honest labels (carried on every artifact). */
export const ARM_LABELS: Readonly<Record<ArmId, string>> = {
  "deterministic-substitute":
    "the deterministic lexical/hash substitute — the REAL PPR-025 Zeck-side executor (compat/openwebui/harness/embeddings.ts, imported read-only): the era's recorded execution representation, SHA-256-signed feature hashing of surface tokens, 512 fixed dimensions (synthetic-supply — never a model rail)",
  "synthetic-semantic-supply":
    "the synthetic semantic supply — concept normalization through the committed curated dictionaries + the SAME feature-hash arithmetic as the substitute (same tokenizer, dimensions, weighting, normalization): the declared upper bound of model-backed semantic retrieval ON THIS CURATED CORPUS (synthetic-semantic-supply — NEVER a live model measurement; live credentialed validation is the operator-era obligation)",
} as const;

// ---------------------------------------------------------------------------
// The explicit outcome thresholds (declared BEFORE the run)
// ---------------------------------------------------------------------------

/**
 * The declared thresholds (the evaluation contract). Every verdict in
 * the report derives mechanically against these declarations:
 *
 *  - T1 (the measurable distinction): the synthetic semantic arm
 *    retrieves the ground-truth neighbor FIRST on 100% of every
 *    fixture group, AND the deterministic substitute arm is strictly
 *    below it on every group (the measured distinction between
 *    model-backed semantic quality and the lexical/hash substitute —
 *    the whole reason ACR-009 exists);
 *  - T2 (the hard gate — ZERO admissions): every hard-gate control
 *    (a task declaring `requires-semantic-retrieval-quality` offered
 *    ONLY the deterministic substitute) FAILS CLOSED with the typed
 *    reason `semantic-quality-contract-forbids-substitute`; any
 *    admission is delivery-blocking;
 *  - T3 (differentiated evidence): the mechanical discriminator
 *    separates the representations on 100% of emitted records with
 *    BOTH kinds present (a consumer reading only the typed facts, no
 *    prose);
 *  - T4 (the replay): per replay line — the era target ranks first
 *    under the substitute on the era's lexically-overlapping corpus
 *    (the era's honest basis, never relabeled), and the gated
 *    configuration fails the same task closed with the typed reason;
 *  - T5 (reproducibility): the re-run digest is byte-identical.
 */
export interface EvaluationThresholds {
  /** T1a: the synthetic semantic arm's per-group top-1 ground-truth accuracy (fraction, 1 = 100%). */
  readonly t1aSemanticTop1PerGroup: 1;
  /** T1b: the deterministic substitute must be STRICTLY below the semantic arm on every group. */
  readonly t1bSubstituteStrictlyBelowPerGroup: true;
  /** T2: the hard gate — 100% of hard-gate controls fail closed with the typed reason; 0 admitted. */
  readonly t2HardGateFailClosedFraction: 1;
  /** T3: the discriminator separates 100% of emitted records, both kinds present. */
  readonly t3DiscriminatorCoverageFraction: 1;
  /** T4: every replay line's two arms both hold (era retrieval + gated fail-closed). */
  readonly t4ReplayLinesAllHold: true;
  /** T5: the re-run digest is byte-identical. */
  readonly t5ReRunDigestIdentical: true;
}

export const THRESHOLDS: EvaluationThresholds = {
  t1aSemanticTop1PerGroup: 1,
  t1bSubstituteStrictlyBelowPerGroup: true,
  t2HardGateFailClosedFraction: 1,
  t3DiscriminatorCoverageFraction: 1,
  t4ReplayLinesAllHold: true,
  t5ReRunDigestIdentical: true,
} as const;

/** The closed verdict vocabulary per threshold. */
export const THRESHOLD_VERDICTS = ["met", "missed", "delivery-blocking"] as const;
export type ThresholdVerdict = (typeof THRESHOLD_VERDICTS)[number];

// ---------------------------------------------------------------------------
// The honest labels (carried on every number the evaluation emits)
// ---------------------------------------------------------------------------

export const SYNTHETIC_LABELS = {
  supply:
    "synthetic-supply (the deterministic executors and the committed curated dictionaries — never a live provider)",
  semanticSupply:
    "synthetic-semantic-supply (the curated-knowledge upper bound on this corpus — never a live model measurement; live credentialed semantic-quality validation is the operator-era obligation, never backfilled)",
  measurement:
    "no cost and no latency measurements (this evaluation measures retrieval quality distinctions and gating verdicts, nothing else)",
} as const;

// ---------------------------------------------------------------------------
// The canonical corpus projection + the pinned digest
// ---------------------------------------------------------------------------

/** The corpus integrity invariants (asserted at load — fail-closed). */
function assertCorpusIntegrity(): void {
  const problems = [
    ...fixtureCorpusIntegrity(),
    ...(fixtureCensusByGroup()["paraphrase-synonym-retrieval"] < 6
      ? ["fixture census: fewer than 6 paraphrase fixtures"]
      : []),
    ...(fixtureCensusByGroup()["cross-lingual-nearest-neighbor"] < 6
      ? ["fixture census: fewer than 6 cross-lingual fixtures"]
      : []),
    ...(fixtureCensusByGroup()["polysemy-discrimination"] < 6
      ? ["fixture census: fewer than 6 polysemy fixtures"]
      : []),
  ];
  if (problems.length > 0) {
    throw new Error(
      `the committed fixture corpus is not well-formed (fail-closed): ${problems.join("; ")}`,
    );
  }
}

assertCorpusIntegrity();

/** The canonical corpus projection the digest covers (deterministic — no timestamps, no run ids). */
export function evaluationCorpusForm(): Record<string, unknown> {
  return {
    version: CORPUS_VERSION,
    baseRevision: BASE_REVISION,
    arms: ARM_IDS.map((armId) => ({ armId, label: ARM_LABELS[armId] })),
    fixtureGroups: [...FIXTURE_GROUPS],
    fixtures: QUALITY_FIXTURES.map((fixture) => ({
      fixtureId: fixture.fixtureId,
      group: fixture.group,
      query: fixture.query,
      groundTruthTargetId: fixture.groundTruthTargetId,
      candidates: fixture.candidates.map((candidate) => ({
        id: candidate.id,
        text: candidate.text,
        role: candidate.role,
      })),
      relationLabel: fixture.relationLabel,
    })),
    curatedSemanticDictionary: CURATED_SEMANTIC_DICTIONARY.map((entry) => ({ ...entry })),
    controlKinds: [...CONTROL_KINDS],
    controls: ALL_CONTROLS.map((control) => ({
      controlTaskId: control.controlTaskId,
      kind: control.kind,
      contract: control.contract ?? null,
      candidate: control.candidate,
      representations: control.representations,
      expected: control.expected,
    })),
    replayLines: REPLAY_LINES.map((line) => ({
      lineId: line.lineId,
      edgeId: line.edgeId,
      eraWorkOrder: line.eraWorkOrder,
      eraTaskId: line.eraTaskId,
      query: line.query,
      eraAnswerToken: line.eraAnswerToken,
      documents: line.documents.map((document) => ({
        id: document.id,
        role: document.role,
        provenance: document.provenance,
        text: document.text,
      })),
      expectedTop1UnderSubstitute: line.expectedTop1UnderSubstitute,
      gatedContract: line.gatedContract,
    })),
    eraRecords: [
      {
        workOrder: PPR_025_ERA.workOrder,
        recordId: PPR_025_ERA.recordId,
        limitation: PPR_025_ERA.limitation,
      },
      {
        workOrder: PPR_026_ERA.workOrder,
        recordId: PPR_026_ERA.recordId,
        limitation: PPR_026_ERA.limitation,
      },
    ],
    thresholds: THRESHOLDS,
    labels: SYNTHETIC_LABELS,
  };
}

/** The pinned corpus digest (sha256 over the canonical corpus form — stable across runs). */
export function pinnedEvaluationCorpusDigest(): string {
  return createHash("sha256").update(canonicalJson(evaluationCorpusForm())).digest("hex");
}

/** The control census pinned beside the corpus. */
export const CONTROL_CENSUS: Readonly<Record<string, number>> = controlCensus();
