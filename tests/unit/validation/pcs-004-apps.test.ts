/**
 * PCS-004 acceptance tests (the app boundary): the evaluation over the
 * real committed corpus and artifacts — the complete run, the hard
 * gate against the REAL planner gate, the discriminator's coverage,
 * the committed results' consistency (recompute → identical digest)
 * and the committed threshold report's honest labels + quoted era
 * records.
 *
 *   * the complete evaluation runs in-process (hermetic — pure
 *     functions of the committed corpus; no network, no clock in the
 *     digested content);
 *   * every negative-control record's fail-closed verdict is re-proven
 *     against the REAL `applySemanticQualityGating` (the local
 *     projection's verdict is never trusted on its own — the
 *     fabricated-pass-unrepresentable discipline);
 *   * the discriminator separates both kinds on every record of the
 *     COMMITTED artifact (not just the fresh run);
 *   * the committed evaluation-aggregate.json is EXACTLY what the
 *     current corpus produces (digest equality — the deterministic
 *     replay identity makes the committed evidence a live claim);
 *   * the committed threshold-report.md carries the honest labels on
 *     every number, the declared thresholds' verdicts, the quoted era
 *     limitation VERBATIM (the no-relabeling law) and the
 *     reproducibility line.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runSemanticFidelityEvaluation } from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/application";
import {
  ALL_CONTROLS,
  HARD_GATE_CONTROLS,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/controls";
import {
  pinnedEvaluationCorpusDigest,
  THRESHOLDS,
} from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/corpus";
import { discriminateRepresentation } from "../../../benchmarks/validation/apps/semantic-fidelity-evaluation/fidelity";
import {
  applySemanticQualityGating,
  buildPlan,
  classifySemanticQualityContract,
} from "../../../src/modules/planning/public";
import { canonicalJson as platformCanonicalJson } from "../../../src/platform/execution-ir/canonical";

const APP_ROOT = join(process.cwd(), "benchmarks/validation/apps/semantic-fidelity-evaluation");
const RESULTS_ROOT = join(APP_ROOT, "results");

/** The committed evaluation aggregate (read once per suite). */
function readCommittedAggregate(): {
  corpusDigest: string;
  digest: string;
  aggregate: {
    verdicts: Record<string, { verdict: string; attribution?: string }>;
    controls: {
      hardGateTotal: number;
      hardGateFailedClosedWithTypedReason: number;
      hardGateAdmitted: number;
    };
    replay: { lines: number; eraTargetRankedFirst: number; gatedFailClosed: number };
    discrimination: {
      recordsWithRepresentations: number;
      separated: number;
      semanticModelBacked: number;
      deterministicSubstitute: number;
      rejected: number;
    };
  };
  records: {
    fixtureRecords: {
      recordId: string;
      arm: string;
      representation: unknown;
      retrieval: { top1Id: string; groundTruthId: string; resolved: boolean };
    }[];
    controlRecords: {
      recordId: string;
      kind: string;
      controlTaskId: string;
      representations: unknown[];
      gate: { verdict: string; reason?: string; unchanged?: boolean };
    }[];
    replayRecords: {
      recordId: string;
      lineId: string;
      eraQuoted: { limitation: { area: string; statement: string; owner: string } };
      absentArm: { retrieval: { resolved: boolean }; representation: unknown };
      gatedArm: { gate: { verdict: string; reason?: string } };
    }[];
  };
  reproducibility: {
    runDigest: string;
    reRunDigest: string | null;
    reRunIdentical: boolean | null;
  };
} {
  return JSON.parse(readFileSync(join(RESULTS_ROOT, "evaluation-aggregate.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// The complete evaluation (hermetic, in-process)
// ---------------------------------------------------------------------------

describe("PCS-004 the app boundary (the evaluation over the committed corpus)", () => {
  test("the complete evaluation runs and every derived verdict is met", () => {
    const run = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    expect(run.corpusDigest).toBe(pinnedEvaluationCorpusDigest());
    for (const key of [
      "t1aSemanticTop1PerGroup",
      "t1bSubstituteStrictlyBelowPerGroup",
      "t2HardGateFailClosed",
      "t3DiscriminatorCoverage",
      "t4ReplayLinesAllHold",
    ]) {
      expect(run.result.aggregate.verdicts[key]?.verdict).toBe("met");
    }
    // The wall-clock is excluded from the digest: a different clock
    // produces the byte-identical digest (the deterministic replay
    // discipline — wall-clock and run identities excluded).
    const other = runSemanticFidelityEvaluation({ now: () => "a-different-clock" });
    expect(other.result.digest).toBe(run.result.digest);
  });

  test("the fixture census: the substitute resolves NOTHING, the semantic arm resolves EVERYTHING", () => {
    const run = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    const substituteRecords = run.result.fixtureRecords.filter(
      (record) => record.arm === "deterministic-substitute",
    );
    const semanticRecords = run.result.fixtureRecords.filter(
      (record) => record.arm === "synthetic-semantic-supply",
    );
    expect(substituteRecords).toHaveLength(18);
    expect(semanticRecords).toHaveLength(18);
    expect(substituteRecords.every((record) => !record.retrieval.resolved)).toBe(true);
    expect(semanticRecords.every((record) => record.retrieval.resolved)).toBe(true);
    for (const record of substituteRecords) {
      expect(record.retrieval.top1Id).not.toBe(record.retrieval.groundTruthId);
    }
    for (const record of semanticRecords) {
      expect(record.retrieval.top1Id).toBe(record.retrieval.groundTruthId);
    }
  });

  test("EVERY hard-gate control record fails closed with the typed reason — re-proven against the REAL planner gate", () => {
    const run = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    const hardGateRecords = run.result.controlRecords.filter(
      (record) => record.kind === "hard-gate",
    );
    expect(hardGateRecords).toHaveLength(HARD_GATE_CONTROLS.length);
    for (const record of hardGateRecords) {
      expect(record.gate.verdict, record.controlTaskId).toBe("inadmissible");
      expect(record.gate.reason, record.controlTaskId).toBe(
        "semantic-quality-contract-forbids-substitute",
      );
      expect(record.gate.unchanged, record.controlTaskId).toBeUndefined();
      // The REAL gate over the same control produces the same verdict.
      const control = ALL_CONTROLS.find(
        (candidate) => candidate.controlTaskId === record.controlTaskId,
      );
      expect(control).toBeDefined();
      if (control === undefined) {
        continue;
      }
      const realCandidate = {
        strategyId: control.candidate.strategyId,
        plan: buildPlan(
          {
            revision: 1,
            strategyClass: "deterministic-only",
            steps: control.candidate.planSteps.map((step, index) => ({
              id: step.stepId === "" ? `step-${index}` : step.stepId,
              stepClass: "run-algorithm",
              ...(step.capabilityId === undefined ? {} : { capabilityId: step.capabilityId }),
            })),
            edges: control.candidate.planSteps.slice(1).map((_, index) => ({
              from: control.candidate.planSteps[index]?.stepId ?? "s0",
              to: control.candidate.planSteps[index + 1]?.stepId ?? "s1",
            })),
          },
          (value: unknown) =>
            createHash("sha256").update(platformCanonicalJson(value), "utf8").digest("hex"),
        ),
        expectedCostMicroUsd: "5",
        expectedQuality: 0.9,
        expectedLatencyMs: 10,
        verificationStrategy: "retrieval-recall-check",
        routeRationale: { code: "deterministic-sufficient" as const, detail: "pcs-004" },
        modelCalls: 0,
        admissible: control.candidate.admissible,
        ...(control.candidate.inadmissibleReason === undefined
          ? {}
          : {
              inadmissibleReason: control.candidate.inadmissibleReason as "policy-forbidden-route",
            }),
      };
      const real = applySemanticQualityGating(realCandidate, {
        contract: classifySemanticQualityContract(control.contract) as ReturnType<
          typeof classifySemanticQualityContract
        >,
        representations: control.representations as never,
      });
      expect(
        real.admissible,
        `${record.controlTaskId}: the REAL gate admitted a hard-gate control`,
      ).toBe(false);
      expect(real.inadmissibleReason).toBe("semantic-quality-contract-forbids-substitute");
    }
  });

  test("the discriminating controls: the gate's precision holds on every matrix member", () => {
    const run = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    const discriminating = run.result.controlRecords.filter(
      (record) => record.kind === "discriminating",
    );
    expect(discriminating).toHaveLength(8);
    for (const record of discriminating) {
      const control = ALL_CONTROLS.find(
        (candidate) => candidate.controlTaskId === record.controlTaskId,
      );
      expect(control).toBeDefined();
      if (control === undefined) {
        continue;
      }
      if (control.expected.admissible) {
        expect(record.gate.verdict, record.controlTaskId).toBe("admissible");
      } else {
        expect(record.gate.verdict, record.controlTaskId).toBe("inadmissible");
        expect(record.gate.reason, record.controlTaskId).toBe(control.expected.reason);
        expect(record.gate.unchanged ?? false, record.controlTaskId).toBe(
          control.expected.unchanged ?? false,
        );
      }
    }
  });

  test("the discriminator separates both kinds on EVERY emitted record of the run", () => {
    const run = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    const kinds = { semantic: 0, deterministic: 0, rejected: 0 };
    for (const record of run.result.fixtureRecords) {
      const verdict = discriminateRepresentation(record.representation);
      if (verdict.kind === "separated") {
        kinds[
          verdict.representationKind === "semantic-model-backed" ? "semantic" : "deterministic"
        ] += 1;
      } else {
        kinds.rejected += 1;
      }
    }
    for (const record of run.result.controlRecords) {
      for (const facts of record.representations) {
        const verdict = discriminateRepresentation(facts);
        expect(verdict.kind).toBe("separated");
        if (verdict.kind === "separated") {
          kinds[
            verdict.representationKind === "semantic-model-backed" ? "semantic" : "deterministic"
          ] += 1;
        }
      }
    }
    for (const record of run.result.replayRecords) {
      const verdict = discriminateRepresentation(record.absentArm.representation);
      expect(verdict.kind).toBe("separated");
    }
    expect(kinds.rejected).toBe(0);
    expect(kinds.semantic).toBeGreaterThan(0);
    expect(kinds.deterministic).toBeGreaterThan(0);
  });

  test("the replay records: era target retrieved + gated arm fail-closed + era limitation quoted VERBATIM", () => {
    const run = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    for (const record of run.result.replayRecords) {
      expect(record.absentArm.retrieval.resolved, record.lineId).toBe(true);
      expect(record.gatedArm.gate.verdict, record.lineId).toBe("inadmissible");
      if (record.gatedArm.gate.verdict !== "inadmissible") {
        throw new Error(`${record.lineId}: the gated arm did not fail closed`);
      }
      expect(record.gatedArm.gate.reason, record.lineId).toBe(
        "semantic-quality-contract-forbids-substitute",
      );
      expect(record.gatedArm.vectorProducedForTaskSatisfaction).toBe(false);
      // The era limitation is quoted with its owner and area — never relabeled.
      expect(record.eraQuoted.limitation.area).toBe("embeddings execution representation");
      expect(record.eraQuoted.limitation.owner).toBe("Lead");
      expect(record.eraQuoted.limitation.statement).toContain(
        "DETERMINISTIC lexical-hash strategy",
      );
      // The disclosure of the gated arm says what remains unavailable.
      const statuses = record.gatedArm.disclosure.map((entry) => entry.status);
      expect(statuses, record.lineId).toContain("unmet-no-admissible-semantic-representation");
      // The absent arm's disclosure says met-by-deterministic-substitute.
      const absentStatuses = record.absentArm.disclosure.map((entry) => entry.status);
      expect(absentStatuses, record.lineId).toContain("met-by-deterministic-substitute");
      expect(record.absentArm.substitutionFact?.substitutions[0]?.representationKind).toBe(
        "deterministic-substitute",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The committed artifacts (the durable evidence)
// ---------------------------------------------------------------------------

describe("PCS-004 the committed artifacts (results/)", () => {
  test("the committed evaluation-aggregate.json is EXACTLY what the current corpus produces (digest equality)", () => {
    const committed = readCommittedAggregate();
    const fresh = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    expect(committed.corpusDigest).toBe(pinnedEvaluationCorpusDigest());
    expect(committed.digest).toBe(fresh.result.digest);
    expect(committed.reproducibility.reRunIdentical).toBe(true);
    expect(committed.reproducibility.reRunDigest).toBe(committed.digest);
  });

  test("the committed aggregate's counts and verdicts match the fresh run", () => {
    const committed = readCommittedAggregate();
    const fresh = runSemanticFidelityEvaluation({ now: () => "hermetic-clock" });
    expect(committed.aggregate.controls).toEqual({
      hardGateTotal: 6,
      hardGateFailedClosedWithTypedReason: 6,
      hardGateAdmitted: 0,
      discriminatingTotal: 8,
      discriminatingAsExpected: 8,
    });
    expect(committed.aggregate.replay).toEqual({
      lines: 3,
      eraTargetRankedFirst: 3,
      gatedFailClosed: 3,
    });
    expect(committed.aggregate.discrimination.separated).toBe(
      committed.aggregate.discrimination.recordsWithRepresentations,
    );
    expect(committed.aggregate.discrimination.rejected).toBe(0);
    expect(committed.aggregate.discrimination.semanticModelBacked).toBeGreaterThan(0);
    expect(committed.aggregate.discrimination.deterministicSubstitute).toBeGreaterThan(0);
    for (const [key, verdict] of Object.entries(fresh.result.aggregate.verdicts)) {
      expect(committed.aggregate.verdicts[key]?.verdict, key).toBe(verdict.verdict);
    }
  });

  test("the committed records: every representation record is separated by the discriminator (both kinds present)", () => {
    const committed = readCommittedAggregate();
    const kinds = new Set<string>();
    let separated = 0;
    let total = 0;
    for (const facts of [
      ...committed.records.fixtureRecords.map((record) => record.representation),
      ...committed.records.controlRecords.flatMap((record) => record.representations),
      ...committed.records.replayRecords.map((record) => record.absentArm.representation),
    ]) {
      total += 1;
      const verdict = discriminateRepresentation(facts);
      expect(verdict.kind).toBe("separated");
      if (verdict.kind === "separated") {
        kinds.add(verdict.representationKind);
        separated += 1;
      }
    }
    expect(separated).toBe(total);
    expect(kinds).toEqual(new Set(["semantic-model-backed", "deterministic-substitute"]));
  });

  test("the committed threshold-report.md carries the honest labels, the declared thresholds' verdicts, the quoted era limitation and the reproducibility proof", () => {
    const report = readFileSync(join(RESULTS_ROOT, "threshold-report.md"), "utf8");
    // The honest labels on every number.
    expect(report).toContain("synthetic-supply");
    expect(report).toContain("synthetic-semantic-supply");
    expect(report).toContain("never a live model measurement");
    expect(report).toContain("live/credentialed validation is the operator-era obligation");
    // The declared-vs-measured table + all five verdict lines.
    expect(report).toContain("## T1 — The quality fixtures");
    expect(report).toContain("## T2 — The negative controls (the hard gate)");
    expect(report).toContain("## T3 — The differentiated evidence (the mechanical discriminator)");
    expect(report).toContain("## T4 — The replay of the PPR-025/PPR-026 embeddings lines");
    expect(report).toContain("## T5 — Reproducibility");
    expect(report.match(/verdict: \*\*MET\*\*/g)?.length).toBeGreaterThanOrEqual(5);
    expect(report).not.toContain("verdict: **MISSED**");
    expect(report).not.toContain("DELIVERY-BLOCKING");
    // The quoted era limitation — verbatim from the committed record.
    const ppr025 = JSON.parse(
      readFileSync(join(process.cwd(), "deploy/evidence/ppr-025.json"), "utf8"),
    ) as {
      evidenceRecord: { limitations: { area: string; statement: string; owner: string }[] };
    };
    const limitation = ppr025.evidenceRecord.limitations.find(
      (entry) => entry.area === "embeddings execution representation",
    );
    expect(limitation).toBeDefined();
    expect(report).toContain(String(limitation?.statement));
    expect(report).toContain("never relabeled");
    // The digests + the reproducibility line.
    expect(report).toContain(pinnedEvaluationCorpusDigest());
    expect(report).toContain(
      "IDENTICAL (the re-run reproduced the evaluation digest byte-for-byte)",
    );
    // The declared thresholds' spellings (never post-hoc).
    expect(report).toContain("100% of every group");
    expect(report).toContain("strictly below");
  });

  test("the README first line carries the TRUE work-order tag (the PCS-001 vocabulary resolves it)", () => {
    const readme = readFileSync(join(APP_ROOT, "README.md"), "utf8");
    const firstLine = readme.split("\n", 1)[0] ?? "";
    expect(firstLine).toBe("# semantic-fidelity-evaluation (PCS-004)");
  });

  test("the config's thresholds are the corpus's declared thresholds (declared BEFORE the run)", () => {
    const config = JSON.parse(readFileSync(join(APP_ROOT, "config.json"), "utf8")) as {
      evaluation: { thresholds: Record<string, unknown> };
    };
    expect(config.evaluation.thresholds).toEqual(THRESHOLDS as unknown as Record<string, unknown>);
  });
});
