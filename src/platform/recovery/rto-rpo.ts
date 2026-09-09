/**
 * Recovery objectives and drill evidence types (platform recovery
 * plane; WORK-048 / D-07, `docs/DEPLOYMENT-ARCHITECTURE.md` §17).
 *
 * RTO/RPO are MEASURED claims per environment, never aspirational
 * prose (Work Order invariant 8): every target is a repository-resident
 * number with its measurement procedure, and every drill report
 * carries the measured values plus the revision it was measured at.
 *
 * Repository truth: `deploy/manifests/recovery-targets.json` (loaded
 * by the operator tools and validated by `deploy:validate`). Provider
 * dashboards, chat or incident tickets cannot redefine a target.
 *
 * SEMANTICS (kept honest and bounded):
 *
 *  - `rtoTargetMs`: maximum wall time from declared infrastructure
 *    loss to VERIFIED recovery of the authoritative state (the drill
 *    clock measures loss → every verification gate green).
 *  - `rpoTargetMs`: maximum authoritative-data loss window measured
 *    as (loss timestamp − last consistent recovery point). For the
 *    repository-defined logical-backup procedure the recovery point
 *    is the backup's creation instant; committed writes after that
 *    instant are lost BY DESIGN and the drill must report them as the
 *    measured RPO — never hide them inside a "successful" recovery.
 *  - A drill that cannot complete verification reports
 *    `recovered: false`; its measured RTO is incomplete evidence,
 *    not a pass.
 */

/** Fail-closed recovery-target configuration error. */
export class RecoveryTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryTargetError";
  }
}

/** One environment's recovery objectives (repository truth). */
export interface EnvironmentRecoveryTarget {
  /** Maximum recovery time objective, milliseconds (positive). */
  readonly rtoTargetMs: number;
  /** Maximum recovery point objective, milliseconds (non-negative). */
  readonly rpoTargetMs: number;
  /** Bounded description of the outage class the target covers. */
  readonly scope: string;
  /** How the numbers are measured (the repository-defined drill). */
  readonly measurement: string;
}

/** The parsed `recovery-targets.json` document. */
export interface RecoveryTargetsDocument {
  readonly schemaVersion: 1;
  readonly description: string;
  readonly note: string;
  readonly targets: Readonly<Record<string, EnvironmentRecoveryTarget>>;
}

const MAX_TARGET_MS = 1000 * 60 * 60 * 24 * 7; // one week — a bound, not a default
const MAX_TEXT_LENGTH = 500;

function requirePositiveInt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RecoveryTargetError(`target field ${key} must be a positive integer`);
  }
  if (value > MAX_TARGET_MS) {
    throw new RecoveryTargetError(`target field ${key} exceeds the ${MAX_TARGET_MS}ms bound`);
  }
  return value;
}

function requireNonNegativeInt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RecoveryTargetError(`target field ${key} must be a non-negative integer`);
  }
  if (value > MAX_TARGET_MS) {
    throw new RecoveryTargetError(`target field ${key} exceeds the ${MAX_TARGET_MS}ms bound`);
  }
  return value;
}

function requireBoundedText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new RecoveryTargetError(
      `target field ${key} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
    );
  }
  return value;
}

/**
 * Parse and validate the recovery-targets document (fail closed on
 * every drift: unknown schema, missing environments, unbounded or
 * non-numeric targets, unbounded prose).
 */
export function parseRecoveryTargets(source: string): RecoveryTargetsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new RecoveryTargetError(
      `recovery-targets.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RecoveryTargetError("recovery-targets.json must be an object");
  }
  const document = parsed as Record<string, unknown>;
  if (document.schemaVersion !== 1) {
    throw new RecoveryTargetError("recovery-targets.json schemaVersion must be 1");
  }
  if (typeof document.description !== "string" || document.description.length === 0) {
    throw new RecoveryTargetError("recovery-targets.json requires a non-empty description");
  }
  if (typeof document.note !== "string") {
    throw new RecoveryTargetError("recovery-targets.json requires a note");
  }
  const targets = document.targets;
  if (typeof targets !== "object" || targets === null || Array.isArray(targets)) {
    throw new RecoveryTargetError(
      "recovery-targets.json targets must be an object keyed by environment",
    );
  }
  const entries = Object.entries(targets as Record<string, unknown>);
  if (entries.length === 0) {
    throw new RecoveryTargetError(
      "recovery-targets.json must define at least one environment target",
    );
  }
  const validated: Record<string, EnvironmentRecoveryTarget> = {};
  for (const [environment, raw] of entries) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RecoveryTargetError(`target for ${environment} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    validated[environment] = Object.freeze({
      rtoTargetMs: requirePositiveInt(record, "rtoTargetMs"),
      rpoTargetMs: requireNonNegativeInt(record, "rpoTargetMs"),
      scope: requireBoundedText(record, "scope"),
      measurement: requireBoundedText(record, "measurement"),
    });
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    description: document.description,
    note: document.note,
    targets: Object.freeze(validated),
  });
}

/** The target for one environment (fail closed when absent). */
export function recoveryTargetFor(
  document: RecoveryTargetsDocument,
  environment: string,
): EnvironmentRecoveryTarget {
  const target = document.targets[environment];
  if (target === undefined) {
    throw new RecoveryTargetError(
      `no recovery target is defined for environment "${environment}" (recovery-targets.json)`,
    );
  }
  return target;
}

/** One measured phase of a recovery drill (bounded evidence). */
export interface DrillPhaseReport {
  readonly name: string;
  readonly description: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly ok: boolean;
  /** Bounded failure reason (null on success). */
  readonly error: string | null;
}

/** The measured RTO/RPO evaluation against the repository target. */
export interface DrillObjectiveEvaluation {
  readonly rtoWithinTarget: boolean;
  readonly rpoWithinTarget: boolean;
  readonly breaches: readonly string[];
}

/** The complete, bounded drill evidence record. */
export interface RecoveryDrillReport {
  readonly scenarioId: string;
  readonly environment: string;
  readonly revision: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly phases: readonly DrillPhaseReport[];
  /** Measured recovery time (loss → every verification gate green). */
  readonly rtoMs: number | null;
  /**
   * Measured recovery point (data-loss window = loss timestamp − last
   * consistent recovery point). Null when the scenario is zero-loss
   * by construction (e.g. worker evacuation without authority loss).
   */
  readonly rpoMs: number | null;
  /**
   * The ONLY recovered declaration: true iff every phase completed
   * and verified. Fail-closed — a missing verification is a failed
   * recovery, never a silent pass.
   */
  readonly recovered: boolean;
}

/** Evaluate a completed drill report against an environment target. */
export function evaluateDrillAgainstTarget(
  report: RecoveryDrillReport,
  target: EnvironmentRecoveryTarget,
): DrillObjectiveEvaluation {
  const breaches: string[] = [];
  if (!report.recovered) {
    breaches.push("the drill did not verify recovery; objectives cannot be declared met");
  }
  if (report.rtoMs === null) {
    breaches.push("RTO was not measured (incomplete drill)");
  } else if (report.rtoMs > target.rtoTargetMs) {
    breaches.push(`measured RTO ${report.rtoMs}ms exceeds the ${target.rtoTargetMs}ms target`);
  }
  if (report.rpoMs === null) {
    breaches.push("RPO was not measured (scenario lacks a recovery-point anchor)");
  } else if (report.rpoMs > target.rpoTargetMs) {
    breaches.push(`measured RPO ${report.rpoMs}ms exceeds the ${target.rpoTargetMs}ms target`);
  }
  return Object.freeze({
    rtoWithinTarget: report.rtoMs !== null && report.rtoMs <= target.rtoTargetMs,
    rpoWithinTarget: report.rpoMs !== null && report.rpoMs <= target.rpoTargetMs,
    breaches: Object.freeze([...breaches]),
  });
}
