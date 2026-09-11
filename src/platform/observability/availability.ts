/**
 * Control-plane availability measurement (platform observability plane;
 * D-08 / WORK-060; AVA-001).
 *
 * THE TARGET (AVA-001): the request-facing control plane targets ≥ 99.9%
 * MONTHLY availability in the production environment class, measured by
 * the D-06 release/observability surfaces with exact-revision identity
 * and alert-state integration.
 *
 * FAIL-CLOSED SEMANTICS ARE PRESERVED — AND MEASURED AS CORRECT: a
 * degraded control plane that REFUSES to serve against a dead
 * authority is CORRECT behavior. The outcome vocabulary classifies it
 * distinctly (`refused-fail-closed`): it is NOT counted as serving (the
 * honest availability number drops), but it is classified as correct
 * behavior — the semantics are only "violated" when the plane is
 * observed SERVING against a dead authority (`served-against-dead-
 * authority`), which this codebase makes unrepresentable by construction
 * and the measurement reports as a correctness violation worse than an
 * SLO breach. Availability is never achieved by weakening the
 * authoritative-dependency rule.
 *
 * OBSERVABILITY-BOUNDARY: this module is a PURE evaluator over typed
 * interval observations — the same discipline as `alerts.ts`. It has no
 * database dependency, reads no provider dashboard, and never becomes a
 * second metrics authority: the observations arrive from the existing
 * readiness/telemetry plane (`availabilityOutcomeOfReadiness` derives
 * them from the D-01/D-06 readiness evaluation; telemetry exports and
 * smoke/health gate runs feed the same typed shape), and the durable
 * RECORD rides the existing release-gate evidence plane with
 * exact-revision identity.
 *
 * IDENTITY-IDEMPOTENCY: the window computation is deterministic — the
 * evidence digest is content-addressed over the canonical interval set
 * + window + exact revision identity + target (volatile timestamps are
 * excluded). Re-computing the same window from the same observations
 * produces the byte-identical record; the same window re-recorded
 * through the release ledger appends convergent evidence with the same
 * digest.
 */

import { createHash } from "node:crypto";
import type { ReadinessOverall } from "../deployment/readiness";
import type { AlertSeverity, OperationalAlert } from "./port";

// ---------------------------------------------------------------------------
// The outcome vocabulary (closed, pinned)
// ---------------------------------------------------------------------------

/**
 * The control-plane availability outcomes of one observation interval.
 *
 * - `served` — the control plane served requests (ready, or degraded on
 *   a NON-authoritative dependency: still serving, honestly labeled);
 * - `refused-fail-closed` — the control plane refused to serve because
 *   the authoritative dependency was dead — CORRECT behavior, measured
 *   as such (never counted as serving, never counted as a violation);
 * - `unavailable` — the control plane itself was unreachable;
 * - `served-against-dead-authority` — the control plane SERVED while
 *   the authority was dead: a correctness violation (unrepresentable by
 *   construction; if ever observed it is reported as the worst class).
 */
export const AVAILABILITY_OUTCOMES = [
  "served",
  "refused-fail-closed",
  "unavailable",
  "served-against-dead-authority",
] as const;
export type AvailabilityOutcome = (typeof AVAILABILITY_OUTCOMES)[number];

/** One observed interval of control-plane availability. */
export interface AvailabilityInterval {
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: AvailabilityOutcome;
}

// ---------------------------------------------------------------------------
// The readiness derivation (the D-01/D-06 observation source)
// ---------------------------------------------------------------------------

/**
 * Derive the availability outcome of a readiness evaluation (the
 * control-plane availability fact the health route already reports):
 * `ready`/`degraded` = serving; `down` = the fail-closed refusal
 * against a dead authority (CORRECT behavior); `unavailable` = the
 * control plane itself unreachable. The violation outcome
 * (`served-against-dead-authority`) is never produced by the readiness
 * plane — it is reserved for violation observations.
 */
export function availabilityOutcomeOfReadiness(overall: ReadinessOverall): AvailabilityOutcome {
  switch (overall) {
    case "ready":
    case "degraded":
      return "served";
    case "down":
      return "refused-fail-closed";
    case "unavailable":
      return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// The monthly window computation (pure, deterministic)
// ---------------------------------------------------------------------------

/** The AVA-001 production-class target floor — a weaker production target is unrepresentable. */
export const PRODUCTION_AVAILABILITY_TARGET_FLOOR_PCT = 99.9;

/** Maximum intervals per monthly window (minute resolution would be ~44640; bounded far above). */
export const MAX_AVAILABILITY_INTERVALS = 50_000;

export const AVAILABILITY_WINDOW_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The exact-revision identity an availability record is bound to. */
export interface AvailabilityRevisionIdentity {
  readonly releaseId: string;
  readonly gitRevision: string;
  readonly manifestDigest: string;
}

export interface AvailabilityWindowInput {
  readonly environment: string;
  /** The calendar month window label (YYYY-MM). */
  readonly window: string;
  readonly revision: AvailabilityRevisionIdentity;
  readonly intervals: readonly AvailabilityInterval[];
  /** The environment's monthly availability target (percent). */
  readonly targetPct: number;
}

export interface AvailabilityWindowRecord {
  readonly environment: string;
  readonly window: string;
  readonly releaseId: string;
  readonly gitRevision: string;
  readonly manifestDigest: string;
  readonly intervalCount: number;
  readonly totalMs: number;
  readonly servedMs: number;
  readonly refusedFailClosedMs: number;
  readonly unavailableMs: number;
  readonly servedAgainstDeadAuthorityMs: number;
  /** The honest availability number: served time / total time (percent). */
  readonly availabilityPct: number;
  readonly targetPct: number;
  readonly withinTarget: boolean;
  /**
   * `preserved` unless the plane was observed serving against a dead
   * authority — the fail-closed semantics verdict (AVA-001).
   */
  readonly failClosedSemantics: "preserved" | "violated";
  /**
   * Content-addressed evidence digest over the canonical interval set,
   * window, exact-revision identity and target — deterministic,
   * replayable, excluding volatile timestamps.
   */
  readonly evidenceDigest: string;
}

export class AvailabilityComputationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvailabilityComputationError";
  }
}

function canonicalAvailabilityJson(input: AvailabilityWindowInput): string {
  const form = {
    schema: "zeck-availability-window-v1",
    environment: input.environment,
    window: input.window,
    releaseId: input.revision.releaseId,
    gitRevision: input.revision.gitRevision,
    manifestDigest: input.revision.manifestDigest,
    targetPct: input.targetPct,
    intervals: input.intervals.map((interval) => [
      interval.startedAt,
      interval.endedAt,
      interval.outcome,
    ]),
  };
  const keys = Object.keys(form).sort();
  const entries = keys.map((key) => {
    const value = form[key as keyof typeof form];
    return `${JSON.stringify(key)}:${JSON.stringify(value)}`;
  });
  return `{${entries.join(",")}}`;
}

function parseInstant(value: string, context: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new AvailabilityComputationError(
      `${context} is not an ISO-8601 instant (got: "${value.slice(0, 40)}")`,
    );
  }
  return parsed;
}

/**
 * Compute one monthly availability window from typed interval
 * observations. PURE and deterministic: the same intervals + window +
 * exact-revision identity + target produce the byte-identical record
 * (the digest input excludes volatile timestamps).
 *
 * Fail-closed on malformed inputs: unordered/overlapping intervals,
 * non-positive durations, unknown outcomes, a malformed window label,
 * an unbounded interval count or a non-positive target refuse with the
 * exact problem — incomplete evidence never becomes a PASS.
 */
export function computeAvailabilityWindow(
  input: AvailabilityWindowInput,
): AvailabilityWindowRecord {
  if (typeof input.window !== "string" || !AVAILABILITY_WINDOW_PATTERN.test(input.window)) {
    throw new AvailabilityComputationError(
      `the availability window label must be YYYY-MM (got: "${String(input.window ?? "").slice(0, 16)}")`,
    );
  }
  if (input.targetPct <= 0 || input.targetPct > 100) {
    throw new AvailabilityComputationError(
      `the availability target must be a percentage in (0, 100] (got: ${input.targetPct})`,
    );
  }
  if (input.intervals.length === 0) {
    throw new AvailabilityComputationError(
      "an availability window requires at least one observation interval (empty evidence is not a PASS)",
    );
  }
  if (input.intervals.length > MAX_AVAILABILITY_INTERVALS) {
    throw new AvailabilityComputationError(
      `an availability window accepts at most ${MAX_AVAILABILITY_INTERVALS} intervals (got: ${input.intervals.length})`,
    );
  }

  let servedMs = 0;
  let refusedFailClosedMs = 0;
  let unavailableMs = 0;
  let servedAgainstDeadAuthorityMs = 0;
  let previousEnd = Number.NEGATIVE_INFINITY;

  for (const [index, interval] of input.intervals.entries()) {
    const context = `intervals[${index}]`;
    if (!(AVAILABILITY_OUTCOMES as readonly string[]).includes(interval.outcome)) {
      throw new AvailabilityComputationError(
        `${context} has an unknown outcome "${String(interval.outcome)}"`,
      );
    }
    const start = parseInstant(interval.startedAt, `${context}.startedAt`);
    const end = parseInstant(interval.endedAt, `${context}.endedAt`);
    const duration = end - start;
    if (duration <= 0) {
      throw new AvailabilityComputationError(
        `${context} has a non-positive duration (${duration}ms)`,
      );
    }
    if (start < previousEnd) {
      throw new AvailabilityComputationError(
        `${context} starts before the previous interval ends (intervals must be ordered and non-overlapping)`,
      );
    }
    previousEnd = end;
    switch (interval.outcome) {
      case "served":
        servedMs += duration;
        break;
      case "refused-fail-closed":
        refusedFailClosedMs += duration;
        break;
      case "unavailable":
        unavailableMs += duration;
        break;
      case "served-against-dead-authority":
        servedAgainstDeadAuthorityMs += duration;
        break;
    }
  }

  const totalMs = servedMs + refusedFailClosedMs + unavailableMs + servedAgainstDeadAuthorityMs;
  const availabilityPct = Number(((servedMs / totalMs) * 100).toFixed(4));
  const failClosedSemantics: "preserved" | "violated" =
    servedAgainstDeadAuthorityMs > 0 ? "violated" : "preserved";

  return {
    environment: input.environment,
    window: input.window,
    releaseId: input.revision.releaseId,
    gitRevision: input.revision.gitRevision,
    manifestDigest: input.revision.manifestDigest,
    intervalCount: input.intervals.length,
    totalMs,
    servedMs,
    refusedFailClosedMs,
    unavailableMs,
    servedAgainstDeadAuthorityMs,
    availabilityPct,
    targetPct: input.targetPct,
    withinTarget: availabilityPct >= input.targetPct,
    failClosedSemantics,
    evidenceDigest: createHash("sha256")
      .update(canonicalAvailabilityJson(input), "utf8")
      .digest("hex"),
  };
}

// ---------------------------------------------------------------------------
// Alert-state integration (the D-06 alert plane; promotion-blocking)
// ---------------------------------------------------------------------------

/** Near-breach margin (percentage points) for the warning alert. */
export const AVAILABILITY_WARNING_MARGIN_PCT = 0.1;

/**
 * The operational alert of one availability window (the alert-state
 * integration AC): a semantics violation is ALWAYS critical (a
 * correctness breach is worse than an SLO breach); a below-target
 * window is critical (the SLO is breached); a window within the
 * near-breach margin of the target is a warning (observable before
 * breach — the free-tier doctrine's alert-before-exhaustion discipline).
 */
export function availabilityAlertOf(record: AvailabilityWindowRecord): OperationalAlert | null {
  if (record.failClosedSemantics === "violated") {
    return {
      kind: "availability",
      severity: "critical",
      subject: `control-plane-availability@${record.environment}:${record.window}`,
      detail: `the control plane was observed SERVING against a dead authority for ${record.servedAgainstDeadAuthorityMs}ms in window ${record.window} — the fail-closed semantics are violated (this is a correctness breach, worse than an availability breach)`,
      action:
        "treat as a correctness incident: fence the offending deployment immediately, inspect the authority wiring and the release evidence, and re-run the availability measurement from verified observations",
    };
  }
  if (!record.withinTarget) {
    return {
      kind: "availability",
      severity: "critical",
      subject: `control-plane-availability@${record.environment}:${record.window}`,
      detail: `availability ${record.availabilityPct}% is below the ${record.targetPct}% target for window ${record.window} (served ${record.servedMs}ms / ${record.totalMs}ms; fail-closed refusals ${record.refusedFailClosedMs}ms were CORRECT behavior, not counted as serving)`,
      action:
        "run the failover procedure for the failed dependency (deploy:drill per providers.json redundancy) and re-measure; the target is never met by weakening the authoritative-dependency rule",
    };
  }
  if (record.availabilityPct < record.targetPct + AVAILABILITY_WARNING_MARGIN_PCT) {
    return {
      kind: "availability",
      severity: "warning",
      subject: `control-plane-availability@${record.environment}:${record.window}`,
      detail: `availability ${record.availabilityPct}% is within ${AVAILABILITY_WARNING_MARGIN_PCT}pt of the ${record.targetPct}% target for window ${record.window} (approaching breach)`,
      action:
        "plan capacity: inspect the refused-fail-closed and unavailable intervals with deploy:release inspect before the target is breached",
    };
  }
  return null;
}

/** Typed narrowing helper for the critical alert verdict. */
export function isCriticalAvailabilityAlert(alert: OperationalAlert | null): boolean {
  return (alert?.severity as AlertSeverity | undefined) === "critical";
}
