/**
 * The PCL-003 evaluation oracles (work order PCL-003 — the engine
 * suites).
 *
 * Proves mechanically:
 *  - the CONSTRUCTION LAWS: the app-local fact constructor rejects
 *    every incoherent shape fail-closed (closed vocabularies, bounded
 *    values, the exact census reconciliation, the outcome-class/census
 *    agreement, the resolution/outcome-class agreement — the
 *    no-failure-hiding discipline: a dropped or reclassified failure is
 *    unrepresentable, the automatic-void shape);
 *  - the PERCENTILE COMPUTATION against known fixtures (the capstone's
 *    own nearest-rank convention; edge fixtures: the empty population,
 *    the single sample, ties at percentile boundaries);
 *  - the CENSUS RECONCILIATION over real replayed cells (attempts =
 *    original + retry + fallback + verification; the route legs =
 *    original + retry + fallback) and the automatic-void rejection of
 *    the reclassified-failure shape;
 *  - the PROMOTION GATE's application: every leg independently
 *    falsifiable (a configuration that improves the tail but regresses
 *    resolution FAILS the gate; a tail regression fails T1; a cost
 *    explosion fails T3; a masked terminal failure fails T4);
 *  - the DIGEST REPRODUCIBILITY (the same facts and configuration ⇒
 *    the byte-identical digest; a changed fact ⇒ a changed digest; and
 *    wall-clock/run identities never participate);
 *  - the REPLAY's self-verifying evidence (every attempt re-derives
 *    from the transport's pure draw functions) and the baseline arm's
 *    quoted capstone posture (ONE policy retry, the 5 ms wait, polled
 *    at the sweep driver's declared 10 ms interval).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createNodeDigestPort } from "../../../benchmarks/validation/apps/latency-tail-evaluation/canonical";
import {
  BASELINE_ARM,
  FAILURE_CLASS_OF_SUPPLY_FAULT,
  TUNED_ARM,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/configurations";
import {
  type EvaluationCell,
  edgeOfRequest,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/corpus";
import {
  cellDigestProjectionOf,
  evaluationCells,
  loadDeclaredThresholds,
  runEvaluationCell,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/driver";
import {
  attemptCensusOf,
  measuredCost,
  measuredLatency,
  notRunLatency,
  OutcomeLatencyConstructionError,
  type OutcomeLatencyFacts,
  outcomeLatencyFactsIdentity,
  outcomeLatencyFactsOf,
  outcomeLatencyLeg,
  progressDeliveryFacts,
  verificationProofOf,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/facts";
import {
  type ArmGateFacts,
  applyPromotionGate,
  DECLARED_THRESHOLDS,
  type PromotionGateVerdict,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/gate";
import {
  legPercentilesByFailureClassAndRoute,
  outcomePercentilesByEncounteredClass,
  percentileOf,
} from "../../../benchmarks/validation/apps/latency-tail-evaluation/percentiles";
import { replayCellArm } from "../../../benchmarks/validation/apps/latency-tail-evaluation/replay";
import { outcomeOf, type SubjectDefinition } from "../../../benchmarks/validation/apps/shared/seam";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const digestPort = createNodeDigestPort();

// ---------------------------------------------------------------------------
// The hermetic replay fixture (a deterministic two-task text subject)
// ---------------------------------------------------------------------------

const HERMETIC_SUBJECT: SubjectDefinition = {
  subjectId: "pcl-003-hermetic",
  name: "PCL-003 hermetic subject",
  repository: "pcl-003/hermetic",
  upstreamRevision: "test",
  integrationRevision: "test",
  evidenceRecord: "pcl-003-hermetic",
  requestCountBasis: "resolved-corpus-narrative",
  tokenTotalsBasis: "resolved-corpus-narrative",
  edges: [
    { edgeId: "edge-1", surface: "text-generation", modalityClass: "text" },
    { edgeId: "edge-2", surface: "embeddings", modalityClass: "embeddings" },
  ],
  tasks: [
    {
      taskId: "task-a",
      title: "Task A",
      instruction: "Do A",
      requests: [
        { edgeId: "edge-1", inputTokens: 500, outputTokens: 200 },
        { edgeId: "edge-1", inputTokens: 300, outputTokens: 100 },
      ],
    },
    {
      taskId: "task-b",
      title: "Task B",
      instruction: "Do B",
      requests: [{ edgeId: "edge-2", inputTokens: 800, outputTokens: 0 }],
    },
  ],
  certifiedTotals: { requests: 3, inputTokens: 1600, outputTokens: 300 },
};

const HERMETIC_CELL: EvaluationCell = {
  cellId: "pcl-003-hermetic-S-multi-mono",
  subject: HERMETIC_SUBJECT,
  volume: "S",
  repetitions: 1,
  providerConfig: "multi",
  modality: "mono",
  providerIds: ["supply-a", "supply-b", "supply-c"],
};

const HERMETIC_CELL_SINGLE: EvaluationCell = {
  ...HERMETIC_CELL,
  cellId: "pcl-003-hermetic-S-single-mono",
  providerConfig: "single",
  providerIds: ["supply-a"],
};

// ---------------------------------------------------------------------------
// The construction laws (fail-closed on every incoherent shape)
// ---------------------------------------------------------------------------

/** A minimal coherent fact block to mutate (raw inputs — the mutations run BEFORE construction). */
function coherentFacts(
  mutate?: (draft: ReturnType<typeof coherentInputs>) => void,
): OutcomeLatencyFacts {
  const inputs = coherentInputs();
  mutate?.(inputs);
  return outcomeLatencyFactsOf({
    outcomeClass: inputs.outcomeClass,
    legs: inputs.legs.map((leg) => outcomeLatencyLeg(leg)),
    attemptCensus: inputs.attemptCensus,
    progress: inputs.progress,
    cost: inputs.cost,
    resolved: inputs.resolved,
    verification: inputs.verification,
    basis: inputs.basis,
  });
}

function coherentInputs() {
  return {
    outcomeClass: "succeeded-on-fallback" as "succeeded-on-fallback",
    legs: [
      {
        legId: "exec-1:a1",
        route: { provider: "supply-b", model: "text" },
        failureClass: "provider-throttle" as const,
        firstByte: notRunLatency(
          "the synthetic supply declares no first-byte profile (owner: PCL-003 evaluation; the transport draws completion latency only)",
        ),
        completion: measuredLatency(31),
      },
      {
        legId: "exec-1:a2",
        route: { provider: "supply-a", model: "text" },
        firstByte: notRunLatency(
          "the synthetic supply declares no first-byte profile (owner: PCL-003 evaluation; the transport draws completion latency only)",
        ),
        completion: measuredLatency(14),
      },
    ],
    attemptCensus: attemptCensusOf({ original: 1, retry: 0, fallback: 1, verification: 1 }),
    progress: progressDeliveryFacts({
      mode: "polled",
      pollingInterval: measuredLatency(10),
      cooldownAtDispatch: { kind: "none" },
    }),
    cost: {
      totalIncludingDuplicates: measuredCost(
        3,
        "synthetic-price-schedule:transport-charges-per-physical-dispatch",
      ),
      verification: measuredCost(0, "synthetic-price-schedule:no-verification-charge"),
    },
    resolved: true,
    verification: verificationProofOf({
      kind: "proved",
      outcome: "pass",
      resultIds: ["exec-1:v1"],
    }),
    basis: {
      executionId: "exec-1",
      route: { provider: "supply-b", model: "text" },
      revision: 0,
      clockDiscipline: "wall-clock" as const,
    },
  };
}

describe("PCL-003: the construction laws (fail-closed on every incoherent shape)", () => {
  test("a coherent fact block constructs (the happy path)", () => {
    const facts = coherentFacts();
    expect(facts.outcomeClass).toBe("succeeded-on-fallback");
    expect(facts.attemptCensus.attempts).toBe(3);
  });

  test("unknown outcome class and unknown failure class are rejected typed", () => {
    expect(() =>
      coherentFacts((draft) => {
        (draft as { outcomeClass: string }).outcomeClass = "succeeded-magically";
      }),
    ).toThrow(OutcomeLatencyConstructionError);
    expect(() =>
      coherentFacts((draft) => {
        (draft.legs[0] as { failureClass: string }).failureClass = "provider-4xx";
      }),
    ).toThrow(/outcomeLatencyFacts\.legs\.failureClass/);
  });

  test("duplicate leg ids are rejected", () => {
    expect(() =>
      coherentFacts((draft) => {
        (draft.legs[1] as { legId: string }).legId = "exec-1:a1";
      }),
    ).toThrow(/duplicate legId/);
  });

  test("the census must reconcile EXACTLY (attempts = original + retry + fallback + verification) — the automatic-void shape is unrepresentable", () => {
    expect(() =>
      coherentFacts((draft) => {
        (draft.attemptCensus as { attempts: number }).attempts = 2; // a dropped attempt
      }),
    ).toThrow(/exact outcome-census reconciliation/);
  });

  test("the outcome class must agree with the census (the plain meanings of the closed classes)", () => {
    expect(() =>
      coherentFacts((draft) => {
        (draft as { outcomeClass: string }).outcomeClass = "succeeded-first-attempt";
      }),
    ).toThrow(/succeeded-first-attempt is incoherent/);
    expect(() =>
      coherentFacts((draft) => {
        (draft as { outcomeClass: string }).outcomeClass = "succeeded-after-retry";
      }),
    ).toThrow(/succeeded-after-retry is incoherent/);
    expect(() =>
      coherentFacts((draft) => {
        draft.attemptCensus = attemptCensusOf({
          original: 1,
          retry: 0,
          fallback: 0,
          verification: 1,
        });
        (draft as { outcomeClass: string }).outcomeClass = "succeeded-on-fallback";
      }),
    ).toThrow(/succeeded-on-fallback is incoherent/);
  });

  test("a reclassified failure is unrepresentable: failed-terminal never records resolved; a succeeded outcome always does", () => {
    expect(() =>
      coherentFacts((draft) => {
        draft.resolved = false;
      }),
    ).toThrow(/resolved is incoherent with outcomeClass/);
    expect(() =>
      coherentFacts((draft) => {
        (draft as { outcomeClass: string }).outcomeClass = "failed-terminal";
      }),
    ).toThrow(/failed-terminal.*never records resolved/);
  });

  test("the progress mechanics record rejects the incoherent shapes (polled requires an interval; an interval cannot ride an event stream)", () => {
    expect(() =>
      progressDeliveryFacts({ mode: "polled", cooldownAtDispatch: { kind: "none" } }),
    ).toThrow(OutcomeLatencyConstructionError);
    expect(() =>
      progressDeliveryFacts({
        mode: "event-stream",
        pollingInterval: measuredLatency(10),
        cooldownAtDispatch: { kind: "none" },
      }),
    ).toThrow(OutcomeLatencyConstructionError);
  });

  test("the measured bounds reject negatives, non-finite values and non-integer cost", () => {
    expect(() => measuredLatency(-1)).toThrow(OutcomeLatencyConstructionError);
    expect(() => measuredLatency(Number.POSITIVE_INFINITY)).toThrow(
      OutcomeLatencyConstructionError,
    );
    expect(() => measuredCost(1.5, "basis")).toThrow(OutcomeLatencyConstructionError);
  });

  test("the basis is required and bounded (an unattributed fact is unrepresentable)", () => {
    expect(() =>
      coherentFacts((draft) => {
        draft.basis.executionId = "";
      }),
    ).toThrow(OutcomeLatencyConstructionError);
    expect(() =>
      coherentFacts((draft) => {
        draft.basis.route.provider = "Not A Slug";
      }),
    ).toThrow(OutcomeLatencyConstructionError);
  });
});

// ---------------------------------------------------------------------------
// The percentile computation (the capstone's nearest-rank convention)
// ---------------------------------------------------------------------------

describe("PCL-003: the percentile computation against known fixtures", () => {
  test("the empty population renders the honest null spelling (never a fabricated zero)", () => {
    expect(percentileOf([], 0.5)).toBeNull();
    expect(percentileOf([], 0.95)).toBeNull();
    expect(percentileOf([], 0.99)).toBeNull();
  });

  test("the single-sample population: p50 = p95 = p99 = the sample", () => {
    expect(percentileOf([42], 0.5)).toBe(42);
    expect(percentileOf([42], 0.95)).toBe(42);
    expect(percentileOf([42], 0.99)).toBe(42);
  });

  test("ties at percentile boundaries resolve deterministically (the nearest-rank convention)", () => {
    // n = 4: p50 = sorted[2]; p95/p99 = sorted[ceil(4p) - 1] = sorted[3].
    expect(percentileOf([10, 20, 20, 30], 0.5)).toBe(20);
    expect(percentileOf([10, 20, 20, 30], 0.95)).toBe(30);
    expect(percentileOf([10, 20, 20, 30], 0.99)).toBe(30);
    expect(percentileOf([20, 20, 20, 20], 0.5)).toBe(20);
    expect(percentileOf([20, 20, 20, 20], 0.95)).toBe(20);
    // n = 100 (1..100): p50 = sorted[50] = 51; p95 = sorted[94] = 95; p99 = sorted[98] = 99.
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentileOf(hundred, 0.5)).toBe(51);
    expect(percentileOf(hundred, 0.95)).toBe(95);
    expect(percentileOf(hundred, 0.99)).toBe(99);
    // n = 19 (1..19): p50 = sorted[9] = 10; p95 = p99 = sorted[18] = 19.
    const nineteen = Array.from({ length: 19 }, (_, index) => index + 1);
    expect(percentileOf(nineteen, 0.5)).toBe(10);
    expect(percentileOf(nineteen, 0.95)).toBe(19);
    expect(percentileOf(nineteen, 0.99)).toBe(19);
  });

  test("the per-failure-class tables decompose — never aggregate-only — and every closed-vocabulary member is present", () => {
    const facts = coherentFacts();
    const rows = legPercentilesByFailureClassAndRoute([facts]);
    const classes = rows.map((row) => row.failureClass);
    for (const member of [
      "provider-5xx",
      "provider-timeout",
      "provider-throttle",
      "connection-error",
      "verification-retry",
      "budget-exhausted",
      "policy-denied",
      "no-failure",
    ]) {
      expect(classes, `every closed-vocabulary member must be present: ${member}`).toContain(
        member,
      );
    }
    const throttle = rows.find(
      (row) => row.failureClass === "provider-throttle" && row.route === "supply-b/text",
    );
    expect(throttle?.samples).toBe(1);
    expect(throttle?.p50Ms).toBe(31);
    const clean = rows.find(
      (row) => row.failureClass === "no-failure" && row.route === "supply-a/text",
    );
    expect(clean?.samples).toBe(1);
    expect(clean?.p99Ms).toBe(14);
    // A zero-sample class renders the honest no-samples row.
    const connectionError = rows.find((row) => row.failureClass === "connection-error");
    expect(connectionError?.samples).toBe(0);
    expect(connectionError?.p95Ms).toBeNull();
  });

  test("the encountered-class outcome tail attributes outcomes to the classes their legs met", () => {
    const rows = outcomePercentilesByEncounteredClass([
      { outcomeLatencyMs: 45, facts: coherentFacts() },
    ]);
    const throttle = rows.find((row) => row.key === "provider-throttle");
    expect(throttle?.samples).toBe(1);
    expect(throttle?.p50Ms).toBe(45);
    const fiveXx = rows.find((row) => row.key === "provider-5xx");
    expect(fiveXx?.samples).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The census reconciliation over real replayed cells
// ---------------------------------------------------------------------------

describe("PCL-003: the census reconciliation over replayed cells (no failure hiding)", () => {
  test("every arm's census reconciles exactly on the hermetic cells (both provider configurations)", () => {
    for (const cell of [HERMETIC_CELL, HERMETIC_CELL_SINGLE]) {
      for (const arm of [BASELINE_ARM, TUNED_ARM]) {
        const replay = replayCellArm(cell, arm, { digest: digestPort });
        let original = 0;
        let retry = 0;
        let fallback = 0;
        let verification = 0;
        let attempts = 0;
        let legs = 0;
        for (const execution of replay.executions) {
          original += execution.facts.attemptCensus.original;
          retry += execution.facts.attemptCensus.retry;
          fallback += execution.facts.attemptCensus.fallback;
          verification += execution.facts.attemptCensus.verification;
          attempts += execution.facts.attemptCensus.attempts;
          legs += execution.facts.legs.length;
          // Every outcome class agrees with its own census (the constructor
          // already enforces this; asserted here over the real replay).
          expect(execution.facts.attemptCensus.attempts).toBe(
            execution.facts.attemptCensus.original +
              execution.facts.attemptCensus.retry +
              execution.facts.attemptCensus.fallback +
              execution.facts.attemptCensus.verification,
          );
        }
        expect(attempts).toBe(original + retry + fallback + verification);
        expect(legs).toBe(original + retry + fallback);
        expect(replay.totalAttempts).toBe(legs);
      }
    }
  });

  test("the reclassified-failure shape (a terminal recorded as resolved) is rejected by the construction laws — the automatic-void guard", () => {
    expect(() =>
      coherentFacts((draft) => {
        draft.attemptCensus = attemptCensusOf({
          original: 1,
          retry: 0,
          fallback: 0,
          verification: 0,
        });
        (draft as { outcomeClass: string }).outcomeClass = "failed-terminal";
      }),
    ).toThrow(/never records resolved/);
  });
});

// ---------------------------------------------------------------------------
// The promotion gate (every leg independently falsifiable)
// ---------------------------------------------------------------------------

function gateFacts(overrides: Partial<ArmGateFacts> & { armId: string }): ArmGateFacts {
  return {
    executions: 100,
    resolved: 98,
    resolutionRate: 0.98,
    p50Ms: 18,
    p95Ms: 50,
    p99Ms: 60,
    totalCostMicroUsd: 1000,
    totalCostBasis: "synthetic-price-schedule:transport-charges-per-physical-dispatch",
    verificationCostMicroUsd: 0,
    verificationCostBasis: "synthetic-price-schedule:no-verification-charge",
    terminalFailures: 2,
    maskedTerminalFailures: 0,
    dispatchBudgetViolations: 0,
    censusReconciles: true,
    ...overrides,
  };
}

const BASELINE_GATE = gateFacts({ armId: "baseline-today" });
const TUNED_GATE = gateFacts({ armId: "tail-tuned-v1", p95Ms: 45, p99Ms: 55 });

describe("PCL-003: the promotion gate (mechanical, every leg independently falsifiable)", () => {
  test("all four legs pass ⇒ PROMOTED", () => {
    const verdict = applyPromotionGate({
      baseline: BASELINE_GATE,
      tuned: TUNED_GATE,
      thresholds: DECLARED_THRESHOLDS,
    });
    expect(verdict.verdict).toBe("PROMOTED");
    expect(verdict.failingLegs).toEqual([]);
    expect(verdict.legs.map((leg) => leg.legId)).toEqual(["T1", "T2", "T3", "T4"]);
  });

  test("T1 alone fails when the tail does not strictly improve at BOTH p95 and p99", () => {
    const verdict = applyPromotionGate({
      baseline: BASELINE_GATE,
      tuned: gateFacts({ armId: "tuned", p95Ms: 45, p99Ms: 61 }),
      thresholds: DECLARED_THRESHOLDS,
    });
    expect(verdict.verdict).toBe("NOT-PROMOTED");
    expect(verdict.failingLegs).toEqual(["T1"]);
    expect(verdict.legs[0]?.attribution).toContain("p95");
  });

  test("a configuration that improves the tail but REGRESSES resolution FAILS the gate (the resolution-honesty leg is load-bearing)", () => {
    const verdict = applyPromotionGate({
      baseline: BASELINE_GATE,
      tuned: gateFacts({
        armId: "tuned",
        p95Ms: 40,
        p99Ms: 50,
        resolutionRate: 0.97,
        resolved: 97,
        terminalFailures: 3,
      }),
      thresholds: DECLARED_THRESHOLDS,
    });
    expect(verdict.verdict).toBe("NOT-PROMOTED");
    expect(verdict.failingLegs).toEqual(["T2"]);
    expect(verdict.legs[1]?.attribution).toContain("MISS");
  });

  test("a cost explosion beyond the declared budget delta fails T3 (with both bases stated)", () => {
    const verdict = applyPromotionGate({
      baseline: BASELINE_GATE,
      tuned: gateFacts({ armId: "tuned", p95Ms: 40, p99Ms: 50, totalCostMicroUsd: 1300 }),
      thresholds: DECLARED_THRESHOLDS,
    });
    expect(verdict.failingLegs).toEqual(["T3"]);
    expect(verdict.legs[2]?.detail).toMatchObject({ allowedBudgetMicroUsd: 1250 });
  });

  test("a masked terminal failure fails T4 even when every other leg passes (the automatic-void shape)", () => {
    const verdict = applyPromotionGate({
      baseline: BASELINE_GATE,
      tuned: gateFacts({ armId: "tuned", p95Ms: 40, p99Ms: 50, maskedTerminalFailures: 1 }),
      thresholds: DECLARED_THRESHOLDS,
    });
    expect(verdict.failingLegs).toEqual(["T4"]);
  });

  test("a dispatch-budget violation or a non-reconciling census fails T4 independently", () => {
    for (const overrides of [{ dispatchBudgetViolations: 1 }, { censusReconciles: false }]) {
      const verdict: PromotionGateVerdict = applyPromotionGate({
        baseline: BASELINE_GATE,
        tuned: gateFacts({ armId: "tuned", p95Ms: 40, p99Ms: 50, ...overrides }),
        thresholds: DECLARED_THRESHOLDS,
      });
      expect(verdict.failingLegs).toEqual(["T4"]);
    }
  });

  test("median improvement alone promotes NOTHING: equal p95/p99 with a better p50 is a T1 miss", () => {
    const verdict = applyPromotionGate({
      baseline: BASELINE_GATE,
      tuned: gateFacts({ armId: "tuned", p50Ms: 10, p95Ms: 50, p99Ms: 60 }),
      thresholds: DECLARED_THRESHOLDS,
    });
    expect(verdict.verdict).toBe("NOT-PROMOTED");
    expect(verdict.failingLegs).toEqual(["T1"]);
  });
});

// ---------------------------------------------------------------------------
// The digest reproducibility (same facts ⇒ same digest; changed fact ⇒
// changed digest)
// ---------------------------------------------------------------------------

describe("PCL-003: the digest reproducibility", () => {
  test("the same facts produce the byte-identical content address (and the canonical spelling is stable)", () => {
    const facts = coherentFacts();
    expect(outcomeLatencyFactsIdentity(facts, sha256)).toBe(
      outcomeLatencyFactsIdentity(coherentFacts(), sha256),
    );
  });

  test("a changed fact changes the content address (latency, census, cost, basis each bind)", () => {
    const baseline = outcomeLatencyFactsIdentity(coherentFacts(), sha256);
    const changedLatency = outcomeLatencyFactsIdentity(
      coherentFacts((draft) => {
        (draft.legs[1] as { completion: { kind: string; milliseconds: number } }).completion = {
          kind: "measured",
          milliseconds: 15,
        };
      }),
      sha256,
    );
    expect(changedLatency).not.toBe(baseline);
    const changedCensus = outcomeLatencyFactsIdentity(
      coherentFacts((draft) => {
        draft.attemptCensus = attemptCensusOf({
          original: 1,
          retry: 1,
          fallback: 1,
          verification: 1,
        });
      }),
      sha256,
    );
    expect(changedCensus).not.toBe(baseline);
    const changedCost = outcomeLatencyFactsIdentity(
      coherentFacts((draft) => {
        draft.cost.totalIncludingDuplicates = measuredCost(4, "changed-basis");
      }),
      sha256,
    );
    expect(changedCost).not.toBe(baseline);
    const changedBasis = outcomeLatencyFactsIdentity(
      coherentFacts((draft) => {
        draft.basis.executionId = "exec-2";
      }),
      sha256,
    );
    expect(changedBasis).not.toBe(baseline);
  });

  test("the replayed cell digest is stable across independent replays (wall-clock never participates)", () => {
    const cell = evaluationCells().find((candidate) => candidate.cellId === "aider-S-multi-mono");
    expect(cell).toBeDefined();
    const thresholds = loadDeclaredThresholds();
    const first = runEvaluationCell(cell as EvaluationCell, { thresholds, digest: digestPort });
    const second = runEvaluationCell(cell as EvaluationCell, { thresholds, digest: digestPort });
    expect(second.digest).toBe(first.digest);
    // The digest is independent of the wallMs field by construction.
    (first as { wallMs: number }).wallMs = 12345;
    expect(cellDigestUnchanged(first)).toBe(true);
  });
});

function cellDigestUnchanged(cell: ReturnType<typeof runEvaluationCell>): boolean {
  // Re-derive the digest from the projection (wall-clock excluded) and
  // compare with the recorded digest — the wallMs mutation above must
  // not move it.
  return digestPort.sha256Hex(cellDigestProjectionOf(cell)) === cell.digest;
}

// ---------------------------------------------------------------------------
// The replay's self-verifying evidence + the baseline's quoted posture
// ---------------------------------------------------------------------------

describe("PCL-003: the replay's self-verifying evidence and the quoted postures", () => {
  test("every attempt of every execution re-derives from the transport's pure draw functions (both arms)", () => {
    for (const arm of [BASELINE_ARM, TUNED_ARM]) {
      const replay = replayCellArm(HERMETIC_CELL, arm, { digest: digestPort });
      expect(replay.executions.length).toBeGreaterThan(0);
      for (const execution of replay.executions) {
        const task = HERMETIC_SUBJECT.tasks.find(
          (candidate) => candidate.taskId === execution.taskId.replace(/#rep\d+$/, ""),
        );
        expect(task).toBeDefined();
        const request = task?.requests[execution.requestIndex];
        expect(request).toBeDefined();
        const edge = edgeOfRequest(
          HERMETIC_SUBJECT,
          request as { edgeId: string; inputTokens: number; outputTokens: number },
        );
        for (const attempt of execution.attempts) {
          const drawn = outcomeOf({
            providerId: attempt.providerId,
            edge,
            request: request as { edgeId: string; inputTokens: number; outputTokens: number },
            streamKey: execution.streamKey,
            attempt: attempt.attempt,
          });
          expect(attempt.latencyMs).toBe(drawn.latencyMs);
          expect(attempt.costNanoUsd).toBe(drawn.costNanoUsd);
          if (drawn.ok === true) {
            expect(attempt.failureClass).toBeNull();
          } else {
            expect(attempt.failureClass).toBe(FAILURE_CLASS_OF_SUPPLY_FAULT[drawn.category]);
          }
        }
      }
    }
  });

  test("the baseline arm carries the capstone's quoted posture (ONE policy retry, the 5 ms wait, polled at the driver's 10 ms interval, no cooldowns)", () => {
    const replay = replayCellArm(HERMETIC_CELL, BASELINE_ARM, { digest: digestPort });
    for (const execution of replay.executions) {
      // The ladder never exceeds the traced posture's two attempts.
      expect(execution.attempts.length).toBeLessThanOrEqual(2);
      // The mechanics record: polled at the sweep driver's declared
      // interval, no cooldown state (the capstone addresses no pacing
      // surface).
      expect(execution.facts.progress.mode).toBe("polled");
      expect(execution.facts.progress.pollingInterval?.kind).toBe("measured");
      expect(
        execution.facts.progress.pollingInterval?.kind === "measured"
          ? execution.facts.progress.pollingInterval.milliseconds
          : null,
      ).toBe(10);
      expect(execution.facts.progress.cooldownAtDispatch.kind).toBe("none");
      // The inter-attempt wait is exactly the quoted 5 ms.
      for (const attempt of execution.attempts.slice(1)) {
        expect(attempt.waitBeforeMs).toBe(5);
      }
    }
  });

  test("the tuned arm carries the PCL-002 mechanics (polled at the declared 50 ms interval; the paced waits within the declared bounds; the timeout contract respected)", () => {
    const replay = replayCellArm(HERMETIC_CELL, TUNED_ARM, { digest: digestPort });
    for (const execution of replay.executions) {
      expect(execution.facts.progress.mode).toBe("polled");
      expect(
        execution.facts.progress.pollingInterval?.kind === "measured"
          ? execution.facts.progress.pollingInterval.milliseconds
          : null,
      ).toBe(50);
      for (const attempt of execution.attempts.slice(1)) {
        expect(attempt.waitBeforeMs).toBeGreaterThanOrEqual(1);
        expect(attempt.waitBeforeMs).toBeLessThanOrEqual(
          TUNED_ARM.pacing.retryPacing?.backoff.ceilingMs ?? 5,
        );
      }
      // The dispatch-budget invariant (the preservation gate's arithmetic).
      expect(execution.outcomeLatencyMs).toBeLessThanOrEqual(
        TUNED_ARM.pacing.timeoutContract.dispatchBudgetMs,
      );
    }
  });

  test("the resolved executions carry proved verification (pass, >= 1 result reference); terminal failures carry their honest not-run with an owner", () => {
    const replay = replayCellArm(HERMETIC_CELL, TUNED_ARM, { digest: digestPort });
    for (const execution of replay.executions) {
      if (execution.resolved) {
        expect(execution.facts.verification.kind).toBe("proved");
        if (execution.facts.verification.kind === "proved") {
          expect(execution.facts.verification.outcome).toBe("pass");
        }
        expect(execution.facts.attemptCensus.verification).toBe(1);
      } else {
        expect(execution.facts.verification.kind).toBe("not-run");
        expect(execution.facts.resolved).toBe(false);
      }
    }
  });
});
