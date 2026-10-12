/**
 * PCR-003 acceptance tests (the app boundary): the three-arm replay
 * evaluation over the REAL composed stack — the hermetic cell's three
 * arms running FRESH in one process, the mediated-with-plan arm's
 * composed ladder verified against the real wired seam, the per-attempt
 * evidence verified against the transport's own pure draw functions and
 * against the fixture's independent draw projection, the
 * determinism/reproducibility digest equality, and the honest labels in
 * the rendered threshold report.
 *
 *   * the hermetic three-arm run: all three arms produce complete
 *     per-attempt evidence; the mediated arm composes EXACTLY the
 *     bounded ladder [same-provider retry, alternate-provider failover]
 *     through the real PCR-002 wiring; every WORK-049 decision record
 *     of every composed step is observed;
 *   * the scan-vs-run oracle: the fixture's independent projection of
 *     the deterministic draws (the pure hash functions over the stream
 *     keys) predicts the mediated and optimized arms' per-request
 *     outcomes EXACTLY — the run is the draws, reproducible by
 *     construction;
 *   * the self-verifying evidence: every recorded attempt re-derives
 *     from the transport's pure draw functions (outcome, fault class,
 *     latency, cost, usage, retryability);
 *   * determinism/reproducibility: the full hermetic evaluation re-run
 *     reproduces the cell digest and the evaluation digest
 *     byte-for-byte;
 *   * honest labels: the rendered threshold report carries the
 *     synthetic-supply / synthetic-cost / synthetic-latency labels, the
 *     no-market-claims boundary and the PCR-004 eligibility statement.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runRecoveryPlanEvaluation } from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/application";
import { pinnedEvaluationCorpusDigest } from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/corpus";
import {
  aggregateEvaluation,
  cellDigestOf,
  runEvaluationCell,
} from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/driver";
import {
  hermeticCell,
  hermeticDrawnOutcome,
  hermeticMediatedProjection,
  hermeticOptimizedProjection,
} from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/fixtures";
import { renderThresholdReport } from "../../../benchmarks/validation/apps/economic-recovery-plan-evaluation/report";
import { edgeOf } from "../../../experiments/ppr-027/config";
import { buildCellCorpus } from "../../../experiments/ppr-027/driver";
import { createNodeDigest } from "../../../src/modules/planning/public";
import { validateRecoveryPlan } from "../../../src/platform/failure-recovery/plan";

const HERMETIC_CELL = hermeticCell();

async function runHermeticCell() {
  return runEvaluationCell({ cell: HERMETIC_CELL });
}

describe("PCR-003 the hermetic three-arm run over the real composed stack", () => {
  test("all three arms produce complete evidence with zero violations", async () => {
    const result = await runHermeticCell();
    for (const armId of ["un-retried-direct", "strong-optimized", "mediated-with-plan"] as const) {
      const arm = result.arms[armId];
      expect(arm.tasksTotal, armId).toBe(1);
      expect(arm.requestsTotal, armId).toBe(4);
      expect(arm.attemptsTotal, armId).toBeGreaterThan(0);
      expect(arm.microPerResolvedRequest, armId).not.toBeNull();
    }
    expect(result.violations).toEqual([]);
    // The exact-revision structure: all three arms in ONE cell result.
    expect(new Set(result.attempts.map((attempt) => attempt.armId))).toEqual(
      new Set(["un-retried-direct", "strong-optimized", "mediated-with-plan"]),
    );
  }, 60_000);

  test("the mediated arm composes EXACTLY the bounded ladder and records every step's WORK-049 decision", async () => {
    const result = await runHermeticCell();
    const projectedPlans = hermeticMediatedProjection().filter((entry) => entry.planComposed);
    expect(result.plans).toHaveLength(projectedPlans.length);
    expect(result.decisionRecordCount).toBe(
      projectedPlans.length * 2, // two composed steps per plan — every step's decision recorded
    );
    for (const plan of result.plans) {
      expect(plan.planSteps).toHaveLength(2);
      expect(plan.planSteps[0]?.move).toBe("retry");
      expect(plan.planSteps[0]?.dimension).toBeNull();
      expect(plan.planSteps[1]?.move).toBe("re-route");
      expect(plan.planSteps[1]?.dimension).toBe("provider");
      expect(plan.planSteps[1]?.failoverRoute).toBe("supply-c");
      expect(plan.terminal).toBe("bound-reached");
      expect(plan.rootFailureClass).toBe("provider");
    }
  }, 60_000);

  test("the scan-vs-run oracle: the fixture's independent draw projection predicts the mediated arm exactly", async () => {
    const result = await runHermeticCell();
    const projection = hermeticMediatedProjection();
    const mediatedOccurrences = result.occurrences.filter(
      (occurrence) => occurrence.armId === "mediated-with-plan",
    );
    expect(mediatedOccurrences).toHaveLength(projection.length);
    for (const [index, entry] of projection.entries()) {
      const occurrence = mediatedOccurrences[index];
      expect(occurrence?.resolutionClass, `request ${index}`).toBe(entry.resolutionClass);
      expect(occurrence?.outcome, `request ${index}`).toBe(entry.resolved ? "resolved" : "failed");
    }
    // The full-ladder request (retry AND failover attempts) executed 3 attempts.
    const fullLadderIndex = projection.findIndex(
      (entry) => entry.retryAttempt && entry.failoverAttempt,
    );
    expect(fullLadderIndex).toBeGreaterThan(-1);
    expect(mediatedOccurrences[fullLadderIndex]?.attempts).toBe(3);
  }, 60_000);

  test("the scan-vs-run oracle: the optimized arm's projection predicts the ladder outcomes exactly", async () => {
    const result = await runHermeticCell();
    const projection = hermeticOptimizedProjection();
    const optimizedOccurrences = result.occurrences.filter(
      (occurrence) => occurrence.armId === "strong-optimized",
    );
    expect(optimizedOccurrences).toHaveLength(projection.length);
    for (const [index, entry] of projection.entries()) {
      const occurrence = optimizedOccurrences[index];
      expect(occurrence?.outcome, `request ${index}`).toBe(entry.resolved ? "resolved" : "failed");
      if (entry.recovered) {
        expect(occurrence?.resolutionClass, `request ${index}`).toBe("resolved-after-recovery");
      }
    }
  }, 60_000);

  test("every recorded attempt re-derives from the transport's pure draw functions (self-verifying evidence)", async () => {
    const result = await runHermeticCell();
    expect(result.attempts.length).toBeGreaterThan(0);
    const corpus = buildCellCorpus(HERMETIC_CELL.subject, "mono", "S", 1);
    const requestOf = (baseTaskId: string, requestIndex: number, rep: number) => {
      const task = corpus.find(
        (candidate) => candidate.baseTaskId === baseTaskId && candidate.rep === rep,
      );
      const request = task?.requests[requestIndex];
      if (request === undefined) {
        throw new Error(`unknown request ${baseTaskId}/${requestIndex}`);
      }
      return request;
    };
    for (const attempt of result.attempts) {
      if (attempt.providerId === "deterministic") {
        continue;
      }
      const request = requestOf(attempt.baseTaskId, attempt.requestIndex, attempt.rep);
      const edge = edgeOf(HERMETIC_CELL.subject, request.edgeId);
      const drawn = hermeticDrawnOutcome({
        streamKey: attempt.streamKey,
        attempt: attempt.attempt,
        providerId: attempt.providerId,
        requestIndex: attempt.requestIndex,
      });
      void edge;
      if (drawn.ok === true) {
        expect(attempt.outcome, attempt.streamKey).toBe("success");
        expect(attempt.latencyMs, attempt.streamKey).toBe(drawn.latencyMs);
        expect(attempt.costNanoUsd, attempt.streamKey).toBe(drawn.costNanoUsd);
      } else {
        expect(attempt.outcome, attempt.streamKey).toBe("failure");
        expect(attempt.failureCategory, attempt.streamKey).toBe(drawn.category);
        expect(attempt.retryable, attempt.streamKey).toBe(drawn.retryable);
        expect(attempt.latencyMs, attempt.streamKey).toBe(drawn.latencyMs);
        expect(attempt.costNanoUsd, attempt.streamKey).toBe(drawn.costNanoUsd);
      }
    }
  }, 60_000);

  test("the mediated arm's failing attempts carry attribution and its recovery attempts carry the strategy verdict", async () => {
    const result = await runHermeticCell();
    for (const attempt of result.attempts.filter(
      (candidate) => candidate.armId === "mediated-with-plan",
    )) {
      if (attempt.outcome === "failure") {
        expect(attempt.attribution, attempt.streamKey).not.toBeNull();
        expect(attempt.attribution?.signal, attempt.streamKey).toMatch(
          /provider-rate-limited|transport-timeout|provider-capacity/,
        );
        expect(attempt.attribution?.observationDigest, attempt.streamKey).toMatch(/^[0-9a-f]{64}$/);
      }
      if (attempt.attempt >= 2) {
        expect(attempt.strategyVerdict, attempt.streamKey).not.toBeNull();
        expect(attempt.strategyVerdict?.authority, attempt.streamKey).toBe("recovery-plane");
        expect(["retry", "re-route"], attempt.streamKey).toContain(attempt.strategyVerdict?.move);
      }
      if (attempt.attempt === 1) {
        expect(attempt.strategyVerdict, attempt.streamKey).toBeNull();
      }
    }
    // The baseline arms carry no attribution (non-Zeck stacks — honest).
    for (const attempt of result.attempts.filter(
      (candidate) => candidate.armId !== "mediated-with-plan",
    )) {
      expect(attempt.attribution, attempt.streamKey).toBeNull();
    }
  }, 60_000);

  test("the direct arm is exactly one attempt per occurrence on the primary supply; the optimized ladder stays within its bound", async () => {
    const result = await runHermeticCell();
    for (const occurrence of result.occurrences.filter(
      (candidate) => candidate.armId === "un-retried-direct",
    )) {
      expect(occurrence.attempts).toBe(1);
    }
    for (const attempt of result.attempts.filter(
      (candidate) => candidate.armId === "un-retried-direct",
    )) {
      expect(attempt.providerId).toBe("supply-a");
      expect(attempt.attempt).toBe(1);
    }
    for (const occurrence of result.occurrences.filter(
      (candidate) => candidate.armId === "strong-optimized",
    )) {
      expect(occurrence.attempts).toBeLessThanOrEqual(3);
    }
    // The optimized ladder's provider sequence per stream key: a -> b -> c by attempt.
    for (const attempt of result.attempts.filter(
      (candidate) => candidate.armId === "strong-optimized",
    )) {
      const expected = ["supply-a", "supply-b", "supply-c"][attempt.attempt - 1];
      expect(attempt.providerId, attempt.streamKey).toBe(expected);
    }
  }, 60_000);
});

describe("PCR-003 determinism/reproducibility (the digest equality)", () => {
  test("the full hermetic evaluation re-run reproduces the cell and evaluation digests byte-for-byte", async () => {
    const first = await runHermeticCell();
    const second = await runHermeticCell();
    expect(second.digest).toBe(first.digest);
    const firstAggregate = aggregateEvaluation([first]);
    const secondAggregate = aggregateEvaluation([second]);
    expect(secondAggregate.digest).toBe(firstAggregate.digest);
    // The stored digest re-derives from the stored evidence (the digest
    // discipline), and the digest is discriminating: a tampered attempt
    // record is a different digest.
    const { digest: _stored, ...evidence } = first;
    expect(cellDigestOf(evidence)).toBe(first.digest);
    const tamperedAttempts = first.attempts.map((attempt, index) =>
      index === 0 ? { ...attempt, latencyMs: (attempt.latencyMs ?? 0) + 1 } : attempt,
    );
    expect(cellDigestOf({ ...evidence, attempts: tamperedAttempts })).not.toBe(first.digest);
  }, 60_000);

  test("the application entry composes the evaluation over the targeted cells with the pinned corpus digest", async () => {
    const result = await runRecoveryPlanEvaluation({ cells: [HERMETIC_CELL] });
    expect(result.corpusDigest).toBe(pinnedEvaluationCorpusDigest());
    expect(result.aggregate.cells).toHaveLength(1);
    expect(result.aggregate.digest).toMatch(/^[0-9a-f]{64}$/);
    // The verdicts derive mechanically over the hermetic slice (a
    // mechanical derivation proof — the EVIDENCE is the full 51-cell
    // run in results/, never this slice).
    expect(result.aggregate.verdicts.resolution.verdict).toMatch(/met|missed/);
    expect(result.aggregate.verdicts.violations.count).toBe(0);
  }, 60_000);
});

describe("PCR-003 honest labels in the rendered threshold report", () => {
  test("the report carries the synthetic labels, the no-market-claims boundary, the verdicts and the PCR-004 statement", async () => {
    const result = await runRecoveryPlanEvaluation({ cells: [HERMETIC_CELL] });
    const report = renderThresholdReport({
      aggregate: result.aggregate,
      corpusDigest: result.corpusDigest,
      runRevision: "test-revision",
      runStartedAt: result.runStartedAt,
      reRunDigest: result.aggregate.digest,
      perCellTable: result.aggregate.cells.map((cell) => ({
        cellId: cell.cellId,
        mediatedTasksResolved: cell.arms["mediated-with-plan"].tasksResolved,
        mediatedTasksTotal: cell.arms["mediated-with-plan"].tasksTotal,
        optimizedTasksResolved: cell.arms["strong-optimized"].tasksResolved,
        optimizedTasksTotal: cell.arms["strong-optimized"].tasksTotal,
        directTasksResolved: cell.arms["un-retried-direct"].tasksResolved,
        directTasksTotal: cell.arms["un-retried-direct"].tasksTotal,
      })),
    });
    expect(report).toContain("synthetic-supply");
    expect(report).toContain("synthetic-cost");
    expect(report).toContain("synthetic-latency");
    expect(report).toContain("never a live provider");
    expect(report).toContain("no market or production claims");
    expect(report).toContain("a threshold miss with honest attribution is a valid delivery");
    expect(report).toContain("## T1 — Resolution");
    expect(report).toContain("## T2 — Failure-adjusted cost");
    expect(report).toContain("## T3 — Policy/budget violations");
    expect(report).toContain("## T4 — Latency tails");
    expect(report).toContain("## PCR-004 eligibility statement");
    expect(report).toContain("PCR-004 (hedged execution)");
    expect(report).toContain("**VERDICT:");
    expect(report).toContain(
      "IDENTICAL (the full evaluation re-run reproduced the evaluation digest byte-for-byte)",
    );
    expect(report).toContain("the exact-revision rule");
    // The committed report exists as the durable evidence document.
    expect(report).toContain(pinnedEvaluationCorpusDigest());
  }, 60_000);

  test("the committed threshold report artifact carries the honest labels and the measured verdicts", () => {
    const report = readFileSync(
      `${process.cwd()}/benchmarks/validation/apps/economic-recovery-plan-evaluation/results/threshold-report.md`,
      "utf8",
    );
    expect(report).toContain("synthetic-supply");
    expect(report).toContain("synthetic-cost");
    expect(report).toContain("synthetic-latency");
    expect(report).toContain("VERDICT: MET");
    expect(report).toContain("PCR-004 (hedged execution) is NOT eligible");
    expect(report).toContain("mediated-with-plan");
    expect(report).toContain("strong-optimized");
    expect(report).toContain("un-retried-direct");
  });
});

// ---------------------------------------------------------------------------
// The hard gate's plan-artifact leg (IN-SUITE injection — VAL-002 AC7's
// boundary forbids the app tree importing the plane's validator; the
// suites inject the recovery plane's OWN total validation over every
// composed plan of the FULL evaluation, and the deterministic-replay
// identity — the digest equality with the committed evidence — makes it
// a validation of the committed artifacts)
// ---------------------------------------------------------------------------

describe("PCR-003 the hard gate's plan-artifact leg (the in-suite injection)", () => {
  test("the plane's own validateRecoveryPlan over every composed plan of the FULL evaluation — zero invalid artifacts, digest identical to the committed evidence", {
    timeout: 120_000,
  }, async () => {
    const nodeDigest = createNodeDigest();
    const validator = (plan: unknown): void => {
      validateRecoveryPlan(plan, nodeDigest);
    };
    let plansValidated = 0;
    const result = await runRecoveryPlanEvaluation({
      planArtifactValidator: (plan) => {
        plansValidated += 1;
        validator(plan);
      },
    });
    // Every composed plan of every targeted cell validated through the
    // plane's own total validation — zero invalid artifacts anywhere.
    expect(plansValidated).toBe(
      result.aggregate.cells.reduce((sum, cell) => sum + cell.plans.length, 0),
    );
    expect(plansValidated).toBeGreaterThan(0);
    expect(result.aggregate.verdicts.violations.count).toBe(0);
    expect(
      result.aggregate.cells
        .flatMap((cell) => cell.violations)
        .filter((violation) => violation.kind === "plan-artifact-invalid"),
    ).toEqual([]);
    // The deterministic-replay identity: the injected run's digest
    // equals the committed evidence's digest — the in-suite validation
    // IS a validation of the committed artifacts.
    expect(result.aggregate.digest).toBe(
      "816fed3721b864a89ec810d018b4fb3ab678c2b79f22f9fb04c80d9199415d11",
    );
  });
});
