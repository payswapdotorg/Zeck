/**
 * The validation recorder (VAL-004, acceptance criteria 1, 3, 7).
 *
 * Accumulates one run's trajectory, environment state, latency and
 * cost facts; every incoming value passes the redaction engine
 * (criterion 6); sealing produces an IMMUTABLE record whose content
 * digest pins it; corrections seal a NEW revision (append-only — the
 * historical record stays reproducible). The recorder also absorbs the
 * VAL-002 harness evidence directly: one run recorded through the
 * harness needs zero manual event plumbing.
 */

import { createHash } from "node:crypto";
import type { HarnessEvidence } from "../harness/evidence";
import type { RunMetadata } from "../run-identity";
import { deriveRunId } from "../run-identity";
import type { TelemetryGap, TrajectoryEvent, TrajectoryEventKind } from "./events";
import type {
  CostFact,
  EnvironmentStateObservation,
  LatencyFact,
  RunLinkage,
  ValidationRunRecord,
} from "./record";
import { linkageFromRunMetadata } from "./record";
import { redactDeep } from "./redact";

/** Builder for one validation run record. */
export class ValidationRecorder {
  private readonly metadata: RunMetadata;
  private readonly corpusTaskId: string;
  private readonly environmentIdentity: string;
  private events: TrajectoryEvent[] = [];
  private environmentState: EnvironmentStateObservation[] = [];
  private latency: LatencyFact[] = [];
  private cost: CostFact[] = [];
  private gaps: TelemetryGap[] = [];
  private nextSequence = 0;
  private started = false;
  private ended = false;

  constructor(input: {
    readonly metadata: RunMetadata;
    readonly corpusTaskId: string;
    readonly environmentIdentity: string;
  }) {
    this.metadata = input.metadata;
    this.corpusTaskId = input.corpusTaskId;
    this.environmentIdentity = input.environmentIdentity;
  }

  /** Record one trajectory event (deep-redacted; sequence assigned). */
  recordEvent(
    kind: TrajectoryEventKind,
    data: Readonly<Record<string, unknown>>,
    at?: string,
  ): this {
    if (kind === "run-start" && this.started) {
      throw new Error("run-start may be recorded exactly once");
    }
    if (kind === "run-end" && this.ended) {
      throw new Error("run-end may be recorded exactly once");
    }
    if (kind === "run-start") {
      this.started = true;
    }
    if (kind === "run-end") {
      this.ended = true;
    }
    this.events.push({
      kind,
      sequence: this.nextSequence,
      at: at ?? new Date().toISOString(),
      data: redactDeep({ ...data }),
    });
    this.nextSequence += 1;
    return this;
  }

  /** Record a resulting environment-state observation. */
  recordEnvironmentState(observation: EnvironmentStateObservation): this {
    this.environmentState.push(redactDeep({ ...observation }));
    return this;
  }

  /** Attach a latency fact. */
  recordLatency(fact: LatencyFact): this {
    this.latency.push({ ...fact });
    return this;
  }

  /** Attach a cost fact (estimate vs measured, never conflated). */
  recordCost(fact: CostFact): this {
    this.cost.push({ ...fact });
    return this;
  }

  /** Declare a telemetry gap (the honest boundary). */
  declareGap(gap: TelemetryGap): this {
    this.gaps.push(redactDeep({ ...gap }));
    return this;
  }

  /** Seal the record: immutable, content-digested (revision 1). */
  seal(sealedAt?: string): ValidationRunRecord {
    return this.sealRevision(1, sealedAt);
  }

  /**
   * Seal a revision N record. Revision 1 is the original seal; higher
   * revisions are CORRECTIONS (the recorder re-seals its state with a
   * bumped revision — historical revisions remain in the store).
   */
  sealRevision(revision: number, sealedAt?: string): ValidationRunRecord {
    if (!this.started || !this.ended) {
      throw new Error("cannot seal before run-start and run-end are recorded");
    }
    const record: ValidationRunRecord = {
      runId: deriveRunId(this.metadata),
      revision,
      sealedAt: sealedAt ?? new Date().toISOString(),
      linkage: this.linkage(),
      trajectory: [...this.events],
      environmentState: [...this.environmentState],
      latency: [...this.latency],
      cost: [...this.cost],
      telemetryGaps: [...this.gaps],
      digest: "",
    };
    const digest = digestOf(record);
    return Object.freeze({ ...record, digest });
  }

  /**
   * Absorb the VAL-002 harness evidence: the completion timeline,
   * surfaced errors, assertions, timings and result digest become
   * trajectory events and facts with zero manual plumbing.
   */
  absorbHarnessEvidence(evidence: HarnessEvidence): this {
    this.recordEvent("run-start", {
      corpusTask: evidence.request?.taskKind ?? "unknown",
      idempotencyKey: evidence.request?.idempotencyKey ?? "unknown",
      integrationSurface: evidence.integrationSurface,
    });
    for (const observation of evidence.timeline) {
      this.recordEvent(
        "substrate-readiness",
        {
          substrateId: "public-api",
          state: observation.status,
          observedAt: observation.at,
        },
        observation.at,
      );
    }
    for (const error of evidence.errors) {
      this.recordEvent(
        "error-surfaced",
        {
          code: error.code,
          status: error.status,
          retryable: error.retryable,
          message: error.message,
        },
        error.at,
      );
    }
    if (evidence.resultDigest !== null) {
      this.recordEvent("output-produced", { artifactId: evidence.resultDigest });
    }
    for (const verdict of evidence.assertions) {
      this.recordEvent("verification", {
        status: verdict.passed ? "PASS" : "FAIL",
        strategy: "harness-assertion",
        criterion: verdict.name,
        detail: verdict.detail,
      });
    }
    if (evidence.timings.submitMs !== null) {
      this.recordLatency({
        phase: "submit",
        source: "harness-wallclock",
        milliseconds: evidence.timings.submitMs,
      });
    }
    if (evidence.timings.completionMs !== null) {
      this.recordLatency({
        phase: "completion",
        source: "harness-wallclock",
        milliseconds: evidence.timings.completionMs,
      });
    }
    if (evidence.timings.retrievalMs !== null) {
      this.recordLatency({
        phase: "retrieval",
        source: "harness-wallclock",
        milliseconds: evidence.timings.retrievalMs,
      });
    }
    this.recordLatency({
      phase: "total",
      source: "harness-wallclock",
      milliseconds: evidence.timings.totalMs,
    });
    this.recordEvent("run-end", {
      terminalStatus: evidence.terminalStatus ?? "TIMEOUT",
    });
    return this;
  }

  private linkage(): RunLinkage {
    return linkageFromRunMetadata(this.metadata, this.corpusTaskId, this.environmentIdentity);
  }
}

/** Deterministic content digest of a (pre-seal) record. */
function digestOf(record: Omit<ValidationRunRecord, "digest">): string {
  const canonical = canonicalJson({
    runId: record.runId,
    revision: record.revision,
    linkage: record.linkage,
    trajectory: record.trajectory,
    environmentState: record.environmentState,
    latency: record.latency,
    cost: record.cost,
    telemetryGaps: record.telemetryGaps,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
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
