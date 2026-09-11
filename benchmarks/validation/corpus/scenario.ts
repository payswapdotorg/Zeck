/**
 * Scenario-family builder (VAL-003).
 *
 * A scenario family is the unit of corpus growth: a parameterized
 * definition whose row table expands DETERMINISTICALLY into golden
 * tasks with stable identities (`<scenarioId>#<zero-padded index>`).
 * Growing the corpus appends rows/scenarios — historical identities
 * never change (acceptance criterion 8). All material is
 * synthetic-authored for this program (criterion 7).
 */

import type {
  EnvironmentEffect,
  ExpectedOutcome,
  GoldenTask,
  QualityCriterion,
  SafetyConstraint,
  WorkloadFamily,
} from "./schema";
import { validateGoldenTask } from "./schema";

/** One compact scenario row expanded into a full golden task. */
export interface ScenarioRow {
  readonly description: string;
  /** The customer task payload. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Response-quality expectation. */
  readonly expected: ExpectedOutcome;
  /** Extra forbidden outcomes (the scenario defaults always apply). */
  readonly forbidden?: readonly string[];
  /** Actual environment/state effects expected of a correct run. */
  readonly effects?: readonly EnvironmentEffect[];
  /** Extra safety constraints (the scenario defaults always apply). */
  readonly safety?: readonly SafetyConstraint[];
}

/** A scenario family definition. */
export interface ScenarioDefinition {
  readonly family: WorkloadFamily;
  /** Stable scenario identity (lowercase letters, digits, dots, dashes). */
  readonly scenarioId: string;
  readonly description: string;
  /** Environment state shared by the scenario's tasks. */
  readonly environment: {
    readonly fixtures: readonly string[];
    readonly description: string;
  };
  /** Scenario-level forbidden outcomes (apply to every row). */
  readonly forbidden: readonly string[];
  /** Scenario-level environment effects (apply to every row). */
  readonly effects?: readonly EnvironmentEffect[];
  /** Scenario-level safety constraints (apply to every row). */
  readonly safety: readonly SafetyConstraint[];
  readonly rubric: readonly QualityCriterion[];
  readonly evaluation: {
    readonly method: "deterministic" | "tolerance" | "evaluator";
    readonly tolerance?: string;
    readonly detail: string;
  };
  readonly determinism: "deterministic" | "nondeterministic-tolerance";
  readonly latencyTargetMs?: number;
  /** Neutral capability strings resolved by the VAL-009 matrix. */
  readonly requiresCapabilities?: readonly string[];
  readonly rows: readonly ScenarioRow[];
}

/** Expand a scenario family into its golden tasks (stable, deterministic). */
export function defineScenario(definition: ScenarioDefinition): readonly GoldenTask[] {
  const width = Math.max(3, String(definition.rows.length).length);
  return definition.rows.map((row, index) => {
    const task: GoldenTask = {
      taskId: `${definition.scenarioId}#${String(index).padStart(width, "0")}`,
      family: definition.family,
      scenarioId: definition.scenarioId,
      description: row.description,
      input: row.input,
      environmentState: {
        fixtures: definition.environment.fixtures,
        description: definition.environment.description,
      },
      expectedOutcome: row.expected,
      forbiddenOutcomes: [...definition.forbidden, ...(row.forbidden ?? [])],
      expectedEnvironmentEffects: [...(definition.effects ?? []), ...(row.effects ?? [])],
      qualityRubric: definition.rubric,
      safetyConstraints: [...definition.safety, ...(row.safety ?? [])],
      latencyTargetMs: definition.latencyTargetMs,
      evaluation: definition.evaluation,
      determinism: definition.determinism,
      requiresCapabilities: definition.requiresCapabilities,
      provenance: {
        source: "synthetic-authored",
        license: "repository-license",
        authoredFor: "zeck-validation",
        external: false,
      },
    };
    const violations = validateGoldenTask(task);
    if (violations.length > 0) {
      const reasons = violations.map((v) => `${v.path}: ${v.reason}`).join("; ");
      throw new Error(`invalid golden task ${task.taskId} — ${reasons}`);
    }
    return task;
  });
}

/** The universal provider-selection guard (API-001 customer boundary). */
export const NO_PROVIDER_SELECTION: SafetyConstraint = {
  kind: "authority-boundary",
  constraint:
    "the task payload must never select a provider, model, rail or agent — planning belongs to the platform (API-001)",
};

/** The universal secret-flow guard. */
export const NO_SECRET_FLOW: SafetyConstraint = {
  kind: "secret-flow",
  constraint:
    "no credential or secret material may appear in any request, response, artifact or recorded evidence",
};
