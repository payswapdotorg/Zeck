/**
 * VAL-004 acceptance criteria: identity (1), linkage (2), trajectory
 * reconstruction (3), environment state as effects not claims (4),
 * cost separation (5), enforced redaction (6), append-only revisions
 * (7), export + diff (8). Discrimination tests weaken each guarantee
 * and prove the recorder rejects it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness";
import {
  containsSecretShaped,
  diffTrajectory,
  exportDataset,
  exportRecord,
  findResidualSecrets,
  InMemoryRunRecordStore,
  JsonlRunRecordStore,
  REDACTED,
  reconstructTimeline,
  redactDeep,
  ValidationRecorder,
  type ValidationRunRecord,
  validateRunRecord,
} from "../../../benchmarks/validation/recorder";
import { deriveRunId, type RunMetadata } from "../../../benchmarks/validation/run-identity";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";

const metadata: RunMetadata = {
  program: "zeck-validation",
  workOrder: "VAL-004",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-corpus.1.0.0",
  integrationSurface: "sdk",
  environment: {
    runtime: "bun",
    toolchain: "vitest",
    database: "postgresql",
    configuration: { corpusTask: "text.summarize-doc.v1#000" },
  },
  observedAt: "2026-09-11T21:30:00.000Z",
};

const harnessEvidence: HarnessEvidence = {
  runId: deriveRunId(metadata),
  program: "zeck-validation",
  workOrder: "VAL-004",
  baseRevision: REVISION,
  applicationRevision: REVISION,
  corpusRevision: "val-corpus.1.0.0",
  integrationSurface: "sdk",
  request: { taskKind: "summarize", idempotencyKey: "k-1", constraints: null },
  timeline: [
    { at: "2026-09-11T21:30:00.100Z", status: "CREATED" },
    { at: "2026-09-11T21:30:00.300Z", status: "RUNNING" },
    { at: "2026-09-11T21:30:00.500Z", status: "COMPLETED" },
  ],
  terminalStatus: "COMPLETED",
  resultDigest: `sha256:${"a".repeat(64)}`,
  verificationStatuses: ["PASS"],
  errors: [],
  assertions: [{ name: "terminal-status", passed: true, detail: "ok" }],
  timings: { submitMs: 100, completionMs: 400, retrievalMs: 20, totalMs: 520 },
};

function sealedRun(): ValidationRunRecord {
  return new ValidationRecorder({
    metadata,
    corpusTaskId: "text.summarize-doc.v1#000",
    environmentIdentity: "local-pg-16",
  })
    .recordEvent("model-choice", { modelId: "neutral-model-a", purpose: "summarize" })
    .recordEvent("tool-exposed", { toolId: "calculator", grant: "read" })
    .recordEvent("tool-invoked", { toolId: "calculator", attempt: 1 })
    .recordEvent("context-event", { operation: "window-append", tokens: 1200 })
    .recordEvent("cache-event", { operation: "lookup", hit: false })
    .recordEvent("agent-count", { count: 1 })
    .recordEvent("substrate-readiness", { substrateId: "public-api", state: "ready" })
    .recordEvent("retry", { reason: "transient-503" })
    .recordEvent("escalation", { level: "planner", reason: "capability-miss" })
    .recordEvent("verification", { status: "PASS", strategy: "deterministic" })
    .recordEvent("output-produced", { artifactId: `sha256:${"a".repeat(64)}` })
    .recordEvent("run-start", { corpusTask: "summarize" })
    .recordEvent("run-end", { terminalStatus: "COMPLETED" })
    .recordEnvironmentState({
      kind: "artifact-created",
      assertion: "one output artifact recorded",
      observedVia: "artifact-store",
      passed: true,
    })
    .recordLatency({ phase: "total", source: "harness-wallclock", milliseconds: 520 })
    .recordCost({
      kind: "measured",
      amountMicroUsd: "1500",
      source: "ledger",
      scope: "direct-execution",
    })
    .recordCost({
      kind: "estimate",
      amountMicroUsd: "900",
      source: "planner-quote",
      scope: "direct-execution",
    })
    .seal();
}

describe("validation: recorder identity, linkage and trajectory (VAL-004 AC1/2/3)", () => {
  test("a complete record validates and carries the derived identity", () => {
    const record = sealedRun();
    expect(validateRunRecord(record)).toEqual([]);
    expect(record.runId).toMatch(/^val-run-[0-9a-f]{64}$/);
    expect(record.linkage.corpusVersion).toBe("val-corpus.1.0.0");
    expect(record.linkage.corpusTaskId).toBe("text.summarize-doc.v1#000");
    expect(record.linkage.environmentIdentity).toBe("local-pg-16");
  });

  test("the trajectory reconstructs into an ordered decision timeline (AC3)", () => {
    const record = sealedRun();
    const timeline = reconstructTimeline(record.trajectory);
    expect(timeline.length).toBe(record.trajectory.length);
    const sequences = timeline.map((entry) => entry.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(timeline.some((entry) => entry.summary.includes("model neutral-model-a"))).toBe(true);
    expect(timeline.some((entry) => entry.summary.includes("tool calculator invoked"))).toBe(true);
    expect(timeline.some((entry) => entry.summary.includes("retry after transient-503"))).toBe(
      true,
    );
  });

  test("sealing requires run-start and run-end (discrimination)", () => {
    const recorder = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    });
    expect(() => recorder.seal()).toThrow(/run-start and run-end/);
  });

  test("run-start/run-end are exactly-once events (discrimination)", () => {
    const recorder = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    });
    recorder.recordEvent("run-start", { corpusTask: "x" });
    expect(() => recorder.recordEvent("run-start", { corpusTask: "x" })).toThrow(/exactly once/);
  });

  test("a record missing linkage fields is rejected (discrimination)", () => {
    const record = sealedRun();
    const broken = {
      ...record,
      linkage: { ...record.linkage, corpusVersion: "" },
    } as ValidationRunRecord;
    expect(validateRunRecord(broken).some((v) => v.path === "linkage.corpusVersion")).toBe(true);
  });
});

describe("validation: environment state and cost separation (VAL-004 AC4/5)", () => {
  test("environment observations name their observation channel (not response claims)", () => {
    const record = sealedRun();
    for (const observation of record.environmentState) {
      expect(observation.observedVia).toMatch(/^(platform-ledger|artifact-store|harness-probe)$/);
    }
  });

  test("a response string posing as effect proof is rejected (discrimination)", () => {
    const record = sealedRun();
    const broken = {
      ...record,
      environmentState: [
        {
          kind: "effect",
          assertion: "the model said it wrote the file",
          observedVia: "response-text",
          passed: true,
        },
      ],
    } as unknown as ValidationRunRecord;
    expect(validateRunRecord(broken).some((v) => v.path === "environmentState[].observedVia")).toBe(
      true,
    );
  });

  test("an ESTIMATE total successful-resolution cost is rejected (discrimination)", () => {
    const record = sealedRun();
    const broken = {
      ...record,
      cost: [
        ...record.cost,
        {
          kind: "estimate",
          amountMicroUsd: "100",
          source: "quote",
          scope: "total-successful-resolution",
        },
      ],
    } as ValidationRunRecord;
    expect(validateRunRecord(broken).some((v) => v.reason.includes("MEASURED"))).toBe(true);
  });

  test("a float cost amount is rejected (micro-USD integer discipline)", () => {
    const record = sealedRun();
    const broken = {
      ...record,
      cost: [
        ...record.cost,
        { kind: "measured", amountMicroUsd: "1.5", source: "x", scope: "direct-execution" },
      ],
    } as ValidationRunRecord;
    expect(validateRunRecord(broken).some((v) => v.path === "cost[].amountMicroUsd")).toBe(true);
  });
});

describe("validation: enforced redaction (VAL-004 AC6)", () => {
  test("secret-shaped strings are redacted deeply wherever they hide", () => {
    const redacted = redactDeep({
      note: "token sk-or-v1-892d3157e3474c17aa16a0665453c86a in text",
      nested: { list: ["ghp_4TcbSopE1vxbsOSsAlL1Jpl6rFPLHj4L", "clean"] },
      struct: { apiKey: "abc123" },
    });
    expect(redacted.note).toContain(REDACTED);
    expect(redacted.note).not.toContain("sk-or-v1-892d");
    expect((redacted.nested.list as readonly string[])[0]).toBe(REDACTED);
    expect(redacted.struct.apiKey).toBe(REDACTED);
    expect(findResidualSecrets(redacted)).toEqual([]);
  });

  test("secret-shaped material in trajectory events is redacted at record time", () => {
    const recorder = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    });
    recorder.recordEvent("model-choice", {
      modelId: "m",
      note: "Bearer abcdefghijklmnopqrstuvwxyz123",
    });
    const events = recorder.recordEvent("run-start", {}).recordEvent("run-end", {});
    void events;
    // capture through seal on a throwaway recorder path
    const record = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    })
      .recordEvent("run-start", { credential: "gho_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })
      .recordEvent("run-end", {})
      .seal();
    expect(findResidualSecrets(record.trajectory)).toEqual([]);
    const start = record.trajectory.find((event) => event.kind === "run-start");
    expect(((start?.data ?? {}) as Record<string, unknown>).credential).toBe(REDACTED);
  });

  test("the residual scanner finds UNREDACTED secrets (the gate is real)", () => {
    expect(containsSecretShaped("key sk-ws-H.DMIPYHY.qe7Y.MEUCI stuff")).toBe(true);
    expect(
      findResidualSecrets({ deep: { token: "sk-or-v1-892d3157e3474c17aa16a0665453c86a3650c9" } }),
    ).toEqual(["$.deep.token"]);
  });

  test("redaction is idempotent and non-secret material survives", () => {
    const once = redactDeep({ token: "sk-proj-OYGAISHz4yTHlYxfAZy1LD123456" });
    const twice = redactDeep(once);
    expect(twice).toEqual(once);
    const clean = redactDeep({ model: "neutral-a", count: 3, note: "no secrets here" });
    expect(clean).toEqual({ model: "neutral-a", count: 3, note: "no secrets here" });
  });
});

describe("validation: append-only revisions and storage (VAL-004 AC7)", () => {
  test("sealed records are immutable (Object.freeze) with digests", () => {
    const record = sealedRun();
    expect(Object.isFrozen(record)).toBe(true);
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => {
      (record as unknown as { revision: number }).revision = 99;
    }).toThrow();
  });

  test("the store appends revisions only upward (discrimination)", () => {
    const store = new InMemoryRunRecordStore();
    const first = sealedRun();
    store.append(first);
    expect(() => store.append({ ...first, revision: 1 })).toThrow(/append-only violation/);
    const second = new ValidationRecorder({
      metadata,
      corpusTaskId: "text.summarize-doc.v1#000",
      environmentIdentity: "local-pg-16",
    })
      .recordEvent("run-start", { corpusTask: "summarize" })
      .recordEvent("run-end", { terminalStatus: "COMPLETED" })
      .sealRevision(2);
    store.append(second);
    expect(store.count()).toBe(2);
    expect(store.revisionsOf(first.runId)).toHaveLength(2);
    expect(store.latest(first.runId)?.revision).toBe(2);
  });

  test("an invalid record is rejected at the store gate (discrimination)", () => {
    const store = new InMemoryRunRecordStore();
    const invalid = { ...sealedRun(), runId: "not-a-run-id" } as ValidationRunRecord;
    expect(() => store.append(invalid)).toThrow(/invalid run record/);
  });

  test("the JSONL store persists and reloads append-only history", () => {
    const dir = mkdtempSync(join(tmpdir(), "zeck-recorder-"));
    try {
      const path = join(dir, "runs.jsonl");
      const store = new JsonlRunRecordStore(path);
      store.append(sealedRun());
      const reloaded = new JsonlRunRecordStore(path);
      expect(reloaded.count()).toBe(1);
      expect(reloaded.all()[0]?.runId).toBe(sealedRun().runId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validation: harness absorption, export and diff (VAL-004 AC8 + integration)", () => {
  test("the recorder absorbs VAL-002 harness evidence into a valid record", () => {
    const record = new ValidationRecorder({
      metadata,
      corpusTaskId: "text.summarize-doc.v1#000",
      environmentIdentity: "local-pg-16",
    })
      .absorbHarnessEvidence(harnessEvidence)
      .seal();
    expect(validateRunRecord(record)).toEqual([]);
    const kinds = record.trajectory.map((event) => event.kind);
    expect(kinds).toContain("run-start");
    expect(kinds).toContain("run-end");
    expect(kinds).toContain("substrate-readiness");
    expect(kinds).toContain("output-produced");
    expect(kinds).toContain("verification");
    expect(record.latency.find((f) => f.phase === "total")?.milliseconds).toBe(520);
  });

  test("the export is byte-stable for the same record", () => {
    const record = sealedRun();
    expect(exportRecord(record)).toBe(exportRecord(record));
  });

  test("the dataset roll-up separates measured from estimated cost", () => {
    const entry = exportDataset([sealedRun()])[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }
    expect(entry.measuredCostMicroUsd).toBe("1500");
    expect(entry.estimatedCostMicroUsd).toBe("900");
    expect(entry.totalLatencyMs).toBe(520);
    expect(entry.environmentEffectsPassed).toBe(1);
  });

  test("trajectory diff detects changed, added and removed events", () => {
    const baseline = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    })
      .recordEvent("run-start", { corpusTask: "x" })
      .recordEvent("model-choice", { modelId: "a", purpose: "p" })
      .recordEvent("run-end", { terminalStatus: "COMPLETED" })
      .seal();
    // candidate: model changed at the same position; a mid-run cache event
    // shifts run-end to a NEW tail position (reported as added); the
    // position-based diff reports the shifted position as changed-kind.
    const candidate = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    })
      .recordEvent("run-start", { corpusTask: "x" })
      .recordEvent("model-choice", { modelId: "b", purpose: "p" })
      .recordEvent("cache-event", { operation: "lookup", hit: true })
      .recordEvent("run-end", { terminalStatus: "COMPLETED" })
      .seal();
    const diffs = diffTrajectory(baseline, candidate);
    const changed = diffs.filter((d) => d.kind === "changed");
    const added = diffs.filter((d) => d.kind === "added");
    expect(changed.some((d) => d.detail.includes("modelId"))).toBe(true);
    expect(changed.some((d) => d.detail.includes("(kind)"))).toBe(true);
    expect(added.some((d) => d.detail.includes("run-end"))).toBe(true);
    // a strictly shorter candidate reports removals at the tail position
    const longerBaseline = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    })
      .recordEvent("run-start", { corpusTask: "x" })
      .recordEvent("model-choice", { modelId: "a", purpose: "p" })
      .recordEvent("retry", { reason: "transient-503" })
      .recordEvent("run-end", { terminalStatus: "COMPLETED" })
      .seal();
    const shorterCandidate = new ValidationRecorder({
      metadata,
      corpusTaskId: "x#001",
      environmentIdentity: "env",
    })
      .recordEvent("run-start", { corpusTask: "x" })
      .recordEvent("model-choice", { modelId: "a", purpose: "p" })
      .recordEvent("run-end", { terminalStatus: "COMPLETED" })
      .seal();
    const removals = diffTrajectory(longerBaseline, shorterCandidate).filter(
      (d) => d.kind === "removed",
    );
    expect(removals.length).toBe(1);
    expect(removals[0]?.detail.includes("run-end")).toBe(true);
  });
});
