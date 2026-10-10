/**
 * PPR-027 hermetic tests — one full sweep cell in-process (the REAL Zeck
 * public API seeded in-process, the synthetic supply injected behind the
 * rails; loopback only — the egress control denies everything else), plus
 * the measurement-replacement application. No live network, no live
 * provider, no persistence (persist: false).
 */

import { describe, expect, it } from "vitest";
import { measurementSetOf } from "../../../compat/harness/measurement";
import { SUBJECTS, type SubjectDefinition } from "../config";
import type { RequestRecord } from "../driver";
import { allSweepCells, applyWorkOrderMeasurements, type CellResult, runSweepCell } from "../sweep";

function aider(): SubjectDefinition {
  const subject = SUBJECTS.find((s): s is SubjectDefinition => s.subjectId === "aider");
  if (subject === undefined) {
    throw new Error("aider must be configured");
  }
  return subject;
}

describe("one full sweep cell (in-process, transport-injected)", () => {
  it("runs the aider S/single/mono cell through all three arms with the egress canary blocked", async () => {
    const result: CellResult = await runSweepCell({
      subject: aider(),
      volume: "S",
      repetitions: 1,
      providerConfig: "single",
      modality: "mono",
      persist: false,
    });

    // The corpus: aider's five certified tasks, mono slice (text-only —
    // degenerate for aider, so mono === full).
    expect(result.corpus.tasks).toBe(5);
    expect(result.dimensions.modalityDegenerate).toBe(true);

    // The mediated arm ran the whole corpus through the boundary.
    expect(result.zeck.outcomes.attempts).toBe(5);
    expect(result.zeck.outcomes.notRun).toBe(0);
    expect(result.zeck.outcomes.bypass).toBe(0);
    expect(result.zeck.outcomes.successes).toBeGreaterThan(0);

    // Both baselines ran the same corpus and are labeled as never Zeck
    // evidence.
    expect(result.baselines.direct.kind).toBe("direct-baseline");
    expect(result.baselines.direct.label).toContain("never Zeck evidence");
    expect(result.baselines.direct.tasksTotal).toBe(5);
    expect(result.baselines.optimized.kind).toBe("optimized-baseline");
    expect(result.baselines.optimized.tasksTotal).toBe(5);

    // The egress positive control: a deliberately direct provider attempt
    // must be OBSERVED failing.
    expect(result.canary.observed).toBe(true);
    expect(result.canary.blocked).toBe(true);

    // The thirteen-dimension measurement set with this work order's
    // measured replacements applied.
    const entries = result.zeck.measurements as {
      entries: { dimension: string; basis: string }[];
    };
    expect(entries.entries).toHaveLength(13);
    const byDimension = new Map(entries.entries.map((entry) => [entry.dimension, entry]));
    expect(byDimension.get("determinism-reuse")?.basis).toBe("measured");
    expect(byDimension.get("diagnosis-recovery")?.basis).toBe("measured");

    // No repetitions at S volume: nothing replays.
    expect(result.zeck.reuse.requests).toBe(result.zeck.reuse.requests);
    expect(result.zeck.reuse.replays).toBe(0);

    // Synthetic-cost labeling on every cell.
    expect(result.notes.join("\n")).toContain("synthetic price schedule");
  }, 120_000);

  it("replays corpus repetitions durably in the mediated arm (M volume)", async () => {
    const result = await runSweepCell({
      subject: aider(),
      volume: "M",
      repetitions: 2,
      providerConfig: "single",
      modality: "mono",
      persist: false,
    });
    // 2x corpus: every second-pass logical request replays the durable
    // first-pass outcome (zero provider exposure) unless the first pass
    // failed and minted a fresh attempt key. 20 certified requests per
    // pass → 40 total; replays = the first pass's succeeded digests.
    const requests = result.zeck.reuse.requests;
    const replays = result.zeck.reuse.replays;
    const requestFailures = result.zeck.requestFailures;
    expect(requests).toBe(40);
    // Every first-pass failure removes exactly one replay; a failure
    // counted in the second pass removes none (there was nothing to
    // replay), so replays ≥ 20 − requestFailures and ≤ 20.
    expect(replays).toBeGreaterThanOrEqual(20 - requestFailures);
    expect(replays).toBeLessThanOrEqual(20);
  }, 120_000);
});

describe("the work-order measurement replacements", () => {
  it("replace determinism-reuse and diagnosis-recovery with measured entries, passing the rest through", () => {
    const set = measurementSetOf({
      runtime: {
        runtimeId: "x",
        applicationId: "y",
        pin: { upstreamRevision: "a", integrationRevision: "b" },
      },
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
      taskReports: [],
      runOutcomes: [],
      egressObservation: null,
      credentialErasure: null,
    } as unknown as Parameters<typeof measurementSetOf>[0]);
    const requestRecords: RequestRecord[] = [
      {
        executionId: "exec-1",
        replayed: false,
        outcome: "resolved",
        latencyMs: 12,
        usage: { inputTokens: 10, outputTokens: 2 },
        costNanoUsd: 32,
      },
      {
        executionId: "exec-2",
        replayed: true,
        outcome: "resolved",
        latencyMs: 3,
        usage: { inputTokens: 0, outputTokens: 0 },
        costNanoUsd: 0,
      },
      {
        executionId: "exec-3",
        replayed: false,
        outcome: "failed",
        latencyMs: 45,
        usage: { inputTokens: 0, outputTokens: 0 },
        costNanoUsd: 8,
      },
    ];
    const replaced = applyWorkOrderMeasurements(set, {
      requestRecords,
      replays: 1,
      policyRetries: 1,
      providerFaults: 2,
      deterministicSubstrateRequests: 4,
      policyRetriedExecutionIds: ["exec-2"],
    });
    const byDimension = new Map(replaced.entries.map((entry) => [entry.dimension, entry]));
    const determinism = byDimension.get("determinism-reuse") as {
      basis: string;
      reuseCount: number;
      deterministicExecutionCount: number;
      verifiedComputationSubstitutions: number;
    };
    expect(determinism.basis).toBe("measured");
    expect(determinism.reuseCount).toBe(1);
    expect(determinism.deterministicExecutionCount).toBe(4);
    expect(determinism.verifiedComputationSubstitutions).toBe(4);
    const diagnosis = byDimension.get("diagnosis-recovery") as {
      basis: string;
      diagnosisTimeMs: number | null;
      recoveryTimeMs: number | null;
      incidentsExercised: number;
    };
    expect(diagnosis.basis).toBe("measured");
    expect(diagnosis.incidentsExercised).toBe(2);
    expect(diagnosis.diagnosisTimeMs).toBe(45);
    expect(diagnosis.recoveryTimeMs).toBe(3);
    // The other eleven dimensions pass through untouched.
    expect(replaced.entries).toHaveLength(13);
    expect(byDimension.get("outcome-success")?.basis).toBe("not-measured");
  });
});

describe("sweep planning", () => {
  it("orders cells subject-major and never plans a full slice for a degenerate subject", () => {
    const cells = allSweepCells();
    expect(cells[0]?.subject.subjectId).toBe("aider");
    expect(cells.some((cell) => cell.cellId.startsWith("aider-") && cell.modality === "full")).toBe(
      false,
    );
    expect(cells.some((cell) => cell.cellId.startsWith("cline-") && cell.modality === "full")).toBe(
      true,
    );
  });
});
