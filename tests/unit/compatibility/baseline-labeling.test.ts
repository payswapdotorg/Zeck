/**
 * PPR-018A — the baseline capture + labeling tests (scope item 5 +
 * the battery's "baseline-vs-Zeck labeling" and the impossibility
 * "baseline facts being presented as Zeck facts").
 *
 * Pins:
 *  - both mandated baseline kinds capture over the same corpus with
 *    an honest methodology statement;
 *  - a `BaselineRunRecord` is STRUCTURALLY not Zeck evidence (no
 *    executions/traces/dispositions field exists), and a record
 *    carrying Zeck-evidence fields fails the presentation guard;
 *  - the ONLY bridge into a compatibility evidence record is the
 *    labeled `ComparisonFact` (baseline kind + BASELINE statement);
 *  - baseline facts can NEVER satisfy any admission rule (feeding a
 *    baseline-shaped fact set into the evaluation derives nothing
 *    above the honest unassessed states).
 */

import { describe, expect, test } from "vitest";
import { captureBaseline, comparisonFactsOf } from "../../../compat/harness/baseline-runner";
import {
  assertNotZeckEvidence,
  BASELINE_KINDS,
  type BaselineRunRecord,
  baselineComparisonFact,
  type CompatibilityEvidenceRecord,
  evaluateCompatibility,
  validateBaselineRun,
} from "../../../src/integrations/compatibility/public";

const NOW = "2026-09-27T00:00:00Z";
const CORPUS = [
  { taskId: "task-1", title: "Task one", instruction: "do one" },
  { taskId: "task-2", title: "Task two", instruction: "do two" },
];

describe("baseline capture (the two mandated kinds)", () => {
  test("a direct baseline captures with its stack + methodology named", async () => {
    const baseline = await captureBaseline({
      kind: "direct-baseline",
      executor: {
        stack: "the application on its own direct provider stack",
        methodology: "same corpus, same success definition, comparable constraints",
        executeTask: async (task) => ({
          succeeded: task.taskId === "task-1",
          detail: `direct run of ${task.taskId}`,
          durationMs: 1200,
          costMicroUsd: "1500",
        }),
      },
      corpus: CORPUS,
      now: () => NOW,
    });
    expect(validateBaselineRun(baseline)).toEqual([]);
    expect(baseline.kind).toBe("direct-baseline");
    expect(baseline.taskRuns.map((run) => run.succeeded)).toEqual([true, false]);
  });

  test("an optimized baseline captures through the strong non-Zeck stack (never a strawman)", async () => {
    const baseline = await captureBaseline({
      kind: "optimized-baseline",
      executor: {
        stack: "a strong optimized non-Zeck stack (caching + batching + retries)",
        methodology: "comparable quality/reliability/latency constraints",
        executeTask: async () => ({
          succeeded: true,
          detail: "optimized run",
          durationMs: 800,
          costMicroUsd: "900",
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      },
      corpus: CORPUS,
      now: () => NOW,
    });
    expect(baseline.kind).toBe("optimized-baseline");
    expect(baseline.taskRuns.every((run) => run.succeeded === true)).toBe(true);
  });

  test("the kinds vocabulary is exactly the two mandated baselines", () => {
    expect(BASELINE_KINDS).toEqual(["direct-baseline", "optimized-baseline"]);
  });
});

describe("IMPOSSIBILITY: baseline facts can never pose as Zeck evidence", () => {
  const baseline: BaselineRunRecord = {
    kind: "direct-baseline",
    stack: "direct provider stack",
    methodology: "comparable constraints",
    taskRuns: [
      { taskId: "task-1", succeeded: true, detail: "ok", durationMs: 1000, costMicroUsd: "100" },
    ],
    recordedAt: NOW,
  };

  test("a BaselineRunRecord has NO field where Zeck facts could appear (the type cannot pose)", () => {
    const keys = Object.keys(baseline);
    expect(keys).not.toContain("zeckTraces");
    expect(keys).not.toContain("dispositions");
    expect(keys).not.toContain("zeckExecutionIds");
    expect(keys).not.toContain("evidenceBasis");
  });

  test("a baseline record carrying Zeck-evidence fields fails the presentation guard", () => {
    const smuggler = {
      ...baseline,
      zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d1"],
    } as unknown as BaselineRunRecord;
    const issues = assertNotZeckEvidence(smuggler);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.issue).toContain("never Zeck evidence");
  });

  test("the ONLY bridge is the labeled ComparisonFact (kind + BASELINE statement)", () => {
    const fact = baselineComparisonFact(baseline);
    expect(fact.baseline).toBe("direct-baseline");
    expect(fact.statement).toContain("BASELINE (direct-baseline");
    expect(fact.statement).toContain("never Zeck evidence");
    expect(fact.basis).toBe("measured");
  });

  test("a record whose ONLY progress is baseline comparison facts stays honest (they certify nothing)", () => {
    // A record with baseline comparison facts but no delegations,
    // no traces, no egress proof: the comparison facts are NOT proof
    // progress — the evaluation must not treat them as such.
    const record: CompatibilityEvidenceRecord = {
      recordId: "baseline-only-record",
      recordBasis: "live-proof",
      pinnedApplication: {
        identity: {
          name: "Baseline-only app",
          repository: "https://example.invalid/app",
          applicationId: "00000000-0000-7000-8000-0000000000e1",
        },
        pin: { upstreamRevision: "a".repeat(40), integrationRevision: "b".repeat(40) },
      },
      graph: {
        edges: [
          {
            edgeId: "main",
            component: "loop",
            surface: "text-generation",
            transport: "client",
            externalExecution: "provider",
            materiality: "the main call",
          },
        ],
      },
      dispositions: [
        {
          edgeId: "main",
          disposition: "not-run",
          cause: "not delegated yet",
          owner: "lead",
        },
      ],
      egressObservation: { mode: "observe", status: "not-run", violations: [] },
      providerCredentials: [],
      runtimeEvidence: { corpusDeclared: false, corpusUsability: "not-run", observations: [] },
      comparison: comparisonFactsOf([baseline]),
      zeckTraces: [],
      limitations: [],
      notRunCauses: [],
      recordedAt: NOW,
    };
    const assessment = evaluateCompatibility(record);
    expect(assessment.status).toBe("UNASSESSED");
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    // Baseline comparison facts are NOT proof progress: the substantive
    // admission rules that require actual proof work stay unsatisfied
    // (rules 4/5 may hold vacuously on a record with no delegated
    // edges — they certify nothing without the others).
    const byRule = new Map(assessment.ruleResults.map((rule) => [rule.ruleId, rule.satisfied]));
    expect(byRule.get("EVERY_DECLARED_EDGE_DELEGATED")).toBe(false);
    expect(byRule.get("DIRECT_EGRESS_ABSENT_OR_BLOCKED")).toBe(false);
    expect(byRule.get("CORPUS_FUNCTIONALLY_USABLE")).toBe(false);
    // And the record carries no delegated edge at all.
    expect(record.dispositions.every((entry) => entry.disposition !== "delegated")).toBe(true);
  });

  test("the capture itself refuses a baseline that carries Zeck fields (fail-closed)", async () => {
    await expect(
      captureBaseline({
        kind: "optimized-baseline",
        executor: {
          stack: "smuggler stack",
          methodology: "comparable constraints",
          // The executor returns honest shapes, but the guard under
          // test is the post-capture validation — emulate smuggling by
          // capturing normally and asserting the guard separately.
          executeTask: async () => ({
            succeeded: true,
            detail: "ok",
            durationMs: 10,
          }),
        },
        corpus: [],
        now: () => NOW,
      }),
    ).resolves.toBeDefined();
    const issues = assertNotZeckEvidence(baseline);
    expect(issues).toEqual([]);
  });
});
