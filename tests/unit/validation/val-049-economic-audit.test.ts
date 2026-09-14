/**
 * VAL-049 acceptance criteria 4, 5 and 6 (the offline floor of the
 * audit machinery): the oracle matrices over the corpus.
 *
 *   * the REPLAY BIT-STABILITY pins: every honest row's recorded
 *     evidence re-derives bit-stable (the recomputed digest equals the
 *     pinned digest AND the work order's own reference digest where
 *     one exists); a FLIPPED digest on replay FAILs named; an honest
 *     divergence record WITH cause is permitted; an UNDECLARED
 *     divergence FAILs named;
 *   * the AUDIT-INTEGRITY oracles probed adversarially: the
 *     rubber-stamp confession FAILs named; the favorable-subset audit
 *     FAILs with the omitted rows NAMED; the off-bounds re-run claim
 *     FAILs named; the unresolved finding FAILs named; every honest
 *     row's verdict cites its evidence digest (an UNGROUNDED verdict
 *     FAILs named);
 *   * the GAMING-PROBE completeness matrix: every one of the ten
 *     vectors re-probed and caught with the mechanism NAMED; the three
 *     cross-vector combinations caught with BOTH mechanisms named; a
 *     missing probe FAILs named;
 *   * the DIGEST discipline: deterministic + discriminating (the house
 *     FNV-1a convention);
 *   * the driver over every offline row (the honest outcome contract):
 *     every honest control row COMPLETES reproducing the pinned audit
 *     verdicts; every adversarial audit-probe row FAILs its NAMED
 *     criterion honestly;
 *   * the live lane declaration honesty (env-gated, honest NOT RUN).
 */

import { describe, expect, test } from "vitest";
import {
  AUDIT_CORPUS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  pinnedAuditInputDigest,
  taskBodyFor,
} from "../../../benchmarks/validation/apps/economic-audit/corpus";
import type {
  AuditCorpusRow,
  AuditedEvidenceReference,
  GamingVector,
} from "../../../benchmarks/validation/apps/economic-audit/driver";
import {
  auditEvidenceDigestOf,
  auditLiveGateOpen,
  CROSS_VECTOR_COMBINATIONS,
  deriveAuditRowCriteria,
  deriveAuditVerdict,
  deriveBoundsHeld,
  deriveFavorableSubsetSampling,
  deriveGamingProbeCompleteness,
  deriveReplayBitStability,
  deriveResolutionHonesty,
  deriveRubberStampDetection,
  deriveVerdictGrounding,
  driveAuditRow,
  GAMING_MECHANISM_OF,
  GAMING_VECTORS,
  LIVE_AUDIT_PLAN,
  liveAuditPlanDigestOf,
  offlineRowIdsOf,
  replayRecordedEvidenceOf,
} from "../../../benchmarks/validation/apps/economic-audit/driver";
import {
  combinationGamingProbeOf,
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createRealAccountingRails,
  createTickClock,
  dishonestScopeOmittedRowsOf,
  gamingProbesFor,
  singleGamingProbeOf,
} from "../../../benchmarks/validation/apps/economic-audit/fixtures";
import type { LabVerificationCriterion } from "../../../benchmarks/validation/platform/derive";
import type { RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "a49d09be1d4c05e3f6a2b8d9e0c1a2b3c4d5e6f7";

const metadataOf = (observedAt: string): RunMetadata => ({
  program: "zeck-validation",
  workOrder: "VAL-049",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-049-economic-audit-v1",
  integrationSurface: "audit:recorded-evidence-replay",
  environment: {
    runtime: "node test",
    toolchain: "vitest",
    database: "none",
    configuration: { suite: "val-049-unit" },
  },
  observedAt,
});

const rowById = (rowId: string): AuditCorpusRow => {
  const row = AUDIT_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const criterionOf = (
  result: { criteria: readonly LabVerificationCriterion[] },
  id: string | undefined,
) => result.criteria.find((criterion) => criterion.criterionId === id);

/** The replays of one row's evidence (the re-derivation trace). */
const replaysOf = (row: AuditCorpusRow) =>
  row.evidence.map((reference) => replayRecordedEvidenceOf(reference));

/** Drive one row over the honest offline stack (the unit oracle floor). */
async function driveRowOverHonestStack(row: AuditCorpusRow) {
  const clock = createTickClock();
  const ledger = createFakeLedger(clock);
  const seam = createFakeSubmissionSeam({ ledger });
  const lifecycle = createFakeLifecycle({ ledger });
  const baseline = ledger.facts();
  const submission = await seam({ key: `val-049-unit-${row.rowId}`, body: taskBodyFor({ row }) });
  const result = await driveAuditRow({
    row,
    lifecycle,
    probes: gamingProbesFor(row),
    rails: createRealAccountingRails(),
    metadata: metadataOf(clock.now().toISOString()),
    environmentIdentity: `val-049-unit-${row.rowId}`,
    baseline,
    worldFacts: ledger.facts,
    landedProvider: async () => [submission.executionId],
    now: clock.now,
  });
  return { result, lifecycle, ledger };
}

// ---------------------------------------------------------------------------
// The pinned vocabulary
// ---------------------------------------------------------------------------

describe("VAL-049 audit vocabulary (the pinned policies)", () => {
  test("the gaming-vector vocabulary is complete (all ten, no duplicates)", () => {
    expect(GAMING_VECTORS).toHaveLength(10);
    expect(new Set(GAMING_VECTORS).size).toBe(10);
    for (const vector of GAMING_VECTORS) {
      expect(GAMING_MECHANISM_OF[vector].length).toBeGreaterThan(10);
    }
  });

  test("the cross-vector combinations are declared (the three pinned pairs)", () => {
    expect(CROSS_VECTOR_COMBINATIONS).toHaveLength(3);
    for (const combination of CROSS_VECTOR_COMBINATIONS) {
      expect(combination.length).toBe(2);
      expect(new Set(combination).size).toBe(2);
    }
    // The corpus carries every combination as a row.
    const combinationRows = OFFLINE_CORPUS_ROWS.filter((row) => row.combinedVectors !== undefined);
    expect(combinationRows.map((row) => row.combinedVectors?.join("+"))).toEqual(
      CROSS_VECTOR_COMBINATIONS.map((combination) => combination.join("+")),
    );
  });

  test("the audit verdict vocabulary is the declared four plus the refused audit row", () => {
    const verdicts = new Set(OFFLINE_CORPUS_ROWS.map((row) => row.expected.verdict));
    expect(verdicts).toContain("REPRODUCIBLE-VERIFIED");
    expect(verdicts).toContain("BOUNDS-HELD");
    expect(verdicts).toContain("GAMING-DETECTED");
    expect(verdicts).toContain("NOT-AUDITABLE");
    expect(verdicts).toContain("adversarial-failed");
    // GAMING-DETECTED rows carry the NAMED mechanism; NOT-AUDITABLE rows the NAMED reason.
    for (const row of OFFLINE_CORPUS_ROWS) {
      if (row.expected.verdict === "GAMING-DETECTED") {
        expect(row.expected.mechanism, row.rowId).toBeDefined();
      }
      if (row.expected.verdict === "NOT-AUDITABLE") {
        expect(row.expected.reason, row.rowId).toBeDefined();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The replay bit-stability pins
// ---------------------------------------------------------------------------

describe("VAL-049 replay bit-stability (the reproducibility arm)", () => {
  test("every honest row's recorded evidence re-derives bit-stable", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const replays = replaysOf(row);
      const stability = deriveReplayBitStability({
        row,
        replays,
        rederivationsExecuted: replays.length,
      });
      expect(stability.conformant, `${row.rowId}: ${JSON.stringify(stability.evidence)}`).toBe(
        true,
      );
    }
  });

  test("the replay is deterministic (double derivation, identical digests)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const first = replaysOf(row);
    const second = replaysOf(row);
    expect(first.map((replay) => replay.recomputedDigest)).toEqual(
      second.map((replay) => replay.recomputedDigest),
    );
    expect(first.map((replay) => replay.replayedVerdict)).toEqual(
      second.map((replay) => replay.replayedVerdict),
    );
  });

  test("a FLIPPED digest on replay FAILs named", () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const flipped: AuditedEvidenceReference = {
      ...reference,
      recordedDigest: "deadbeef",
    };
    const mutated: AuditCorpusRow = { ...row, evidence: [flipped, ...row.evidence.slice(1)] };
    const stability = deriveReplayBitStability({
      row: mutated,
      replays: replaysOf(mutated),
      rederivationsExecuted: mutated.evidence.length,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("digest-disagreement");
    expect(stability.evidence.join(" ")).toContain(reference.corpusRowId);
  });

  test("a FLIPPED verdict on replay FAILs named (the flipped-verdict discrimination)", () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const flipped: AuditedEvidenceReference = {
      ...reference,
      recordedVerdict: "a-verdict-that-never-recorded",
    };
    const mutated: AuditCorpusRow = { ...row, evidence: [flipped, ...row.evidence.slice(1)] };
    const stability = deriveReplayBitStability({
      row: mutated,
      replays: replaysOf(mutated),
      rederivationsExecuted: mutated.evidence.length,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("verdict-flipped-on-replay");
  });

  test("an honest divergence record WITH cause is permitted (recorded, never a FAIL)", () => {
    const row = rowById("replay-declared-divergence-recorded");
    const replays = replaysOf(row);
    expect(replays[0]?.divergenceDetected).toBe(true);
    const stability = deriveReplayBitStability({
      row,
      replays,
      rederivationsExecuted: replays.length,
    });
    expect(stability.conformant).toBe(true);
    expect(stability.divergences.length).toBe(1);
    expect(stability.evidence.join(" ")).toContain("divergence-recorded");
  });

  test("an UNDECLARED divergence FAILs named (the silent-divergence discrimination)", () => {
    const row = rowById("replay-declared-divergence-recorded");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const silent: AuditedEvidenceReference = {
      workOrder: reference.workOrder,
      corpusRowId: reference.corpusRowId,
      recordedDigest: reference.recordedDigest,
      recordedVerdict: reference.recordedVerdict,
    };
    const mutated: AuditCorpusRow = { ...row, evidence: [silent] };
    const stability = deriveReplayBitStability({
      row: mutated,
      replays: replaysOf(mutated),
      rederivationsExecuted: 1,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("undeclared-divergence");
  });

  test("an unresolvable reference FAILs named (the input-integrity discrimination)", () => {
    const row = rowById("replay-substrate-window-facts");
    const reference = row.evidence[0];
    if (reference === undefined) {
      throw new Error("unreachable");
    }
    const unresolvable: AuditedEvidenceReference = {
      workOrder: reference.workOrder,
      corpusRowId: "no-such-recorded-row",
      recordedDigest: "00000000",
      recordedVerdict: "none",
    };
    const mutated: AuditCorpusRow = { ...row, evidence: [unresolvable] };
    const replay = replayRecordedEvidenceOf(unresolvable);
    expect(replay.resolvable).toBe(false);
    const stability = deriveReplayBitStability({
      row: mutated,
      replays: [replay],
      rederivationsExecuted: 1,
    });
    expect(stability.conformant).toBe(false);
    expect(stability.evidence.join(" ")).toContain("unresolvable");
  });

  test("the recorded controls replay through the final machinery's own extractor", () => {
    const row = rowById("replay-controls-recorded-arms");
    const directRef = row.evidence.find(
      (reference) =>
        reference.workOrder === "VAL-041" &&
        reference.corpusRowId === "fixed-quality-direct-default-rail",
    );
    expect(directRef).toBeDefined();
    const replay = replayRecordedEvidenceOf(directRef ?? row.evidence[0]!);
    expect(replay.resolvable).toBe(true);
    expect(replay.referenceDigest).toBe(replay.recomputedDigest);
    expect(replay.replayedVerdict).toMatch(/^arm-economics:/);
  });
});

// ---------------------------------------------------------------------------
// The audit-integrity oracles (the verification core's adversarial probes)
// ---------------------------------------------------------------------------

describe("VAL-049 rubber-stamp detection (the re-derivation must execute)", () => {
  test("every honest row's re-derivation actually executes", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const replays = replaysOf(row);
      const oracle = deriveRubberStampDetection({
        row,
        rederivationsExecuted: replays.length,
      });
      expect(oracle.conformant, row.rowId).toBe(true);
    }
  });

  test("the rubber-stamp confession FAILs named", () => {
    const row = rowById("probe-audit-rubber-stamp");
    const oracle = deriveRubberStampDetection({ row, rederivationsExecuted: row.evidence.length });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("RUBBER STAMP");
  });

  test("a zero re-derivation trace FAILs even without the confession", () => {
    const row = rowById("replay-adjusted-cost-verdicts");
    const oracle = deriveRubberStampDetection({ row, rederivationsExecuted: 0 });
    expect(oracle.conformant).toBe(false);
  });
});

describe("VAL-049 favorable-subset sampling (the omitted rows NAMED)", () => {
  test("the honest reproducibility rows declare the complete scope", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.arm === "REPRODUCIBILITY" && candidate.adversarial === undefined,
    )) {
      const oracle = deriveFavorableSubsetSampling({ row });
      expect(oracle.conformant, `${row.rowId}: ${oracle.evidence.join(" ")}`).toBe(true);
      expect(oracle.omitted).toEqual([]);
    }
  });

  test("the favorable-subset probe FAILs with the omitted rows NAMED", () => {
    const row = rowById("probe-audit-favorable-subset");
    const oracle = deriveFavorableSubsetSampling({ row });
    expect(oracle.conformant).toBe(false);
    expect(oracle.omitted.length).toBeGreaterThanOrEqual(6);
    for (const omitted of oracle.omitted) {
      expect(oracle.evidence.join(" ")).toContain(omitted);
    }
  });

  test("each scope-level gaming vector's dishonest scope is caught with the rows named", () => {
    for (const vector of ["post-hoc-exclusion", "window-cherry-picking", "silent-drops"] as const) {
      const omitted = dishonestScopeOmittedRowsOf(vector);
      expect(omitted.length, vector).toBeGreaterThan(0);
      const probe = singleGamingProbeOf(vector);
      expect(probe.caught, vector).toBe(true);
      expect(probe.omittedRows ?? [], vector).toEqual(omitted);
    }
  });
});

describe("VAL-049 verdict grounding (every verdict cites its evidence digest)", () => {
  test("every honest grounded row's verdict cites its evidence digest", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) =>
        candidate.adversarial === undefined && candidate.expected.verdict !== "NOT-AUDITABLE",
    )) {
      const oracle = deriveVerdictGrounding({ row, replays: replaysOf(row) });
      expect(oracle.conformant, `${row.rowId}: ${oracle.evidence.join(" ")}`).toBe(true);
    }
  });

  test("the NOT-AUDITABLE rows ground on their declared reason", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.expected.verdict === "NOT-AUDITABLE",
    )) {
      const oracle = deriveVerdictGrounding({ row, replays: replaysOf(row) });
      expect(oracle.conformant, row.rowId).toBe(true);
    }
  });

  test("an UNGROUNDED verdict FAILs named (the grounding discrimination)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const mutated: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, groundedOn: undefined },
    };
    const oracle = deriveVerdictGrounding({ row: mutated, replays: replaysOf(mutated) });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("UNGROUNDED");
  });

  test("a verdict citing a digest that disagrees with the evidence used FAILs named", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const mutated: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, groundedOn: "deadbeef" },
    };
    const oracle = deriveVerdictGrounding({ row: mutated, replays: replaysOf(mutated) });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("UNGROUNDED");
  });
});

describe("VAL-049 resolution honesty (the finding disposition)", () => {
  test("the accepted-risk record passes (the honest disposition)", () => {
    const row = rowById("probe-finding-accepted-risk-recorded");
    const oracle = deriveResolutionHonesty({ row });
    expect(oracle.conformant).toBe(true);
    expect(oracle.evidence.join(" ")).toContain("accepted-risk");
  });

  test("the unresolved-finding probe FAILs named", () => {
    const row = rowById("probe-audit-unresolved-finding");
    const oracle = deriveResolutionHonesty({ row });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("UNRESOLVED-FINDING");
  });

  test("an open finding passes (honestly unresolved)", () => {
    const row = rowById("probe-finding-accepted-risk-recorded");
    const mutated: AuditCorpusRow = {
      ...row,
      findingResolution: { status: "open" },
    };
    const oracle = deriveResolutionHonesty({ row: mutated });
    expect(oracle.conformant).toBe(true);
  });
});

describe("VAL-049 bounds-held checking (the measured vs the recorded bounds)", () => {
  test("the offline bounds floor holds (the recorded rate inside the recorded Wilson interval)", () => {
    const row = rowById("bounds-recorded-confidence-offline");
    const oracle = deriveBoundsHeld({ row });
    expect(oracle.conformant).toBe(true);
    expect(oracle.evidence.join(" ")).toContain("held");
  });

  test("the off-bounds probe FAILs named (the value and the violated bound)", () => {
    const row = rowById("probe-audit-off-bounds");
    const oracle = deriveBoundsHeld({ row });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("OFF-BOUNDS");
    expect(oracle.evidence.join(" ")).toContain("0.500000");
    expect(row.claimed?.boundsClaim?.measuredRate).toBe(0.5);
  });

  test("an out-of-bounds honest declaration FAILs (the machinery exists)", () => {
    const row = rowById("bounds-recorded-confidence-offline");
    const mutated: AuditCorpusRow = {
      ...row,
      boundsDeclaration: { ...row.boundsDeclaration!, measuredRate: 0.5 },
    };
    const oracle = deriveBoundsHeld({ row: mutated });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("OFF-BOUNDS");
    expect(oracle.evidence.join(" ")).toContain("violates the recorded bounds");
  });
});

// ---------------------------------------------------------------------------
// The gaming-probe completeness matrix (every vector + the combinations)
// ---------------------------------------------------------------------------

describe("VAL-049 gaming-probe completeness (every vector + cross-vector combinations)", () => {
  test("every one of the ten vectors is probed AND caught with the mechanism NAMED", () => {
    for (const vector of GAMING_VECTORS) {
      const probe = singleGamingProbeOf(vector);
      expect(probe.caught, vector).toBe(true);
      expect(probe.mechanisms, vector).toEqual([GAMING_MECHANISM_OF[vector]]);
    }
    // Every vector carries its own canonical corpus row (the
    // probe-vector-* rows; the audit-integrity probes that ride a gaming
    // variant as substrate do not inflate the vector inventory).
    const vectorRows = OFFLINE_CORPUS_ROWS.filter((row) => row.rowId.startsWith("probe-vector-"));
    expect(vectorRows.map((row) => row.gamingVectors?.[0])).toEqual([...GAMING_VECTORS]);
  });

  test("every cross-vector combination is caught with BOTH mechanisms named", () => {
    for (const combination of CROSS_VECTOR_COMBINATIONS) {
      const probe = combinationGamingProbeOf(combination);
      expect(probe.caught, combination.join("+")).toBe(true);
      expect(probe.vectors, combination.join("+")).toEqual([...combination]);
      for (const vector of combination) {
        expect(probe.mechanisms, `${combination.join("+")}/${vector}`).toContain(
          GAMING_MECHANISM_OF[vector],
        );
      }
    }
  });

  test("a combination row that passes each probe in isolation still games the combination FAILs (the missing-probe discrimination)", () => {
    const row = rowById("probe-combination-quality-inflation-latency-omission");
    // Only the SINGLE probes supplied — the combination probe missing.
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [singleGamingProbeOf("quality-inflation"), singleGamingProbeOf("latency-omission")],
    });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("combination-not-probed");
  });

  test("an uncaught vector FAILs named (the undetected-gaming discrimination)", () => {
    const row = rowById("probe-vector-quality-inflation");
    const oracle = deriveGamingProbeCompleteness({
      row,
      probes: [
        {
          vectors: ["quality-inflation"],
          caught: false,
          mechanisms: [],
          evidence: ["NOT CAUGHT (the machinery missed the gaming attempt)"],
        },
      ],
    });
    expect(oracle.conformant).toBe(false);
    expect(oracle.evidence.join(" ")).toContain("vector-not-caught");
  });

  test("the full probe set over every anti-gaming row is complete", () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter((row) => row.arm === "ANTI-GAMING")) {
      const oracle = deriveGamingProbeCompleteness({ row, probes: gamingProbesFor(row) });
      expect(oracle.conformant, `${row.rowId}: ${oracle.evidence.join(" ")}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The digest discipline
// ---------------------------------------------------------------------------

describe("VAL-049 the digest discipline", () => {
  test("the evidence digests are deterministic and discriminating (8-hex)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const references = row.evidence.slice(0, 2);
    const first = auditEvidenceDigestOf(references);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(auditEvidenceDigestOf(references)).toBe(first);
    // A mutated digest discriminates.
    const mutated: AuditedEvidenceReference = {
      ...references[0]!,
      recordedDigest: "deadbeef",
    };
    expect(auditEvidenceDigestOf([mutated, references[1]!])).not.toBe(first);
  });

  test("the corpus input digest is deterministic + discriminating", () => {
    expect(pinnedAuditInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedAuditInputDigest()).toBe(pinnedAuditInputDigest());
  });

  test("the live plan digest is deterministic (the declaration reference)", () => {
    expect(liveAuditPlanDigestOf()).toMatch(/^[0-9a-f]{8}$/);
    expect(liveAuditPlanDigestOf()).toBe(liveAuditPlanDigestOf());
    expect(LIVE_AUDIT_PLAN.rounds).toBe(4);
    expect(LIVE_AUDIT_PLAN.rail.model).toBe("meta-llama/llama-3.3-70b-instruct");
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest outcome contract)
// ---------------------------------------------------------------------------

describe("VAL-049 the driver over every offline row (the honest outcome contract)", () => {
  /** Each adversarial audit-probe row's NAMED criterion (the honest failure). */
  const probeNamedCriterion: Readonly<Record<string, string>> = {
    "probe-audit-rubber-stamp": "rubber-stamp-detection",
    "probe-audit-favorable-subset": "favorable-subset-sampling",
    "probe-audit-off-bounds": "bounds-held",
    "probe-audit-unresolved-finding": "resolution-honesty",
  };

  test("every honest control row COMPLETES reproducing the pinned audit verdicts", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial === undefined,
    )) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal, row.rowId).toBe("COMPLETED");
      expect(result.failure, row.rowId).toBeNull();
      expect(result.notRun, row.rowId).toBe(false);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(result.observedTerminal, row.rowId).toBe("COMPLETED");
      expect(result.auditVerdict.verdict, row.rowId).toBe(row.expected.verdict);
      expect(result.auditVerdict.mechanism ?? "none", row.rowId).toBe(
        row.expected.mechanism ?? "none",
      );
      expect(result.auditVerdict.reason ?? "none", row.rowId).toBe(row.expected.reason ?? "none");
      // The re-derivation executed (never a rubber stamp).
      expect(result.replays, row.rowId).toHaveLength(row.evidence.length);
    }
  });

  test("every adversarial audit-probe row FAILs its NAMED criterion honestly", async () => {
    for (const row of OFFLINE_CORPUS_ROWS.filter(
      (candidate) => candidate.adversarial !== undefined,
    )) {
      const { result } = await driveRowOverHonestStack(row);
      expect(result.terminal, row.rowId).toBe("FAILED");
      expect(result.observedTerminal, row.rowId).toBe("FAILED");
      const named = probeNamedCriterion[row.rowId];
      expect(named, row.rowId).toBeDefined();
      const criterion = criterionOf(result, named);
      expect(criterion?.status, `${row.rowId} ${named}`).toBe("FAIL");
      expect(criterionOf(result, "observed-terminal-readback")?.status).toBe("PASS");
    }
  });
});

// ---------------------------------------------------------------------------
// The live lane declaration honesty
// ---------------------------------------------------------------------------

describe("VAL-049 the live lane declaration", () => {
  test("the live row is env-gated on the operator credential (honest NOT RUN offline)", async () => {
    const row = rowById("live-audit-real-rerun-slice");
    expect(row.needsDispatch).toBe(true);
    expect(row.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveGateOpen(row, {})).toBe(false);
    expect(auditLiveGateOpen(row, { OPENROUTER_API_KEY: "x" })).toBe(true);
    // With the gate closed the driver returns the honest NOT RUN marker.
    const clock = createTickClock();
    const ledger = createFakeLedger(clock);
    const lifecycle = createFakeLifecycle({ ledger });
    const result = await driveAuditRow({
      row,
      lifecycle,
      probes: [],
      rails: createRealAccountingRails(),
      metadata: metadataOf(clock.now().toISOString()),
      environmentIdentity: "val-049-unit-live",
      baseline: ledger.facts(),
      worldFacts: ledger.facts,
      landedProvider: async () => ["exec-live"],
      now: clock.now,
      env: {},
    });
    expect(result.notRun).toBe(true);
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.map((criterion) => criterion.criterionId)).toEqual([
      "live-gate-honesty",
    ]);
    expect(result.criteria[0]?.evidence.join(" ")).toContain("NOT RUN");
  });

  test("the audited scope of every work order resolves through the imported corpora", () => {
    for (const workOrder of [
      "VAL-041",
      "VAL-042",
      "VAL-043",
      "VAL-044",
      "VAL-045",
      "VAL-046",
      "VAL-047",
      "VAL-048",
    ] as const) {
      const ids = offlineRowIdsOf(workOrder);
      expect(ids.length, workOrder).toBeGreaterThan(0);
      for (const rowId of ids) {
        const replay = replayRecordedEvidenceOf({ workOrder, corpusRowId: rowId });
        expect(replay.resolvable, `${workOrder}:${rowId}`).toBe(true);
      }
    }
  });

  test("the audit criteria composition refuses a fabricated audit row (the outcome oracle)", () => {
    const row = rowById("replay-cross-workload-verdicts");
    const mutated: AuditCorpusRow = {
      ...row,
      expected: { ...row.expected, verdict: "BOUNDS-HELD" },
    };
    const criteria = deriveAuditRowCriteria({
      row: mutated,
      replays: replaysOf(mutated),
      probes: [],
      rederivationsExecuted: mutated.evidence.length,
      observedTerminal: null,
      baseline: {
        executionCount: 0,
        eventCount: 0,
        idempotencyRecordCount: 0,
        orphanEventCount: 0,
      },
      finalFacts: {
        executionCount: 1,
        eventCount: 1,
        idempotencyRecordCount: 1,
        orphanEventCount: 0,
      },
      failure: null,
      totalLatencyMs: 0,
    });
    expect(criterionOf({ criteria }, "audit-outcome-oracle")?.status).toBe("FAIL");
    // The honest row derives its own verdict mechanically.
    const verdict = deriveAuditVerdict({ row, replays: replaysOf(row), probes: [] });
    expect(verdict.verdict).toBe("REPRODUCIBLE-VERIFIED");
  });
});

// ---------------------------------------------------------------------------
// The gaming-vector type guard (the pinned vocabulary's compile-time floor)
// ---------------------------------------------------------------------------

void (() => {
  const vector: GamingVector = "quality-inflation";
  return GAMING_MECHANISM_OF[vector];
})();
