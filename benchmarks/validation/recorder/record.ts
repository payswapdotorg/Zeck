/**
 * The universal validation run record (VAL-004, required run record +
 * acceptance criteria 1, 2, 4, 5, 7).
 *
 * One record captures ONE customer-style validation run end to end:
 * the immutable run identity, the linkage block (application revision,
 * Zeck revision, corpus/task identity, environment identity), the
 * trajectory events, the RESULTING ENVIRONMENT STATE (structured
 * effects — never a response string masquerading as effect proof),
 * latency facts, and cost facts with the estimate-vs-measured
 * separation. Records are append-only: a sealed record never mutates;
 * corrections produce a NEW revision (the old one stays readable for
 * historical reproducibility).
 */

import type { RunMetadata } from "../run-identity";
import type { TelemetryGap, TrajectoryEvent } from "./events";

/** A latency measurement (harness wall-clock vs platform ledger). */
export interface LatencyFact {
  readonly phase: "submit" | "completion" | "retrieval" | "total";
  readonly source: "harness-wallclock" | "platform-ledger";
  readonly milliseconds: number;
}

/**
 * A cost fact. ESTIMATES (provider or planner quotes) and MEASURED
 * charges (settled ledger facts) are SEPARATE kinds — they are never
 * conflated (criterion 5), and total successful-resolution cost is
 * computed only from measured facts plus declared accounting rules.
 */
export interface CostFact {
  readonly kind: "estimate" | "measured";
  /** Micro-USD integer string (the wire money discipline). */
  readonly amountMicroUsd: string;
  readonly source: string;
  readonly scope:
    | "direct-execution"
    | "retry-overhead"
    | "escalation-overhead"
    | "substrate"
    | "total-successful-resolution";
}

/** One resulting environment-state observation (criterion 4). */
export interface EnvironmentStateObservation {
  readonly kind: string;
  readonly assertion: string;
  /** How the effect was observed (never "the model said so"). */
  readonly observedVia: "platform-ledger" | "artifact-store" | "harness-probe";
  readonly passed: boolean;
}

/** The linkage block (criterion 2). */
export interface RunLinkage {
  readonly applicationRevision: string;
  readonly baseRevision: string;
  readonly corpusVersion: string;
  readonly corpusTaskId: string;
  readonly environmentIdentity: string;
}

/** A sealed (immutable) run record. */
export interface ValidationRunRecord {
  /** The stable, immutable run identity (VAL-001 derivation). */
  readonly runId: string;
  /** Append-only revision of this record (1 = original seal). */
  readonly revision: number;
  readonly sealedAt: string;
  readonly linkage: RunLinkage;
  readonly trajectory: readonly TrajectoryEvent[];
  readonly environmentState: readonly EnvironmentStateObservation[];
  readonly latency: readonly LatencyFact[];
  readonly cost: readonly CostFact[];
  /** Declared telemetry gaps (the honest boundary). */
  readonly telemetryGaps: readonly TelemetryGap[];
  /** Deterministic digest of the sealed content (revision-scoped). */
  readonly digest: string;
}

/** One record rejection finding. */
export interface RunRecordViolation {
  readonly path: string;
  readonly reason: string;
}

const RUN_ID_SHAPE = /^val-run-[0-9a-f]{64}$/;
const MICRO_USD = /^\d+$/;

/**
 * Validate a sealed run record against the contract: identity shape,
 * positive revision, complete linkage, ordered non-empty trajectory,
 * structured environment observations (each with an observation
 * channel — a bare response string is not effect proof), non-negative
 * latency, cost amounts as micro-USD integers with the estimate /
 * measured separation, and no measured total computed from estimates.
 */
export function validateRunRecord(record: ValidationRunRecord): readonly RunRecordViolation[] {
  const violations: RunRecordViolation[] = [];
  const fail = (path: string, reason: string): void => {
    violations.push({ path, reason });
  };
  const requireText = (path: string, value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) {
      fail(path, "must be a non-empty string");
    }
  };

  if (typeof record?.runId !== "string" || !RUN_ID_SHAPE.test(record.runId)) {
    fail("runId", "must carry the derived val-run-<sha256> identity");
  }
  if (!Number.isInteger(record?.revision) || (record?.revision ?? 0) < 1) {
    fail("revision", "must be a positive integer (append-only revisions)");
  }
  requireText("sealedAt", record?.sealedAt);

  const linkage = record?.linkage;
  requireText("linkage.applicationRevision", linkage?.applicationRevision);
  requireText("linkage.baseRevision", linkage?.baseRevision);
  requireText("linkage.corpusVersion", linkage?.corpusVersion);
  requireText("linkage.corpusTaskId", linkage?.corpusTaskId);
  requireText("linkage.environmentIdentity", linkage?.environmentIdentity);

  if (!Array.isArray(record?.trajectory) || record.trajectory.length === 0) {
    fail("trajectory", "must record at least the run-start and run-end events");
  } else {
    let previousSequence = -1;
    for (const event of record.trajectory) {
      if (!Number.isInteger(event?.sequence) || event.sequence < 0) {
        fail("trajectory[].sequence", "must be a non-negative integer");
      }
      if (event?.sequence !== undefined && event.sequence <= previousSequence) {
        fail("trajectory[].sequence", "must be monotonically increasing");
      }
      if (event?.sequence !== undefined) {
        previousSequence = event.sequence;
      }
      requireText("trajectory[].at", event?.at);
      if (event?.data === null || typeof event?.data !== "object" || Array.isArray(event?.data)) {
        fail("trajectory[].data", "must be a structured payload");
      }
    }
    const kinds = new Set(record.trajectory.map((event) => event?.kind));
    if (!kinds.has("run-start") || !kinds.has("run-end")) {
      fail("trajectory", "must include run-start and run-end");
    }
  }

  if (!Array.isArray(record?.environmentState)) {
    fail("environmentState", "must be an array (possibly empty)");
  } else {
    for (const observation of record.environmentState) {
      requireText("environmentState[].kind", observation?.kind);
      requireText("environmentState[].assertion", observation?.assertion);
      if (
        observation?.observedVia !== "platform-ledger" &&
        observation?.observedVia !== "artifact-store" &&
        observation?.observedVia !== "harness-probe"
      ) {
        fail(
          "environmentState[].observedVia",
          "must name the observation channel — a response string is not effect proof",
        );
      }
      if (typeof observation?.passed !== "boolean") {
        fail("environmentState[].passed", "must be a decided boolean");
      }
    }
  }

  if (!Array.isArray(record?.latency)) {
    fail("latency", "must be an array");
  } else {
    for (const fact of record.latency) {
      if (typeof fact?.milliseconds !== "number" || fact.milliseconds < 0) {
        fail("latency[].milliseconds", "must be non-negative");
      }
    }
  }

  if (!Array.isArray(record?.cost)) {
    fail("cost", "must be an array");
  } else {
    for (const fact of record.cost) {
      if (fact?.kind !== "estimate" && fact?.kind !== "measured") {
        fail("cost[].kind", "must be estimate or measured — never conflated");
      }
      if (typeof fact?.amountMicroUsd !== "string" || !MICRO_USD.test(fact.amountMicroUsd)) {
        fail("cost[].amountMicroUsd", "must be a micro-USD integer string");
      }
      requireText("cost[].source", fact?.source);
      requireText("cost[].scope", fact?.scope);
    }
    const totals = record.cost.filter((fact) => fact?.scope === "total-successful-resolution");
    for (const total of totals) {
      if (total?.kind === "estimate") {
        fail(
          "cost[]",
          "total successful-resolution cost must be MEASURED (estimates never become totals)",
        );
      }
    }
  }

  if (!Array.isArray(record?.telemetryGaps)) {
    fail("telemetryGaps", "must be an array (possibly empty)");
  }
  requireText("digest", record?.digest);
  return violations;
}

/** The linkage shape derivable from VAL-001 run metadata. */
export function linkageFromRunMetadata(
  metadata: RunMetadata,
  corpusTaskId: string,
  environmentIdentity: string,
): RunLinkage {
  return {
    applicationRevision: metadata.applicationRevision,
    baseRevision: metadata.baseRevision,
    corpusVersion: metadata.corpusRevision,
    corpusTaskId,
    environmentIdentity,
  };
}
