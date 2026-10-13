/**
 * The semantic-fidelity evaluation driver (PCS-004 — the engine).
 *
 * Runs the three evidence lines over the committed corpus and emits
 * the typed records + the threshold verdicts:
 *
 *  - the QUALITY FIXTURES: both representations rank every fixture's
 *    candidates (the REAL substitute executor vs the synthetic
 *    semantic oracle) — every record carries its typed
 *    SemanticFidelityFacts and the measured ranking;
 *  - the GATING CONTROLS: every control (the hard-gate set + the
 *    discriminating matrix) is gated through the local projection
 *    (gate.ts — pinned verdict-for-verdict against the REAL planner
 *    gate in-suite) with the disclosure projected from typed facts;
 *  - the REPLAY LINES: the PPR-025/026 embeddings edges re-run under
 *    BOTH contract spellings — contract-absent (the substitute
 *    executes: the era's honest lexical-overlap basis, the
 *    substitution fact recorded, the met-by-deterministic-substitute
 *    disclosure) and contract-declared (the gated configuration: the
 *    substitute is TYPED INADMISSIBLE — the task fails closed, no
 *    vector produced for its satisfaction).
 *
 * DETERMINISM (the deterministic replay discipline): every record is a
 * pure function of the committed corpus — the same corpus always
 * produces the byte-identical records, the byte-identical aggregate
 * and the byte-identical evaluation digest. Wall-clock values and run
 * identities are EXCLUDED from every digest projection (they live
 * only in the run metadata, never in the digested content).
 *
 * VERDICT HONESTY (the truth discipline): every threshold verdict is
 * DERIVED from the measured records against the declared thresholds
 * (corpus.ts) — a miss is a miss with attribution, never a fabricated
 * pass.
 */

import { digestOf } from "./canonical";
import { ALL_CONTROLS, type GatingControl, SUBSTITUTED_RAG_EMBEDDINGS } from "./controls";
import { ARM_IDS, ARM_LABELS, type ArmId, pinnedEvaluationCorpusDigest } from "./corpus";
import { discriminateRepresentation, type SemanticFidelityFacts } from "./fidelity";
import { type FixtureGroup, QUALITY_FIXTURES } from "./fixtures";
import {
  applyQualityContractGatingMirror,
  buildSubstitutionCaptureMirror,
  classifyQualityContractMirror,
  type LocalDisclosureEntry,
  type LocalGateVerdict,
  projectDisclosureMirror,
} from "./gate";
import { type EraRecord, PPR_025_ERA, PPR_026_ERA, REPLAY_LINES } from "./replay";
import {
  factsOfRepresentation,
  rankCandidates,
  substituteEmbeddingOf,
  substituteEmbeddingWellFormed,
  syntheticSemanticEmbeddingOf,
} from "./representations";

// ---------------------------------------------------------------------------
// The emitted typed records (every record carries its typed facts)
// ---------------------------------------------------------------------------

/** One ranked candidate as emitted on a record. */
export interface EmittedRanking {
  readonly id: string;
  readonly similarity: number;
  readonly rank: number;
}

/** One quality-fixture arm record (the measured ranking + the typed facts). */
export interface FixtureArmRecord {
  readonly recordId: string;
  readonly line: "quality-fixture";
  readonly fixtureId: string;
  readonly group: FixtureGroup;
  readonly arm: ArmId;
  readonly representation: SemanticFidelityFacts;
  readonly retrieval: {
    readonly ranked: readonly EmittedRanking[];
    readonly top1Id: string;
    readonly groundTruthId: string;
    readonly resolved: boolean;
  };
}

/** One gating-control record (the gate verdict + the disclosure, from typed facts only). */
export interface ControlRecord {
  readonly recordId: string;
  readonly line: "negative-control" | "discriminating-control";
  readonly controlTaskId: string;
  readonly kind: GatingControl["kind"];
  readonly contractSpelling: unknown;
  readonly representations: readonly SemanticFidelityFacts[];
  readonly gate: {
    readonly verdict: "admissible" | "inadmissible";
    readonly reason?: string;
    readonly unchanged?: boolean;
  };
  readonly disclosure: readonly LocalDisclosureEntry[];
}

/** One replay-line record (the era quotes + both contract arms). */
export interface ReplayRecord {
  readonly recordId: string;
  readonly line: "replay-line";
  readonly lineId: string;
  readonly edgeId: string;
  readonly eraWorkOrder: "PPR-025" | "PPR-026";
  readonly eraTaskId: string;
  /** The era's recorded facts, QUOTED verbatim (never relabeled). */
  readonly eraQuoted: {
    readonly recordId: string;
    readonly recordedAt: string;
    readonly limitation: EraRecord["limitation"];
    readonly edgeDisposition: EraRecord["dispositions"][number] | null;
  };
  /** The contract-absent arm: the substitute EXECUTES (the era's basis). */
  readonly absentArm: {
    readonly representation: SemanticFidelityFacts;
    readonly retrieval: {
      readonly ranked: readonly EmittedRanking[];
      readonly top1Id: string;
      readonly expectedTop1Id: string;
      readonly resolved: boolean;
    };
    readonly vectorWellFormed: boolean;
    readonly substitutionFact: ReturnType<typeof buildSubstitutionCaptureMirror>;
    readonly disclosure: readonly LocalDisclosureEntry[];
  };
  /** The gated arm (contract declared): the substitute is TYPED INADMISSIBLE. */
  readonly gatedArm: {
    readonly gate: LocalGateVerdict;
    readonly disclosure: readonly LocalDisclosureEntry[];
    /** The hard gate's point: no vector is produced for the task's satisfaction. */
    readonly vectorProducedForTaskSatisfaction: false;
  };
}

/** The measured aggregate + the derived threshold verdicts. */
export interface EvaluationAggregate {
  readonly fixtures: {
    readonly perGroup: Readonly<
      Record<
        FixtureGroup,
        { readonly total: number; readonly substituteTop1: number; readonly semanticTop1: number }
      >
    >;
    readonly overall: {
      readonly total: number;
      readonly substituteTop1: number;
      readonly semanticTop1: number;
    };
  };
  readonly controls: {
    readonly hardGateTotal: number;
    readonly hardGateFailedClosedWithTypedReason: number;
    readonly hardGateAdmitted: number;
    readonly discriminatingTotal: number;
    readonly discriminatingAsExpected: number;
  };
  readonly replay: {
    readonly lines: number;
    readonly eraTargetRankedFirst: number;
    readonly gatedFailClosed: number;
  };
  readonly discrimination: {
    readonly recordsWithRepresentations: number;
    readonly separated: number;
    readonly semanticModelBacked: number;
    readonly deterministicSubstitute: number;
    readonly rejected: number;
  };
  readonly verdicts: Readonly<Record<string, { verdict: string; attribution?: string }>>;
}

/** The full evaluation result (the records + the aggregate + the digest). */
export interface EvaluationResult {
  readonly corpusDigest: string;
  readonly fixtureRecords: readonly FixtureArmRecord[];
  readonly controlRecords: readonly ControlRecord[];
  readonly replayRecords: readonly ReplayRecord[];
  readonly aggregate: EvaluationAggregate;
  /** The evaluation digest (canonical projection — wall-clock and run identities excluded). */
  readonly digest: string;
}

// ---------------------------------------------------------------------------
// The quality fixtures (both arms rank every fixture)
// ---------------------------------------------------------------------------

/** The embedding function of one arm. */
function embedOf(arm: ArmId): (text: string) => readonly number[] {
  return arm === "deterministic-substitute" ? substituteEmbeddingOf : syntheticSemanticEmbeddingOf;
}

/** The typed facts of one arm's record for one fixture. */
function fixtureFacts(fixtureId: string, arm: ArmId): SemanticFidelityFacts {
  return factsOfRepresentation(
    arm === "deterministic-substitute"
      ? {
          kind: "deterministic-substitute",
          executionId: `pcs004-fixture-${fixtureId}`,
          capabilityId: "rag-embeddings",
          substituteId: "ppr-025-deterministic-embeddings",
        }
      : {
          kind: "semantic-model-backed",
          executionId: `pcs004-fixture-${fixtureId}-synthetic-semantic-supply`,
          capabilityId: "semantic-embeddings",
        },
  );
}

function runFixtureArms(): readonly FixtureArmRecord[] {
  const records: FixtureArmRecord[] = [];
  for (const fixture of QUALITY_FIXTURES) {
    for (const arm of ARM_IDS) {
      const ranked = rankCandidates(
        fixture.query,
        fixture.candidates.map((candidate) => ({ id: candidate.id, text: candidate.text })),
        embedOf(arm),
      );
      const top1 = ranked[0];
      if (top1 === undefined) {
        throw new Error(`fixture ${fixture.fixtureId} ranked no candidates (fail-closed)`);
      }
      records.push({
        recordId: `fixture:${fixture.fixtureId}:${arm}`,
        line: "quality-fixture",
        fixtureId: fixture.fixtureId,
        group: fixture.group,
        arm,
        representation: fixtureFacts(fixture.fixtureId, arm),
        retrieval: {
          ranked,
          top1Id: top1.id,
          groundTruthId: fixture.groundTruthTargetId,
          resolved: top1.id === fixture.groundTruthTargetId,
        },
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// The gating controls (the local projection; pinned against the REAL gate in-suite)
// ---------------------------------------------------------------------------

/** The typed facts of one control's offered representations. */
function controlRepresentationFacts(control: GatingControl): readonly SemanticFidelityFacts[] {
  return control.representations.map((representation) =>
    factsOfRepresentation(
      representation.representationKind === "deterministic-substitute"
        ? {
            kind: "deterministic-substitute",
            executionId: representation.basis.executionId,
            capabilityId: representation.basis.capabilityId,
            substituteId: representation.basis.substituteId,
          }
        : {
            kind: "semantic-model-backed",
            executionId: representation.basis.executionId,
            capabilityId: representation.basis.capabilityId,
          },
    ),
  );
}

function runControls(): readonly ControlRecord[] {
  const records: ControlRecord[] = [];
  for (const control of ALL_CONTROLS) {
    const classification = classifyQualityContractMirror(control.contract);
    const gate = applyQualityContractGatingMirror(control.candidate, {
      contract: classification,
      representations: control.representations,
    });
    const disclosure = projectDisclosureMirror({
      contract: control.contract,
      representations: control.representations,
      selected: control.candidate,
      gating: gate,
    });
    records.push({
      recordId: `control:${control.controlTaskId}`,
      line: control.kind === "hard-gate" ? "negative-control" : "discriminating-control",
      controlTaskId: control.controlTaskId,
      kind: control.kind,
      contractSpelling: control.contract ?? null,
      representations: controlRepresentationFacts(control),
      gate:
        gate.verdict === "admissible"
          ? { verdict: "admissible" }
          : {
              verdict: "inadmissible",
              reason: gate.reason,
              ...(gate.unchanged ? { unchanged: true } : {}),
            },
      disclosure,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// The replay lines (both contract spellings)
// ---------------------------------------------------------------------------

/** The substitute's typed facts for one replay line's absent arm. */
function replaySubstituteFacts(lineId: string): SemanticFidelityFacts {
  return factsOfRepresentation({
    kind: "deterministic-substitute",
    executionId: `pcs004-replay-${lineId}`,
    capabilityId: "rag-embeddings",
    substituteId: "ppr-025-deterministic-embeddings",
  });
}

function runReplay(): readonly ReplayRecord[] {
  const records: ReplayRecord[] = [];
  for (const line of REPLAY_LINES) {
    const era = line.eraWorkOrder === "PPR-025" ? PPR_025_ERA : PPR_026_ERA;
    // The contract-absent arm: the substitute EXECUTES over the era corpus.
    const ranked = rankCandidates(
      line.query,
      line.documents.map((document) => ({ id: document.id, text: document.text })),
      substituteEmbeddingOf,
    );
    const top1 = ranked[0];
    if (top1 === undefined) {
      throw new Error(`replay line ${line.lineId} ranked no documents (fail-closed)`);
    }
    const wellFormed = substituteEmbeddingWellFormed(substituteEmbeddingOf(line.query));
    if (!wellFormed.ok) {
      throw new Error(
        `replay line ${line.lineId}: the substitute's vector is not well-formed (${wellFormed.detail}) — fail-closed`,
      );
    }
    // The contract-absent selection records the substitution fact + the disclosure.
    const absentCandidate = {
      strategyId: "deterministic-substitute-only",
      admissible: true,
      planSteps: [{ stepId: "det-0", capabilityId: "rag-embeddings" }, { stepId: "verify" }],
    };
    const absentGate = applyQualityContractGatingMirror(absentCandidate, {
      contract: classifyQualityContractMirror({ kind: "absent" }),
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    });
    if (absentGate.verdict !== "admissible") {
      throw new Error(
        `replay line ${line.lineId}: the contract-absent arm is not admissible (fail-closed)`,
      );
    }
    const substitutionFact = buildSubstitutionCaptureMirror({
      contract: { kind: "absent" },
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
      selected: absentCandidate,
    });
    const absentDisclosure = projectDisclosureMirror({
      contract: { kind: "absent" },
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
      selected: absentCandidate,
      gating: absentGate,
    });
    // The gated arm (contract declared): the substitute is TYPED INADMISSIBLE.
    const gatedCandidate = {
      strategyId: "deterministic-substitute-only",
      admissible: true,
      planSteps: [{ stepId: "det-0", capabilityId: "rag-embeddings" }, { stepId: "verify" }],
    };
    const gatedGate = applyQualityContractGatingMirror(gatedCandidate, {
      contract: classifyQualityContractMirror(line.gatedContract),
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
    });
    const gatedDisclosure = projectDisclosureMirror({
      contract: line.gatedContract,
      representations: [SUBSTITUTED_RAG_EMBEDDINGS],
      selected: gatedCandidate,
      gating: gatedGate,
    });
    records.push({
      recordId: `replay:${line.lineId}`,
      line: "replay-line",
      lineId: line.lineId,
      edgeId: line.edgeId,
      eraWorkOrder: line.eraWorkOrder,
      eraTaskId: line.eraTaskId,
      eraQuoted: {
        recordId: era.recordId,
        recordedAt: era.recordedAt,
        limitation: era.limitation,
        edgeDisposition:
          era.dispositions.find((disposition) => disposition.edgeId === line.edgeId) ?? null,
      },
      absentArm: {
        representation: replaySubstituteFacts(line.lineId),
        retrieval: {
          ranked,
          top1Id: top1.id,
          expectedTop1Id: line.expectedTop1UnderSubstitute,
          resolved: top1.id === line.expectedTop1UnderSubstitute,
        },
        vectorWellFormed: wellFormed.ok,
        substitutionFact,
        disclosure: absentDisclosure,
      },
      gatedArm: {
        gate: gatedGate,
        disclosure: gatedDisclosure,
        vectorProducedForTaskSatisfaction: false,
      },
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// The aggregate + the honest verdicts
// ---------------------------------------------------------------------------

/** The per-group top-1 accuracy of one arm. */
function top1CountOf(
  records: readonly FixtureArmRecord[],
  arm: ArmId,
  group?: FixtureGroup,
): number {
  return records.filter(
    (record) =>
      record.arm === arm &&
      (group === undefined || record.group === group) &&
      record.retrieval.resolved,
  ).length;
}

/** The discriminator's coverage over the emitted representations (the differentiated-evidence measurement). */
function discriminationCoverage(
  fixtureRecords: readonly FixtureArmRecord[],
  controlRecords: readonly ControlRecord[],
  replayRecords: readonly ReplayRecord[],
  discriminate: (value: unknown) => { kind: string; representationKind?: string },
): EvaluationAggregate["discrimination"] {
  let records = 0;
  let separated = 0;
  let semantic = 0;
  let deterministic = 0;
  let rejected = 0;
  const visit = (facts: SemanticFidelityFacts): void => {
    records += 1;
    const verdict = discriminate(facts);
    if (verdict.kind === "separated") {
      separated += 1;
      if (verdict.representationKind === "semantic-model-backed") {
        semantic += 1;
      } else {
        deterministic += 1;
      }
    } else {
      rejected += 1;
    }
  };
  for (const record of fixtureRecords) {
    visit(record.representation);
  }
  for (const record of controlRecords) {
    for (const facts of record.representations) {
      visit(facts);
    }
  }
  for (const record of replayRecords) {
    visit(record.absentArm.representation);
  }
  return {
    recordsWithRepresentations: records,
    separated,
    semanticModelBacked: semantic,
    deterministicSubstitute: deterministic,
    rejected,
  };
}

/** Derive the threshold verdicts from the measured records (honest — a miss is a miss). */
function deriveVerdicts(
  fixtureRecords: readonly FixtureArmRecord[],
  controlRecords: readonly ControlRecord[],
  replayRecords: readonly ReplayRecord[],
  discrimination: EvaluationAggregate["discrimination"],
): EvaluationAggregate["verdicts"] {
  // T1 — the measurable distinction (per group).
  const groups = new Set(fixtureRecords.map((record) => record.group));
  const t1aGroupsMissed: string[] = [];
  const t1bGroupsMissed: string[] = [];
  for (const group of groups) {
    const total = fixtureRecords.filter((record) => record.group === group).length / 2;
    const semanticTop1 = top1CountOf(fixtureRecords, "synthetic-semantic-supply", group);
    const substituteTop1 = top1CountOf(fixtureRecords, "deterministic-substitute", group);
    if (semanticTop1 !== total) {
      t1aGroupsMissed.push(`${group} ${semanticTop1}/${total}`);
    }
    if (!(substituteTop1 < semanticTop1)) {
      t1bGroupsMissed.push(
        `${group} substitute ${substituteTop1} not below semantic ${semanticTop1}`,
      );
    }
  }
  // T2 — the hard gate.
  const hardGate = controlRecords.filter((record) => record.kind === "hard-gate");
  const hardGateFailedClosed = hardGate.filter(
    (record) =>
      record.gate.verdict === "inadmissible" &&
      record.gate.reason === "semantic-quality-contract-forbids-substitute",
  ).length;
  const hardGateAdmitted = hardGate.filter((record) => record.gate.verdict === "admissible").length;
  // T3 — the differentiated evidence.
  const t3Met =
    discrimination.rejected === 0 &&
    discrimination.separated === discrimination.recordsWithRepresentations &&
    discrimination.semanticModelBacked > 0 &&
    discrimination.deterministicSubstitute > 0;
  // T4 — the replay lines.
  const replayResolved = replayRecords.filter(
    (record) => record.absentArm.retrieval.resolved,
  ).length;
  const replayGated = replayRecords.filter(
    (record) =>
      record.gatedArm.gate.verdict === "inadmissible" &&
      record.gatedArm.gate.reason === "semantic-quality-contract-forbids-substitute",
  ).length;
  const verdicts: Record<string, { verdict: string; attribution?: string }> = {};
  verdicts.t1aSemanticTop1PerGroup =
    t1aGroupsMissed.length === 0
      ? { verdict: "met" }
      : {
          verdict: "missed",
          attribution: `the synthetic semantic arm missed the ground truth on: ${t1aGroupsMissed.join(", ")} (synthetic-semantic-supply — the curated oracle must be perfect on its own curated corpus or the construction is broken)`,
        };
  verdicts.t1bSubstituteStrictlyBelowPerGroup =
    t1bGroupsMissed.length === 0
      ? { verdict: "met" }
      : {
          verdict: "missed",
          attribution: `the deterministic substitute was not strictly below the semantic arm on: ${t1bGroupsMissed.join(", ")}`,
        };
  verdicts.t2HardGateFailClosed =
    hardGateAdmitted === 0 && hardGateFailedClosed === hardGate.length
      ? { verdict: "met" }
      : hardGateAdmitted > 0
        ? {
            verdict: "delivery-blocking",
            attribution: `${hardGateAdmitted} hard-gate control(s) ADMITTED a task declaring requires-semantic-retrieval-quality on the deterministic substitute — the gate failed closed on nothing`,
          }
        : {
            verdict: "missed",
            attribution: `${hardGateFailedClosed}/${hardGate.length} hard-gate controls failed closed with the typed reason`,
          };
  verdicts.t3DiscriminatorCoverage = t3Met
    ? { verdict: "met" }
    : {
        verdict: "missed",
        attribution: `the discriminator separated ${discrimination.separated}/${discrimination.recordsWithRepresentations} records (semantic ${discrimination.semanticModelBacked}, deterministic ${discrimination.deterministicSubstitute}, rejected ${discrimination.rejected})`,
      };
  verdicts.t4ReplayLinesAllHold =
    replayResolved === replayRecords.length && replayGated === replayRecords.length
      ? { verdict: "met" }
      : {
          verdict: "missed",
          attribution: `era target ranked first on ${replayResolved}/${replayRecords.length} lines; gated arm failed closed on ${replayGated}/${replayRecords.length} lines`,
        };
  // T5 is proven by the re-run digest comparison (run.ts / the suites) — recorded there.
  return verdicts;
}

/** The digest projection of the records + aggregate (deterministic — wall-clock and run identities excluded). */
function evaluationDigestOf(
  corpusDigest: string,
  fixtureRecords: readonly FixtureArmRecord[],
  controlRecords: readonly ControlRecord[],
  replayRecords: readonly ReplayRecord[],
  aggregate: EvaluationAggregate,
): string {
  return digestOf({
    corpusDigest,
    fixtureRecords,
    controlRecords,
    replayRecords,
    aggregateVerdicts: aggregate.verdicts,
    aggregateFixtures: aggregate.fixtures,
    aggregateControls: aggregate.controls,
    aggregateReplay: aggregate.replay,
    aggregateDiscrimination: aggregate.discrimination,
  });
}

/** Run the complete evaluation (pure over the committed corpus — deterministic). */
export function runEvaluation(): EvaluationResult {
  const fixtureRecords = runFixtureArms();
  const controlRecords = runControls();
  const replayRecords = runReplay();
  const discrimination = discriminationCoverage(
    fixtureRecords,
    controlRecords,
    replayRecords,
    discriminateRepresentation,
  );
  const groups = [...new Set(fixtureRecords.map((record) => record.group))];
  const perGroup: Record<
    FixtureGroup,
    { total: number; substituteTop1: number; semanticTop1: number }
  > = {} as Record<FixtureGroup, { total: number; substituteTop1: number; semanticTop1: number }>;
  for (const group of groups) {
    const total = fixtureRecords.filter((record) => record.group === group).length / 2;
    perGroup[group] = {
      total,
      substituteTop1: top1CountOf(fixtureRecords, "deterministic-substitute", group),
      semanticTop1: top1CountOf(fixtureRecords, "synthetic-semantic-supply", group),
    };
  }
  const verdicts = deriveVerdicts(fixtureRecords, controlRecords, replayRecords, discrimination);
  const aggregate: EvaluationAggregate = {
    fixtures: {
      perGroup,
      overall: {
        total: fixtureRecords.length / 2,
        substituteTop1: top1CountOf(fixtureRecords, "deterministic-substitute"),
        semanticTop1: top1CountOf(fixtureRecords, "synthetic-semantic-supply"),
      },
    },
    controls: {
      hardGateTotal: controlRecords.filter((record) => record.kind === "hard-gate").length,
      hardGateFailedClosedWithTypedReason: controlRecords.filter(
        (record) =>
          record.kind === "hard-gate" &&
          record.gate.verdict === "inadmissible" &&
          record.gate.reason === "semantic-quality-contract-forbids-substitute",
      ).length,
      hardGateAdmitted: controlRecords.filter(
        (record) => record.kind === "hard-gate" && record.gate.verdict === "admissible",
      ).length,
      discriminatingTotal: controlRecords.filter((record) => record.kind === "discriminating")
        .length,
      discriminatingAsExpected: controlRecords.filter((record) => {
        if (record.kind !== "discriminating") {
          return false;
        }
        const control = ALL_CONTROLS.find(
          (candidate) => candidate.controlTaskId === record.controlTaskId,
        );
        if (control === undefined) {
          return false;
        }
        if (control.expected.admissible) {
          return record.gate.verdict === "admissible";
        }
        return (
          record.gate.verdict === "inadmissible" &&
          record.gate.reason === control.expected.reason &&
          (control.expected.unchanged ?? false) === (record.gate.unchanged ?? false)
        );
      }).length,
    },
    replay: {
      lines: replayRecords.length,
      eraTargetRankedFirst: replayRecords.filter((record) => record.absentArm.retrieval.resolved)
        .length,
      gatedFailClosed: replayRecords.filter(
        (record) =>
          record.gatedArm.gate.verdict === "inadmissible" &&
          record.gatedArm.gate.reason === "semantic-quality-contract-forbids-substitute",
      ).length,
    },
    discrimination,
    verdicts,
  };
  const corpusDigest = pinnedEvaluationCorpusDigest();
  return {
    corpusDigest,
    fixtureRecords,
    controlRecords,
    replayRecords,
    aggregate,
    digest: evaluationDigestOf(
      corpusDigest,
      fixtureRecords,
      controlRecords,
      replayRecords,
      aggregate,
    ),
  };
}

export { ARM_LABELS };
