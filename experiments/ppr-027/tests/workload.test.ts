/**
 * PPR-027 hermetic tests — the provenance law (workload derivation vs the
 * nine delivered records), the internal consistency of the workload model
 * and the sweep-matrix shape. No live network, no live provider.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODALITIES,
  modalityAxisDegenerate,
  PROVIDER_CONFIGS,
  requestsOfTask,
  SUBJECTS,
  type SubjectDefinition,
  VOLUMES,
} from "../config";
import { buildCellCorpus, requestDigestOf } from "../driver";
import { allSweepCells, cellIdOf } from "../sweep";

const REPO_ROOT = join(new URL(".", import.meta.url).pathname, "..", "..", "..");

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The record's certified request count, read from the subject's DECLARED
 * provenance anchor (the nine records carry it in different places — the
 * config declares where, this reads that exact location). */
function recordRequestCount(
  record: Json,
  basis:
    | "disposition-execution-ids"
    | "battery-corpus-edge-executions"
    | "resolved-corpus-narrative",
): number | null {
  if (basis === "disposition-execution-ids") {
    const dispositions = asArray(asObject(record.evidenceRecord)?.dispositions);
    const ids = dispositions.reduce((sum: number, entry) => {
      const object = asObject(entry);
      return sum + asArray(object?.zeckExecutionIds).length;
    }, 0);
    return ids === 0 ? null : ids;
  }
  if (basis === "battery-corpus-edge-executions") {
    const corpus = asArray(asObject(record.battery)?.corpus);
    const executions = corpus.reduce((sum: number, entry) => {
      const object = asObject(entry);
      return sum + asArray(object?.edgeExecutions).length;
    }, 0);
    return executions === 0 ? null : executions;
  }
  // resolved-corpus-narrative: "N edge executions; X input / Y output tokens"
  const match = /(\d+) edge executions; ([\d,]+) input \/ ([\d,]+) output tokens/.exec(
    JSON.stringify(record),
  );
  return match === null ? null : Number(match[1]);
}

/** The record's certified token totals, read from the subject's DECLARED
 * provenance anchor. The rail-reported-units form returns the combined
 * input+output total as a negative input (the record predates the split). */
function recordTokenTotals(
  record: Json,
  basis:
    | "measurements-usage-cost"
    | "battery-rail-usage-sums"
    | "resolved-corpus-narrative"
    | "rail-reported-units-sum",
): { inputTokens: number; outputTokens: number } | null {
  if (basis === "measurements-usage-cost") {
    const measurements =
      asObject(record.measurements) ?? asObject(asObject(record.battery)?.measurements);
    for (const entry of asArray(measurements?.entries)) {
      const object = asObject(entry);
      if (object?.dimension === "usage-cost") {
        const input = object.inputTokens;
        const output = object.outputTokens;
        if (typeof input === "number" && typeof output === "number") {
          return { inputTokens: input, outputTokens: output };
        }
      }
    }
    return null;
  }
  if (basis === "battery-rail-usage-sums") {
    const corpus = asArray(asObject(record.battery)?.corpus);
    let inputTokens = 0;
    let outputTokens = 0;
    for (const entry of corpus) {
      const usage = asObject(asObject(entry)?.railUsage);
      if (usage !== null) {
        inputTokens += Number(usage.inputTokens ?? 0);
        outputTokens += Number(usage.outputTokens ?? 0);
      }
    }
    return inputTokens === 0 && outputTokens === 0 ? null : { inputTokens, outputTokens };
  }
  if (basis === "resolved-corpus-narrative") {
    const match = /(\d+) edge executions; ([\d,]+) input \/ ([\d,]+) output tokens/.exec(
      JSON.stringify(record),
    );
    if (match === null) {
      return null;
    }
    return {
      inputTokens: Number((match[2] ?? "0").replace(/,/g, "")),
      outputTokens: Number((match[3] ?? "0").replace(/,/g, "")),
    };
  }
  // rail-reported-units-sum (PPR-018 predates the schemas): the combined
  // total in the cost-per-resolved-outcome narrative.
  const units = /(\d+) rail-reported units/.exec(JSON.stringify(record));
  return units === null ? null : { inputTokens: -Number(units[1]), outputTokens: 0 };
}

describe("the provenance law (workloads derived from the delivered records)", () => {
  for (const subject of SUBJECTS) {
    it(`${subject.subjectId}: certified totals are anchored to ${subject.evidenceRecord}`, () => {
      const path = join(REPO_ROOT, subject.evidenceRecord);
      expect(existsSync(path), `${path} must exist`).toBe(true);
      const record = JSON.parse(readFileSync(path, "utf8")) as Json;

      const requests = recordRequestCount(record, subject.requestCountBasis);
      expect(
        requests,
        `${subject.subjectId}: the record must carry its request count at ${subject.requestCountBasis}`,
      ).not.toBeNull();
      expect(subject.certifiedTotals.requests).toBe(requests);

      const tokens = recordTokenTotals(record, subject.tokenTotalsBasis);
      expect(
        tokens,
        `${subject.subjectId}: the record must carry its token totals at ${subject.tokenTotalsBasis}`,
      ).not.toBeNull();
      if (tokens === null || requests === null) {
        throw new Error("unreachable");
      }
      if (tokens.inputTokens < 0) {
        // The rail-reported units form: input + output together.
        expect(subject.certifiedTotals.inputTokens + subject.certifiedTotals.outputTokens).toBe(
          -tokens.inputTokens,
        );
      } else {
        expect(subject.certifiedTotals.inputTokens).toBe(tokens.inputTokens);
        expect(subject.certifiedTotals.outputTokens).toBe(tokens.outputTokens);
      }
    });
  }
});

describe("the workload model's internal consistency", () => {
  for (const subject of SUBJECTS) {
    it(`${subject.subjectId}: full-graph request/token sums equal the certified totals`, () => {
      let requests = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      for (const task of subject.tasks) {
        for (const request of requestsOfTask(subject, task, "full")) {
          requests += 1;
          inputTokens += request.inputTokens;
          outputTokens += request.outputTokens;
        }
      }
      expect(requests).toBe(subject.certifiedTotals.requests);
      expect(inputTokens).toBe(subject.certifiedTotals.inputTokens);
      expect(outputTokens).toBe(subject.certifiedTotals.outputTokens);
    });

    it(`${subject.subjectId}: the mono slice is a subset of the full graph`, () => {
      for (const task of subject.tasks) {
        const mono = requestsOfTask(subject, task, "mono");
        const full = requestsOfTask(subject, task, "full");
        expect(mono.length).toBeLessThanOrEqual(full.length);
        for (const request of mono) {
          expect(full).toContainEqual(request);
        }
      }
    });

    it(`${subject.subjectId}: every request's edgeId is a declared edge`, () => {
      const edgeIds = new Set(subject.edges.map((edge) => edge.edgeId));
      for (const task of subject.tasks) {
        for (const request of task.requests) {
          expect(edgeIds.has(request.edgeId), `${request.edgeId} must be declared`).toBe(true);
        }
      }
    });
  }
});

describe("the sweep matrix", () => {
  it("declares three volumes, two provider configurations and two modality slices", () => {
    expect(VOLUMES.map((v) => v.volume)).toEqual(["S", "M", "L"]);
    expect(PROVIDER_CONFIGS.map((p) => p.providerConfig)).toEqual(["single", "multi"]);
    expect(MODALITIES.map((m) => m.modality)).toEqual(["mono", "full"]);
  });

  it("plans exactly 102 cells (aider's modality axis is degenerate: 6 cells; the rest 12 each)", () => {
    const cells = allSweepCells();
    expect(cells).toHaveLength(102);
    const perSubject = new Map<string, number>();
    for (const cell of cells) {
      perSubject.set(cell.subject.subjectId, (perSubject.get(cell.subject.subjectId) ?? 0) + 1);
    }
    expect(perSubject.get("aider")).toBe(6);
    for (const [subjectId, count] of perSubject) {
      if (subjectId !== "aider") {
        expect(count, `${subjectId} should have 12 cells`).toBe(12);
      }
    }
  });

  it("marks exactly the text-only subjects degenerate on the modality axis", () => {
    const degenerate = SUBJECTS.filter(modalityAxisDegenerate).map((s) => s.subjectId);
    expect(degenerate).toEqual(["aider"]);
  });

  it("builds the corpus with repetitions and stable base identities", () => {
    const subject = SUBJECTS.find((s): s is SubjectDefinition => s.subjectId === "aider");
    if (subject === undefined) {
      throw new Error("aider must be configured");
    }
    const small = buildCellCorpus(subject, "mono", "S", 1);
    const large = buildCellCorpus(subject, "mono", "L", 4);
    expect(small).toHaveLength(subject.tasks.length);
    expect(large).toHaveLength(subject.tasks.length * 4);
    expect(
      large.filter((task) => task.rep === 2).every((task) => task.taskId.endsWith("#rep2")),
    ).toBe(true);
    // The repetition replays on the SAME logical identity (the digest covers
    // the base task, not the repetition label).
    const first = small[0];
    const secondRep = large.find((task) => task.baseTaskId === first?.baseTaskId && task.rep === 2);
    expect(secondRep).toBeDefined();
    expect(
      requestDigestOf(
        subject.subjectId,
        first?.baseTaskId ?? "",
        0,
        first?.requests[0] ?? { edgeId: "", inputTokens: 0, outputTokens: 0 },
      ),
    ).toBe(
      requestDigestOf(
        subject.subjectId,
        secondRep?.baseTaskId ?? "",
        0,
        secondRep?.requests[0] ?? { edgeId: "", inputTokens: 0, outputTokens: 0 },
      ),
    );
  });

  it("formats cell ids as subject-volume-provider-modality", () => {
    expect(cellIdOf("aider", "L", "single", "mono")).toBe("aider-L-single-mono");
  });
});
