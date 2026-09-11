/**
 * The golden-corpus schema (VAL-003, acceptance criterion 1).
 *
 * A versioned schema represents task input, environment state, expected
 * outcome, forbidden outcome, quality rubric, safety constraints,
 * latency target and evaluation method — and SEPARATES final response
 * quality from actual environment/state effects (criterion 3). The
 * corpus is DATA, never authority: tasks describe what a customer-style
 * application must achieve through the public boundary; they never
 * encode provider assumptions as architecture and never carry
 * production secrets or personal data.
 */

/** The 21 required workload families (the roadmap's coverage list). */
export const WORKLOAD_FAMILIES = [
  "text",
  "structured",
  "rag",
  "tools",
  "workflow",
  "long-running",
  "voice",
  "realtime-voice",
  "image-generation",
  "video-media",
  "image-recognition",
  "vlm",
  "audio-understanding",
  "multimodal",
  "three-d",
  "customer-service",
  "browser-use",
  "computer-use",
  "research",
  "coding",
  "operations",
  "hitl",
] as const;

export type WorkloadFamily = (typeof WORKLOAD_FAMILIES)[number];

/** How the outcome of a task is judged. */
export type EvaluationMethod = "deterministic" | "tolerance" | "evaluator";

/** A measurable rubric criterion (response QUALITY — not state effects). */
export interface QualityCriterion {
  readonly name: string;
  /** Weight in [0,1]; the family's criteria sum to 1. */
  readonly weight: number;
  readonly measurement: string;
}

/** Response-quality expectation (what the ANSWER must satisfy). */
export interface ExpectedOutcome {
  /** Required terminal execution status (the resolution contract). */
  readonly terminalStatus: "COMPLETED" | "FAILED" | "CANCELLED";
  /** Required verification outcome (when the platform records one). */
  readonly verification?: "PASS" | "FAIL" | "INCONCLUSIVE";
  /**
   * Deterministic response-shape expectation: a JSON-path-like list of
   * required fields in the outcome artifact (response quality, NOT
   * environment effects — those live in expectedEnvironmentEffects).
   */
  readonly outputShape?: readonly string[];
  /** Text the response must contain (exact, case-insensitive allowed). */
  readonly containsText?: readonly string[];
}

/** An actual environment/state effect assertion (criterion 3). */
export interface EnvironmentEffect {
  readonly kind:
    | "artifact-created"
    | "tool-invoked"
    | "approval-recorded"
    | "state-transitioned"
    | "side-effect-count";
  readonly assertion: string;
}

/** A safety constraint (criterion 4). */
export interface SafetyConstraint {
  readonly kind:
    | "authority-boundary"
    | "side-effect"
    | "data-boundary"
    | "prompt-injection-defense"
    | "secret-flow"
    | "human-confirmation";
  readonly constraint: string;
}

/** Controlled environment state the task runs against. */
export interface EnvironmentState {
  /** Declarative fixture keys the harness must provision before the run. */
  readonly fixtures: readonly string[];
  readonly description: string;
}

/** One golden task. */
export interface GoldenTask {
  /** Stable identity: `<scenarioId>#<zero-padded index>`. */
  readonly taskId: string;
  readonly family: WorkloadFamily;
  readonly scenarioId: string;
  readonly description: string;
  /** The customer task payload (the Zeck execution request's task). */
  readonly input: Readonly<Record<string, unknown>>;
  /** Controlled environment state (criterion 1). */
  readonly environmentState: EnvironmentState;
  /** Response-quality expectation (criterion 3). */
  readonly expectedOutcome: ExpectedOutcome;
  /** Forbidden outcomes — what must NEVER happen. */
  readonly forbiddenOutcomes: readonly string[];
  /** Actual environment/state effects (criterion 3 — separate from quality). */
  readonly expectedEnvironmentEffects?: readonly EnvironmentEffect[];
  /** Quality rubric (criterion 1). */
  readonly qualityRubric: readonly QualityCriterion[];
  /** Safety constraints (criterion 4). */
  readonly safetyConstraints: readonly SafetyConstraint[];
  /** Maximum acceptable latency where applicable. */
  readonly latencyTargetMs?: number;
  /** The evaluation contract (criterion 1/5). */
  readonly evaluation: {
    readonly method: EvaluationMethod;
    /** Tolerance description (required for the tolerance method). */
    readonly tolerance?: string;
    readonly detail: string;
  };
  /** Determinism classification (criterion 5). */
  readonly determinism: "deterministic" | "nondeterministic-tolerance";
  /**
   * Capabilities the scenario requires (recorded as neutral strings;
   * resolved by the VAL-009 capability matrix). Absent capabilities are
   * NOT RUN boundaries — never silent passes.
   */
  readonly requiresCapabilities?: readonly string[];
  /** Data provenance (criterion 7). */
  readonly provenance: {
    readonly source: "synthetic-authored";
    readonly license: "repository-license";
    readonly authoredFor: "zeck-validation";
    readonly external: false;
  };
}

/** One task-schema rejection finding. */
export interface TaskViolation {
  readonly taskId: string;
  readonly path: string;
  readonly reason: string;
}

const NON_EMPTY = /^.+$/;
const TASK_ID = /^[a-z0-9.-]+#[0-9]{3,}$/;
const FAMILY_SET = new Set<string>(WORKLOAD_FAMILIES);

/**
 * Validate one golden task against the schema. A task missing any
 * mandated part is rejected: identity, family, scenario, input,
 * environment state, expected outcome, at least one forbidden outcome,
 * a rubric whose weights sum to 1, safety constraints, an evaluation
 * contract consistent with its determinism classification, and
 * provenance.
 */
export function validateGoldenTask(task: GoldenTask): readonly TaskViolation[] {
  const violations: TaskViolation[] = [];
  const fail = (path: string, reason: string): void => {
    violations.push({ taskId: task?.taskId ?? "?", path, reason });
  };
  const requireText = (path: string, value: unknown): void => {
    if (typeof value !== "string" || !NON_EMPTY.test(value)) {
      fail(path, "must be a non-empty string");
    }
  };

  requireText("taskId", task?.taskId);
  if (typeof task?.taskId === "string" && !TASK_ID.test(task.taskId)) {
    fail("taskId", "must be <scenarioId>#<zero-padded index>");
  }
  if (!FAMILY_SET.has(task?.family ?? "")) {
    fail("family", "must be one of the required workload families");
  }
  requireText("scenarioId", task?.scenarioId);
  requireText("description", task?.description);
  if (task?.input === null || typeof task?.input !== "object" || Array.isArray(task?.input)) {
    fail("input", "must be a task payload object");
  }
  requireText("environmentState.description", task?.environmentState?.description);
  if (!Array.isArray(task?.environmentState?.fixtures)) {
    fail("environmentState.fixtures", "must be an array (possibly empty)");
  }

  const outcome = task?.expectedOutcome;
  if (
    outcome?.terminalStatus !== "COMPLETED" &&
    outcome?.terminalStatus !== "FAILED" &&
    outcome?.terminalStatus !== "CANCELLED"
  ) {
    fail("expectedOutcome.terminalStatus", "must be a terminal status");
  }
  if (!Array.isArray(task?.forbiddenOutcomes) || task.forbiddenOutcomes.length === 0) {
    fail("forbiddenOutcomes", "must list at least one forbidden outcome");
  }
  for (const effect of task?.expectedEnvironmentEffects ?? []) {
    requireText(`expectedEnvironmentEffects[${effect?.kind}].assertion`, effect?.assertion);
  }

  const rubric = task?.qualityRubric;
  if (!Array.isArray(rubric) || rubric.length === 0) {
    fail("qualityRubric", "must carry at least one criterion");
  } else {
    const weightSum = rubric.reduce((sum, criterion) => sum + (criterion?.weight ?? 0), 0);
    if (Math.abs(weightSum - 1) > 0.001) {
      fail("qualityRubric", `criterion weights must sum to 1 (observed ${weightSum})`);
    }
    for (const criterion of rubric) {
      requireText(`qualityRubric[${criterion?.name}].name`, criterion?.name);
      requireText(`qualityRubric[${criterion?.name}].measurement`, criterion?.measurement);
    }
  }

  if (!Array.isArray(task?.safetyConstraints) || task.safetyConstraints.length === 0) {
    fail("safetyConstraints", "must carry at least one safety constraint");
  }
  const evaluation = task?.evaluation;
  if (
    evaluation?.method !== "deterministic" &&
    evaluation?.method !== "tolerance" &&
    evaluation?.method !== "evaluator"
  ) {
    fail("evaluation.method", "must be deterministic, tolerance or evaluator");
  } else {
    if (evaluation.method === "tolerance" && typeof evaluation.tolerance !== "string") {
      fail("evaluation.tolerance", "the tolerance method must state its tolerance");
    }
    if (
      evaluation.method === "deterministic" &&
      task?.determinism === "nondeterministic-tolerance"
    ) {
      fail(
        "evaluation",
        "a deterministic evaluation cannot back a nondeterministic-tolerance task",
      );
    }
  }
  requireText("evaluation.detail", evaluation?.detail);
  if (task?.determinism !== "deterministic" && task?.determinism !== "nondeterministic-tolerance") {
    fail("determinism", "must classify determinism or nondeterministic-tolerance");
  }
  if (
    task?.latencyTargetMs !== undefined &&
    (typeof task.latencyTargetMs !== "number" || task.latencyTargetMs <= 0)
  ) {
    fail("latencyTargetMs", "must be a positive number when present");
  }
  if (task?.provenance?.source !== "synthetic-authored" || task?.provenance?.external !== false) {
    fail("provenance", "must record synthetic-authored provenance with no external material");
  }
  return violations;
}
