/**
 * Structured task profile (planning module domain; WORK-009 / INT-001,
 * ADR-0007, ADR-0011).
 *
 * The `TaskProfile` is the planner's FIRST artifact: a structured,
 * deterministically-derived description of WHAT the task needs, produced
 * BEFORE any capability resolution, deterministic-sufficiency evaluation
 * or (much later) provider/model selection. Derivation is PURE — no AI is
 * used to profile a task ("do not introduce hidden AI calls to perform
 * work that an admissible deterministic capability can perform"):
 * the profile is rule-derived from the declared task input, constraints,
 * required output characteristics, risk and quality targets.
 *
 * Determinism rules (documented, tested):
 *  - `kind` MUST be declared by the task author (fail closed when absent
 *    or outside the frozen vocabulary).
 *  - `requiresSemanticReasoning` is derived from the kind's frozen table
 *    and may only be overridden DOWNWARD by an explicit task declaration
 *    (`semanticReasoning: false` asserts the author's determinism claim);
 *    an explicit `true` never overrides a deterministic kind upward
 *    silently — it must match the kind table or the profile is rejected
 *    (an inconsistent declaration is a task-authoring error).
 *  - capability requirements are derived from the kind's frozen table;
 *    `mixed` tasks MUST declare their requirements explicitly.
 */

import { PlatformError } from "../../../shared/errors";
import type { CapabilityRequirement } from "../../capabilities/public";

/** Frozen task-kind vocabulary (ADR-0007 examples → typed kinds). */
export const TASK_KINDS = [
  "arithmetic",
  "data-retrieval",
  "transformation",
  "validation",
  "generation",
  "interpretation",
  "analysis",
  "mixed",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

/** Risk vocabulary for a task (drives verification strength upstream). */
export const TASK_RISK_LEVELS = ["low", "medium", "high"] as const;

export type TaskRiskLevel = (typeof TASK_RISK_LEVELS)[number];

/** Does the kind table demand semantic/generative reasoning by default? */
const SEMANTIC_BY_KIND: Readonly<Record<TaskKind, boolean>> = {
  arithmetic: false,
  "data-retrieval": false,
  transformation: false,
  validation: false,
  generation: true,
  interpretation: true,
  analysis: true,
  mixed: true,
};

/** The kind table's derived capability requirements (deterministic facets). */
const REQUIREMENTS_BY_KIND: Readonly<Record<TaskKind, readonly CapabilityRequirement[]>> = {
  arithmetic: [{ id: "numeric-computation", kind: "algorithm", minVersion: "1.0.0" }],
  "data-retrieval": [{ id: "structured-dataset-read", kind: "data", minVersion: "1.0.0" }],
  transformation: [{ id: "deterministic-transform", kind: "algorithm", minVersion: "1.0.0" }],
  validation: [{ id: "json-schema-validation", kind: "algorithm", minVersion: "1.0.0" }],
  generation: [{ id: "text-generation", kind: "model", minVersion: "1.0.0" }],
  interpretation: [{ id: "text-generation", kind: "model", minVersion: "1.0.0" }],
  analysis: [
    { id: "document-retrieval", kind: "tool", minVersion: "1.0.0" },
    { id: "text-generation", kind: "model", minVersion: "1.0.0" },
  ],
  mixed: [], // MUST be declared explicitly (fail closed).
};

/** Required output characteristics (what the produced output must be). */
export interface OutputCharacteristics {
  /** Output type vocabulary is task-declared (e.g. `number`, `json`, `text`). */
  readonly type: string;
  /** Required output format/shape hint (opaque, carried to verification). */
  readonly format?: string;
  /** Must the output be structurally validatable? */
  readonly structured?: boolean;
}

/** The structured, digest-stable task profile (INT-001). */
export interface TaskProfile {
  /** Canonical serialization digest of the derivation inputs (identity). */
  readonly profileDigest: string;
  readonly kind: TaskKind;
  /** The declared task input (closed JSON universe only). */
  readonly input: Readonly<Record<string, unknown>>;
  readonly outputCharacteristics: OutputCharacteristics;
  readonly riskLevel: TaskRiskLevel;
  /** 0..1 quality target (constraints override task declaration). */
  readonly qualityTarget: number;
  /** Cost ceiling as an integer micro-USD string, when constrained. */
  readonly maxCostMicroUsd?: string;
  /** Latency ceiling in milliseconds, when constrained. */
  readonly maxLatencyMs?: number;
  /**
   * Does this task require semantic/generative reasoning? Derived from the
   * kind table; the deterministic-first pipeline evaluates sufficiency
   * against this BEFORE any provider/model selection.
   */
  readonly requiresSemanticReasoning: boolean;
  /** Capability requirements resolved BEFORE any route selection (INT-002). */
  readonly capabilityRequirements: readonly CapabilityRequirement[];
}

/** Task constraints as accepted by the profiler (executions-shaped). */
export interface TaskConstraintInput {
  readonly maxCostMicroUsd?: string;
  readonly maxLatencyMs?: number;
  readonly minQuality?: number;
  readonly [key: string]: unknown;
}

export interface DeriveTaskProfileInput {
  readonly task: Readonly<Record<string, unknown>>;
  readonly constraints?: TaskConstraintInput;
}

const MICRO_USD = /^\d{1,19}$/;

function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === "string" && (TASK_KINDS as readonly string[]).includes(value);
}

function isRiskLevel(value: unknown): value is TaskRiskLevel {
  return typeof value === "string" && (TASK_RISK_LEVELS as readonly string[]).includes(value);
}

function reject(message: string, details?: Record<string, unknown>): never {
  throw new PlatformError({ code: "POLICY_DENIED", message, details });
}

/**
 * Derive the structured task profile from the declared task input and
 * constraints. Pure, total over valid inputs, fail-closed typed on invalid
 * ones. The profile digest is computed over the canonical derivation
 * inputs by the injected digest function (server-derived identity).
 */
export function deriveTaskProfile(
  input: DeriveTaskProfileInput,
  digest: (value: unknown) => string,
): TaskProfile {
  const task = input.task;
  if (task === null || typeof task !== "object" || Array.isArray(task)) {
    reject("task must be a non-empty object");
  }
  if (Object.keys(task).length === 0) {
    reject("task must be a non-empty object");
  }

  const kindUnknown = task.kind;
  if (!isTaskKind(kindUnknown)) {
    reject("task.kind must be one of the frozen task kinds", {
      got: String(kindUnknown),
      allowed: [...TASK_KINDS],
    });
  }
  const kind = kindUnknown;

  const taskInput = task.input;
  if (taskInput === null || typeof taskInput !== "object" || Array.isArray(taskInput)) {
    reject("task.input must be an object carrying the task payload");
  }

  // Output characteristics: declared with a validated closed shape.
  const declaredOutput = task.outputCharacteristics;
  let outputCharacteristics: OutputCharacteristics;
  if (declaredOutput === undefined) {
    outputCharacteristics = { type: "unknown" };
  } else if (
    typeof declaredOutput !== "object" ||
    declaredOutput === null ||
    Array.isArray(declaredOutput)
  ) {
    reject("task.outputCharacteristics must be an object when present");
  } else {
    const record = declaredOutput as Record<string, unknown>;
    if (typeof record.type !== "string" || record.type.length === 0) {
      reject("task.outputCharacteristics.type must be a non-empty string");
    }
    if (record.format !== undefined && typeof record.format !== "string") {
      reject("task.outputCharacteristics.format must be a string when present");
    }
    if (record.structured !== undefined && typeof record.structured !== "boolean") {
      reject("task.outputCharacteristics.structured must be a boolean when present");
    }
    outputCharacteristics = {
      type: record.type,
      ...(record.format === undefined ? {} : { format: record.format }),
      ...(record.structured === undefined ? {} : { structured: record.structured }),
    };
  }

  // Risk level: declared or defaulted conservatively to `medium`.
  const declaredRisk = task.riskLevel ?? "medium";
  if (!isRiskLevel(declaredRisk)) {
    reject("task.riskLevel must be one of the frozen risk levels", {
      got: String(declaredRisk),
      allowed: [...TASK_RISK_LEVELS],
    });
  }

  // Quality target: constraints win over the task declaration; both must
  // be sane 0..1 numbers (floats allowed HERE — quality is a probability,
  // never a monetary amount; canonicalization only covers digest inputs).
  const constraints = input.constraints;
  let qualityTarget: number;
  if (constraints?.minQuality !== undefined) {
    qualityTarget = constraints.minQuality;
  } else if (task.qualityTarget !== undefined) {
    qualityTarget = task.qualityTarget as number;
  } else {
    qualityTarget = 0.8;
  }
  if (typeof qualityTarget !== "number" || !Number.isFinite(qualityTarget)) {
    reject("quality target must be a finite number (0..1)");
  }
  if (qualityTarget < 0 || qualityTarget > 1) {
    reject("quality target must be within 0..1", { got: qualityTarget });
  }

  let maxCostMicroUsd: string | undefined;
  if (constraints?.maxCostMicroUsd !== undefined) {
    maxCostMicroUsd = constraints.maxCostMicroUsd;
  } else if (task.maxCostMicroUsd !== undefined) {
    maxCostMicroUsd = task.maxCostMicroUsd as string;
  }
  if (maxCostMicroUsd !== undefined && !MICRO_USD.test(maxCostMicroUsd)) {
    reject("maxCostMicroUsd must be an integer micro-USD string (no floats)", {
      got: String(maxCostMicroUsd),
    });
  }

  let maxLatencyMs: number | undefined;
  if (constraints?.maxLatencyMs !== undefined) {
    maxLatencyMs = constraints.maxLatencyMs;
  } else if (task.maxLatencyMs !== undefined) {
    maxLatencyMs = task.maxLatencyMs as number;
  }
  if (maxLatencyMs !== undefined && (!Number.isInteger(maxLatencyMs) || maxLatencyMs < 0)) {
    reject("maxLatencyMs must be a non-negative integer", { got: String(maxLatencyMs) });
  }

  // Semantic reasoning: kind table + explicit-declaration reconciliation
  // (downward override only; inconsistent upward declarations rejected).
  const kindSemantic = SEMANTIC_BY_KIND[kind];
  const declaredSemantic = task.semanticReasoning;
  if (declaredSemantic !== undefined && typeof declaredSemantic !== "boolean") {
    reject("task.semanticReasoning must be a boolean when present");
  }
  let requiresSemanticReasoning = kindSemantic;
  if (declaredSemantic === true && !kindSemantic) {
    reject(
      "task.semanticReasoning=true contradicts the deterministic task kind (author the task with a semantic kind instead)",
      { kind },
    );
  }
  if (declaredSemantic === false && kindSemantic) {
    // Explicit determinism claim narrows semantic kinds downward (dropping
    // the kind table's model/human requirements below); an author who
    // declares `mixed` + requirements + semanticReasoning=false owns all
    // three declarations consistently.
    requiresSemanticReasoning = false;
  }

  // Capability requirements: kind table, or explicit declaration for mixed.
  let capabilityRequirements: readonly CapabilityRequirement[];
  const declaredReqs = task.requiredCapabilities;
  if (declaredReqs !== undefined) {
    if (!Array.isArray(declaredReqs)) {
      reject("task.requiredCapabilities must be an array when present");
    }
    capabilityRequirements = declaredReqs.map((requirement) => {
      if (requirement === null || typeof requirement !== "object") {
        reject("each required capability must be an object");
      }
      const record = requirement as Record<string, unknown>;
      if (typeof record.id !== "string" || record.id.length === 0) {
        reject("each required capability must carry a non-empty id");
      }
      if (
        record.kind !== "model" &&
        record.kind !== "tool" &&
        record.kind !== "algorithm" &&
        record.kind !== "data" &&
        record.kind !== "runtime" &&
        record.kind !== "human"
      ) {
        reject("each required capability must carry a frozen-kind `kind`", {
          got: String(record.kind),
        });
      }
      return {
        id: record.id,
        kind: record.kind,
        ...(record.minVersion === undefined ? {} : { minVersion: String(record.minVersion) }),
      };
    });
  } else if (kind === "mixed") {
    reject(
      "task.kind=mixed requires task.requiredCapabilities to be declared explicitly (fail closed)",
    );
  } else {
    capabilityRequirements = [...REQUIREMENTS_BY_KIND[kind]];
    if (!requiresSemanticReasoning) {
      // The downward determinism claim drops the table's model/human
      // requirements — they exist only for the semantic facet.
      capabilityRequirements = capabilityRequirements.filter(
        (requirement) => requirement.kind !== "model" && requirement.kind !== "human",
      );
    }
  }
  if (capabilityRequirements.length === 0) {
    // A kind whose entire requirement table was semantic cannot be planned
    // deterministically by declaration — author it as a semantic kind.
    reject(
      "task profile must carry at least one capability requirement (a purely semantic kind cannot be narrowed to deterministic)",
      { kind },
    );
  }
  if (!requiresSemanticReasoning) {
    const generativeRequirement = capabilityRequirements.find(
      (requirement) => requirement.kind === "model" || requirement.kind === "human",
    );
    if (generativeRequirement !== undefined) {
      reject(
        "a deterministic task kind must not declare model/human capability requirements (author the task with a semantic kind instead)",
        { requirementId: generativeRequirement.id },
      );
    }
  }

  const profile: Omit<TaskProfile, "profileDigest"> = {
    kind,
    input: taskInput as Readonly<Record<string, unknown>>,
    outputCharacteristics,
    riskLevel: declaredRisk,
    qualityTarget,
    ...(maxCostMicroUsd === undefined ? {} : { maxCostMicroUsd }),
    ...(maxLatencyMs === undefined ? {} : { maxLatencyMs }),
    requiresSemanticReasoning,
    capabilityRequirements,
  };

  return {
    ...profile,
    profileDigest: digest({
      profileSchema: 1,
      kind,
      input: taskInput,
      outputCharacteristics,
      riskLevel: declaredRisk,
      qualityTarget,
      maxCostMicroUsd: maxCostMicroUsd ?? null,
      maxLatencyMs: maxLatencyMs ?? null,
      requiresSemanticReasoning,
      capabilityRequirements,
    }),
  };
}
