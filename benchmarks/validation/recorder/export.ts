/**
 * Export and longitudinal diffing (VAL-004, acceptance criterion 8).
 *
 * The export format is canonical JSON (sorted keys, stable shape) —
 * byte-stable for the same record, diffable across runs. The dataset
 * export flattens latest revisions into an analysis-ready array with
 * per-run economic roll-ups. The trajectory diff compares two runs'
 * event streams event-by-event (added/removed/changed) — the primitive
 * the deterministicization experiments (VAL-031) consume.
 */

import { type ReconstructedDecision, reconstructTimeline } from "./events";
import type { ValidationRunRecord } from "./record";

/** A canonical, byte-stable export of one run record. */
export function exportRecord(record: ValidationRunRecord): string {
  return canonicalJson(record);
}

/** The analysis dataset: latest revisions with economic roll-ups. */
export interface RunDatasetEntry {
  readonly runId: string;
  readonly revision: number;
  readonly linkage: ValidationRunRecord["linkage"];
  readonly measuredCostMicroUsd: string;
  readonly estimatedCostMicroUsd: string;
  readonly totalLatencyMs: number | null;
  readonly environmentEffectsPassed: number;
  readonly environmentEffectsTotal: number;
  readonly trajectoryEventCount: number;
  readonly telemetryGapCount: number;
}

/** Build the analysis dataset from latest revisions. */
export function exportDataset(records: readonly ValidationRunRecord[]): readonly RunDatasetEntry[] {
  return records.map((record) => {
    const measured = sumMicroUsd(record.cost.filter((fact) => fact.kind === "measured"));
    const estimated = sumMicroUsd(record.cost.filter((fact) => fact.kind === "estimate"));
    const total = record.latency.find(
      (fact) => fact.phase === "total" && fact.source === "harness-wallclock",
    );
    return {
      runId: record.runId,
      revision: record.revision,
      linkage: record.linkage,
      measuredCostMicroUsd: measured,
      estimatedCostMicroUsd: estimated,
      totalLatencyMs: total?.milliseconds ?? null,
      environmentEffectsPassed: record.environmentState.filter((o) => o.passed).length,
      environmentEffectsTotal: record.environmentState.length,
      trajectoryEventCount: record.trajectory.length,
      telemetryGapCount: record.telemetryGaps.length,
    };
  });
}

/** One trajectory difference between two runs. */
export interface TrajectoryDiffEntry {
  readonly kind: "added" | "removed" | "changed";
  readonly sequence: number;
  readonly detail: string;
}

/**
 * Diff two runs' trajectories (event-level). Added/removed events are
 * reported by sequence position; changed events report the field that
 * differs. This is the primitive for repeated-workload replay
 * analysis (VAL-031) and root-cause timelines.
 */
export function diffTrajectory(
  baseline: ValidationRunRecord,
  candidate: ValidationRunRecord,
): readonly TrajectoryDiffEntry[] {
  const diffs: TrajectoryDiffEntry[] = [];
  const baselineBySequence = new Map(baseline.trajectory.map((event) => [event.sequence, event]));
  const candidateBySequence = new Map(candidate.trajectory.map((event) => [event.sequence, event]));
  for (const [sequence, event] of candidateBySequence) {
    const before = baselineBySequence.get(sequence);
    if (before === undefined) {
      diffs.push({ kind: "added", sequence, detail: `${event.kind} @${event.at}` });
    } else if (canonicalJson(before) !== canonicalJson(event)) {
      const changedFields: string[] = [];
      const beforeData = before.data as Record<string, unknown>;
      const afterData = event.data as Record<string, unknown>;
      for (const key of new Set([...Object.keys(beforeData), ...Object.keys(afterData)])) {
        if (canonicalJson(beforeData[key]) !== canonicalJson(afterData[key])) {
          changedFields.push(key);
        }
      }
      if (before.kind !== event.kind) {
        changedFields.push("(kind)");
      }
      diffs.push({
        kind: "changed",
        sequence,
        detail: `${event.kind}: ${changedFields.join(", ")}`,
      });
    }
  }
  for (const [sequence, event] of baselineBySequence) {
    if (!candidateBySequence.has(sequence)) {
      diffs.push({ kind: "removed", sequence, detail: `${event.kind} @${event.at}` });
    }
  }
  return diffs.sort((left, right) => left.sequence - right.sequence);
}

/** The reconstructed decision timelines of both runs (for reports). */
export function timelinesOf(
  baseline: ValidationRunRecord,
  candidate: ValidationRunRecord,
): {
  readonly baseline: readonly ReconstructedDecision[];
  readonly candidate: readonly ReconstructedDecision[];
} {
  return {
    baseline: reconstructTimeline(baseline.trajectory),
    candidate: reconstructTimeline(candidate.trajectory),
  };
}

function sumMicroUsd(facts: readonly { amountMicroUsd: string }[]): string {
  let total = 0;
  for (const fact of facts) {
    total += Number.parseInt(fact.amountMicroUsd, 10);
  }
  return String(total);
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
