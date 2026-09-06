/**
 * Alert evaluation (WORK-047 / D-06; COST-QUOTA-GUARDS).
 *
 * PURE evaluation: snapshots in, actionable alerts out. The snapshots
 * are collected by the operator tooling from the AUTHORITATIVE stores
 * (the compute-plane quota tables, the queue-transport envelope
 * counts, the execution authority's terminal outcomes, the database
 * size) — never from provider dashboards or control planes.
 *
 * THE FREE-TIER OPERATING DOCTRINE (roadmap): observable BEFORE
 * exhaustion — a warning fires at the warn threshold (default 80%),
 * a critical at the critical threshold (default 95%); quotas are
 * hard-capped fail-closed by the owning planes (D-05 environment
 * quotas) so uncontrolled paid overage is unrepresentable by
 * default; every alert carries an ACTION (what the operator does),
 * never a bare number.
 *
 * Thresholds are loaded from the repository-resident
 * deploy/manifests/quota-guards.json (the loader lives with the
 * release policy loader; this module is the pure evaluator).
 */

import type {
  AlertKind,
  AlertSeverity,
  OperationalAlert,
  QuotaGuardThresholds,
  QuotaUtilizationSnapshot,
} from "./port";

export interface QuotaAlertPolicy {
  /** Guard id → thresholds (the repository-resident policy). */
  readonly guards: Readonly<Record<string, QuotaGuardThresholds>>;
}

export const DEFAULT_QUOTA_THRESHOLDS: Readonly<QuotaGuardThresholds> = Object.freeze({
  warnAtPct: 80,
  criticalAtPct: 95,
});

function pct(used: number, limit: number): number {
  if (limit <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (used / limit) * 100;
}

function alertFor(
  kind: AlertKind,
  severity: AlertSeverity,
  subject: string,
  detail: string,
  action: string,
): OperationalAlert {
  return { kind, severity, subject, detail, action };
}

/**
 * Evaluate quota utilization snapshots against thresholds. Returns
 * AT MOST one alert per snapshot (critical wins over warning), in
 * snapshot order — warnings BEFORE exhaustion, criticals at the
 * exhaustion edge.
 */
export function evaluateQuotaAlerts(
  snapshots: readonly QuotaUtilizationSnapshot[],
  policy: QuotaAlertPolicy,
): readonly OperationalAlert[] {
  const alerts: OperationalAlert[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.used < 0) {
      continue;
    }
    const thresholds = policy.guards[snapshot.guard] ?? DEFAULT_QUOTA_THRESHOLDS;
    const utilization = pct(snapshot.used, snapshot.limit);
    if (utilization >= thresholds.criticalAtPct) {
      alerts.push(
        alertFor(
          "quota-critical",
          "critical",
          `${snapshot.guard}@${snapshot.environment}`,
          `utilization ${utilization.toFixed(1)}% (${snapshot.used}/${snapshot.limit}) at or beyond the critical threshold ${thresholds.criticalAtPct}%`,
          `act now: raise the environment quota through the governed operator surface or shed load; the owning plane hard-caps at the limit (fail-closed, no uncontrolled overage)`,
        ),
      );
    } else if (utilization >= thresholds.warnAtPct) {
      alerts.push(
        alertFor(
          "quota-warning",
          "warning",
          `${snapshot.guard}@${snapshot.environment}`,
          `utilization ${utilization.toFixed(1)}% (${snapshot.used}/${snapshot.limit}) at the warning threshold ${thresholds.warnAtPct}%`,
          `plan capacity: raise the quota before the critical threshold; inspect with deploy:release status`,
        ),
      );
    }
  }
  return alerts;
}

export interface OperationalThreshold {
  /** The metric identity (e.g. "queue-dead-letters"). */
  readonly metric: string;
  /** The window label (bounded, descriptive). */
  readonly window: string;
  /** Alert when the count exceeds this bound. */
  readonly warnAbove: number;
  readonly criticalAbove: number;
  readonly action: string;
}

export interface OperationalMetricSnapshot {
  readonly metric: string;
  readonly window: string;
  readonly value: number;
}

/**
 * Evaluate operational metrics (error monitoring): counts sourced
 * from the authoritative stores (dead-lettered envelopes, terminal
 * failed executions) against the repository thresholds. Every alert
 * is actionable (the runbook action travels with the alert).
 */
export function evaluateOperationalAlerts(
  snapshots: readonly OperationalMetricSnapshot[],
  thresholds: readonly OperationalThreshold[],
): readonly OperationalAlert[] {
  const byMetric = new Map(thresholds.map((entry) => [entry.metric, entry]));
  const alerts: OperationalAlert[] = [];
  for (const snapshot of snapshots) {
    if (snapshot.value < 0) {
      continue;
    }
    const threshold = byMetric.get(snapshot.metric);
    if (threshold === undefined) {
      continue;
    }
    if (snapshot.value > threshold.criticalAbove) {
      alerts.push(
        alertFor(
          "error-rate",
          "critical",
          `${snapshot.metric}@${snapshot.window}`,
          `${snapshot.value} in window "${snapshot.window}" beyond the critical bound ${threshold.criticalAbove}`,
          threshold.action,
        ),
      );
    } else if (snapshot.value > threshold.warnAbove) {
      alerts.push(
        alertFor(
          "error-rate",
          "warning",
          `${snapshot.metric}@${snapshot.window}`,
          `${snapshot.value} in window "${snapshot.window}" beyond the warning bound ${threshold.warnAbove}`,
          threshold.action,
        ),
      );
    }
  }
  return alerts;
}

/** True when any alert carries the critical severity (the guardrail input). */
export function hasCriticalAlert(alerts: readonly OperationalAlert[]): boolean {
  return alerts.some((alert) => alert.severity === "critical");
}

// ---------------------------------------------------------------------------
// The repository-resident quota-guards policy loader (fail closed)
// ---------------------------------------------------------------------------

export interface QuotaGuardRule {
  readonly guard: string;
  readonly description: string;
  readonly thresholds: QuotaGuardThresholds;
  /** Optional declared limit for guards without an authority-owned limit. */
  readonly defaultLimitBytes: number | null;
}

export interface QuotaGuardsPolicy {
  readonly guards: readonly QuotaGuardRule[];
  readonly operationalThresholds: readonly OperationalThreshold[];
}

export class QuotaGuardsPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaGuardsPolicyError";
  }
}

/**
 * Load and validate deploy/manifests/quota-guards.json. Fail-closed:
 * thresholds must exist and be ordered (warn < critical, both within
 * (0, 100]) — an unbounded or missing threshold (the weakening
 * mutation) is unrepresentable.
 */
export function loadQuotaGuardsPolicy(source: string): QuotaGuardsPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new QuotaGuardsPolicyError(
      `quota-guards.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new QuotaGuardsPolicyError("quota-guards.json: expected a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const guardsSource = record.guards;
  if (typeof guardsSource !== "object" || guardsSource === null) {
    throw new QuotaGuardsPolicyError("quota-guards.json: guards must be an object");
  }
  const guards: QuotaGuardRule[] = [];
  for (const [guard, raw] of Object.entries(guardsSource)) {
    if (typeof raw !== "object" || raw === null) {
      problems.push(`guards.${guard}: expected an object`);
      continue;
    }
    const rule = raw as Record<string, unknown>;
    const warnAtPct = rule.warnAtPct;
    const criticalAtPct = rule.criticalAtPct;
    if (
      typeof warnAtPct !== "number" ||
      typeof criticalAtPct !== "number" ||
      !(warnAtPct > 0 && warnAtPct < 100) ||
      !(criticalAtPct > 0 && criticalAtPct <= 100) ||
      warnAtPct >= criticalAtPct
    ) {
      problems.push(
        `guards.${guard}: warnAtPct and criticalAtPct must be ordered percentages in (0,100] with warn < critical (got warn=${String(warnAtPct)}, critical=${String(criticalAtPct)})`,
      );
      continue;
    }
    const description = rule.description;
    if (typeof description !== "string" || description.trim() === "") {
      problems.push(`guards.${guard}: description must be a non-empty string`);
      continue;
    }
    const defaultLimitBytes = rule.defaultLimitBytes;
    if (
      defaultLimitBytes !== undefined &&
      (typeof defaultLimitBytes !== "number" ||
        !Number.isFinite(defaultLimitBytes) ||
        defaultLimitBytes <= 0)
    ) {
      problems.push(`guards.${guard}: defaultLimitBytes must be a positive finite number`);
      continue;
    }
    guards.push({
      guard,
      description,
      thresholds: { warnAtPct, criticalAtPct },
      defaultLimitBytes: defaultLimitBytes ?? null,
    });
  }

  const thresholdsSource = record.operationalThresholds;
  if (!Array.isArray(thresholdsSource)) {
    throw new QuotaGuardsPolicyError("quota-guards.json: operationalThresholds must be an array");
  }
  const operationalThresholds: OperationalThreshold[] = [];
  for (const [index, raw] of thresholdsSource.entries()) {
    if (typeof raw !== "object" || raw === null) {
      problems.push(`operationalThresholds[${index}]: expected an object`);
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const metric = entry.metric;
    const window = entry.window;
    const warnAbove = entry.warnAbove;
    const criticalAbove = entry.criticalAbove;
    const action = entry.action;
    if (typeof metric !== "string" || metric.trim() === "") {
      problems.push(`operationalThresholds[${index}].metric must be a non-empty string`);
      continue;
    }
    if (typeof window !== "string" || window.trim() === "") {
      problems.push(`operationalThresholds[${index}].window must be a non-empty string`);
      continue;
    }
    if (
      typeof warnAbove !== "number" ||
      typeof criticalAbove !== "number" ||
      warnAbove < 0 ||
      criticalAbove < 0 ||
      warnAbove >= criticalAbove
    ) {
      problems.push(
        `operationalThresholds[${index}] (${metric}): warnAbove/criticalAbove must be ordered non-negative numbers with warn < critical`,
      );
      continue;
    }
    if (typeof action !== "string" || action.trim() === "") {
      problems.push(
        `operationalThresholds[${index}] (${metric}): action must be a non-empty string (alerts are actionable)`,
      );
      continue;
    }
    operationalThresholds.push({ metric, window, warnAbove, criticalAbove, action });
  }

  if (problems.length > 0) {
    throw new QuotaGuardsPolicyError(
      `invalid quota-guards policy (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`,
    );
  }
  return { guards, operationalThresholds };
}
