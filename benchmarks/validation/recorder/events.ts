/**
 * The trajectory event vocabulary (VAL-004, acceptance criterion 3).
 *
 * Typed, provider-neutral events capturing enough of the customer-style
 * execution trajectory to RECONSTRUCT model/tool/agent/substrate
 * decisions and retries later (root-cause analysis, trajectory diffing,
 * deterministicization experiments). No provider telemetry semantics
 * leak into this vocabulary: provider identifiers cross as opaque
 * neutral strings only.
 */

/** The neutral trajectory event kinds. */
export const TRAJECTORY_EVENT_KINDS = [
  "run-start",
  "model-choice",
  "tool-exposed",
  "tool-invoked",
  "context-event",
  "cache-event",
  "agent-count",
  "substrate-readiness",
  "retry",
  "escalation",
  "verification",
  "output-produced",
  "error-surfaced",
  "environment-effect",
  "run-end",
] as const;

export type TrajectoryEventKind = (typeof TRAJECTORY_EVENT_KINDS)[number];

/** One observed trajectory event (append-only; secrets never enter). */
export interface TrajectoryEvent {
  readonly kind: TrajectoryEventKind;
  /** Monotonic sequence within the run (the reconstruction order). */
  readonly sequence: number;
  /** Observation timestamp (ISO 8601). */
  readonly at: string;
  /** The neutral observation payload (structured; never a bare string). */
  readonly data: Readonly<Record<string, unknown>>;
}

/** Classification for telemetry-gap analysis (the issue protocol). */
export type TelemetryGapClassification =
  | "zeck-instrumentation-defect"
  | "provider-observability-limit"
  | "application-instrumentation-gap"
  | "evaluator-limitation";

/** A declared telemetry gap (honest NOT-RUN-style boundary). */
export interface TelemetryGap {
  readonly classification: TelemetryGapClassification;
  readonly detail: string;
  /** The viable remedies considered, with the recommended one marked. */
  readonly remedies: readonly {
    readonly description: string;
    readonly recommended: boolean;
    readonly tradeOffs: string;
  }[];
}

/** The decision timeline reconstructed from a record's events. */
export interface ReconstructedDecision {
  readonly sequence: number;
  readonly at: string;
  readonly kind: TrajectoryEventKind;
  readonly summary: string;
}

/**
 * Reconstruct the decision timeline from trajectory events (criterion 3:
 * the record must be sufficient to rebuild the decision order).
 * Pure: ordered by sequence, one human-readable summary per event.
 */
export function reconstructTimeline(
  events: readonly TrajectoryEvent[],
): readonly ReconstructedDecision[] {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  return ordered.map((event) => ({
    sequence: event.sequence,
    at: event.at,
    kind: event.kind,
    summary: summarize(event),
  }));
}

function summarize(event: TrajectoryEvent): string {
  const data = event.data;
  const first = (key: string): string => {
    const value = data[key];
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  };
  switch (event.kind) {
    case "model-choice":
      return `model ${first("modelId")} selected for ${first("purpose")}`;
    case "tool-exposed":
      return `tool ${first("toolId")} exposed with grant ${first("grant")}`;
    case "tool-invoked":
      return `tool ${first("toolId")} invoked (attempt ${first("attempt")})`;
    case "context-event":
      return `context ${first("operation")} (${first("tokens")} tokens)`;
    case "cache-event":
      return `cache ${first("operation")} hit=${first("hit")}`;
    case "agent-count":
      return `agents active: ${first("count")}`;
    case "substrate-readiness":
      return `substrate ${first("substrateId")} readiness ${first("state")}`;
    case "retry":
      return `retry after ${first("reason")}`;
    case "escalation":
      return `escalated to ${first("level")}: ${first("reason")}`;
    case "verification":
      return `verification ${first("status")} by ${first("strategy")}`;
    case "output-produced":
      return `output artifact ${first("artifactId")}`;
    case "error-surfaced":
      return `error ${first("code")} (${first("retryable")})`;
    case "environment-effect":
      return `effect ${first("kind")}: ${first("assertion")}`;
    case "run-start":
      return `run started for task ${first("corpusTask")}`;
    case "run-end":
      return `run ended ${first("terminalStatus")}`;
    default:
      return event.kind;
  }
}
