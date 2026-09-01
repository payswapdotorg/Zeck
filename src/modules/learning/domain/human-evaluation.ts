/**
 * Selective human evaluation of uncertain findings (learning module
 * domain; WORK-022 / HUM-001, HUM-003; ADR-0009, ADR-0012).
 *
 * THE VALUE-OF-INFORMATION GATE (§13): a human evaluation prompt is
 * emitted ONLY when the expected information gain of the rating
 * EXCEEDS the configured user-friction threshold. The decision is a
 * DETERMINISTIC pure function of (confidence level, finding class,
 * impact basis) — never a heuristic guess, never unconditional.
 *
 * THE SUFFICIENT-EVIDENCE RULE (§12/M24): when automated evidence is
 * already sufficient (confidence 'medium' or 'high'), NO prompt is
 * emitted — do not ask for ratings when automated evidence is already
 * sufficient.
 *
 * THE REQUIRED-UNCERTAINTY RULE (M25): when a material recommendation
 * is uncertain ('low'/'inconclusive') the prompt IS emitted (gain
 * exceeds the default threshold) — omitting it is a detectable
 * violation.
 *
 * THE SMALLEST USEFUL QUESTION (§12): every prompt carries exactly one
 * bounded question drawn from the frozen question kinds:
 *   - pair-preference        "Which output is better?"
 *   - behavior-preservation  "Did these two results preserve the intended behavior?"
 *   - replacement-acceptability "Was this replacement acceptable?"
 *
 * Prompts are ADVISORY REQUESTS for evidence — they are never
 * authorization, never verification PASS, never a state transition of
 * the finding (the rating that answers a prompt is recorded by the
 * analyzer as immutable evaluation evidence; see evaluation-rating.ts).
 */

import { PlatformError } from "../../../shared/errors";
import type { OpportunityFinding } from "./opportunity-analysis";

/** Frozen evaluation-prompt schema version. */
export const EVALUATION_PROMPT_SCHEMA_VERSION = 1;

/** The frozen question-kind vocabulary (the smallest useful questions). */
export const EVALUATION_QUESTION_KINDS = [
  "pair-preference",
  "behavior-preservation",
  "replacement-acceptability",
] as const;

export type EvaluationQuestionKind = (typeof EVALUATION_QUESTION_KINDS)[number];

export function isEvaluationQuestionKind(value: string): value is EvaluationQuestionKind {
  return (EVALUATION_QUESTION_KINDS as readonly string[]).includes(value);
}

/** The canonical question text per kind (§12 examples, verbatim). */
export const EVALUATION_QUESTIONS: Readonly<Record<EvaluationQuestionKind, string>> = {
  "pair-preference": "Which output is better?",
  "behavior-preservation": "Did these two results preserve the intended behavior?",
  "replacement-acceptability": "Was this replacement acceptable?",
};

/**
 * The deterministic expected-information-gain table (§13). The gain of
 * a rating is a pure function of the remaining automated uncertainty:
 * the less the automated evidence resolves, the more a human rating is
 * worth.
 */
export const EXPECTED_INFORMATION_GAIN: Readonly<Record<string, number>> = {
  inconclusive: 0.9,
  low: 0.6,
  medium: 0.25,
  high: 0.05,
};

/** Confidence levels whose automated evidence is INSUFFICIENT (M24/M25). */
export const UNCERTAIN_CONFIDENCE_LEVELS: readonly string[] = ["low", "inconclusive"];

/** The bounded friction configuration (§13). */
export interface FrictionConfig {
  /** The user-friction threshold in (0,1) — prompts require gain > threshold. */
  readonly userFrictionThreshold: number;
  /** The maximum prompts per analysis (bounded human cost). */
  readonly maxPrompts: number;
}

/** The default user-friction threshold (overridable per request). */
export const DEFAULT_USER_FRICTION_THRESHOLD = 0.5;

/** The default maximum prompts per analysis (bounded human cost). */
export const DEFAULT_MAX_PROMPTS = 8;

export const DEFAULT_FRICTION_CONFIG: FrictionConfig = {
  userFrictionThreshold: DEFAULT_USER_FRICTION_THRESHOLD,
  maxPrompts: DEFAULT_MAX_PROMPTS,
};

/** One human-evaluation prompt (advisory evidence request). */
export interface EvaluationPrompt {
  readonly promptId: string;
  readonly analysisId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly findingId: string;
  readonly questionKind: EvaluationQuestionKind;
  readonly question: string;
  /** Deterministic expected information gain in [0,1]. */
  readonly expectedInformationGain: number;
  /** The configured threshold the gain had to EXCEED (strict). */
  readonly userFrictionThreshold: number;
  /** Why this prompt was emitted (non-empty, recorded basis). */
  readonly basis: readonly string[];
  readonly emittedAt: string;
  readonly schemaVersion: number;
}

/** Map a finding class to the smallest useful question kind. */
export function questionKindForClass(
  findingClass: OpportunityFinding["class"],
): EvaluationQuestionKind {
  switch (findingClass) {
    case "deterministic-replacement":
    case "ai-removal":
      // The material question for a replacement candidate: did the two
      // results preserve the intended behavior?
      return "behavior-preservation";
    case "ai-addition":
    case "tool-replacement":
    case "tool-composition":
    case "hybrid-decomposition":
      // Comparing candidate strategies: which output is better?
      return "pair-preference";
    case "human-evaluation":
    case "context-enhancement":
    case "verification-enhancement":
      return "replacement-acceptability";
  }
}

/**
 * THE VALUE-OF-INFORMATION DECISION (§13, deterministic): emit a prompt
 * for a finding ONLY when
 *   (a) the automated evidence is insufficient ('low'/'inconclusive'
 *       confidence — M24: sufficient evidence never prompts), AND
 *   (b) the decision is material (a replacement decision or an impact
 *       the rating could change), AND
 *   (c) expectedInformationGain > userFrictionThreshold (STRICT —
 *       equality does not justify user effort).
 * Prompts are bounded by `maxPrompts` (the cheapest-uncertainty-first
 * ordering is deterministic: highest gain, then finding id).
 */
export function decideEvaluationPrompts(
  findings: readonly OpportunityFinding[],
  config: FrictionConfig,
): readonly {
  readonly findingId: string;
  readonly questionKind: EvaluationQuestionKind;
  readonly question: string;
  readonly expectedInformationGain: number;
  readonly userFrictionThreshold: number;
  readonly basis: readonly string[];
}[] {
  if (
    !Number.isFinite(config.userFrictionThreshold) ||
    config.userFrictionThreshold <= 0 ||
    config.userFrictionThreshold >= 1
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "userFrictionThreshold must be a number in (0,1)",
      details: { got: config.userFrictionThreshold },
    });
  }
  if (!Number.isInteger(config.maxPrompts) || config.maxPrompts < 1 || config.maxPrompts > 64) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "maxPrompts must be an integer in [1,64]",
      details: { got: config.maxPrompts },
    });
  }

  const candidates: {
    readonly findingId: string;
    readonly questionKind: EvaluationQuestionKind;
    readonly question: string;
    readonly expectedInformationGain: number;
    readonly userFrictionThreshold: number;
    readonly basis: readonly string[];
  }[] = [];

  for (const finding of findings) {
    const level = finding.confidence.level;
    // (a) sufficient-evidence rule (M24): medium/high never prompt.
    if (!UNCERTAIN_CONFIDENCE_LEVELS.includes(level)) {
      continue;
    }
    const gain = EXPECTED_INFORMATION_GAIN[level] ?? 0;
    // (b) materiality: replacement decisions and measured/estimated
    // impacts are the decisions a rating can inform.
    const material =
      finding.class === "human-evaluation" ||
      finding.class === "deterministic-replacement" ||
      finding.class === "ai-removal" ||
      finding.class === "hybrid-decomposition" ||
      finding.costImpact.basis !== "unknown" ||
      finding.latencyImpact.basis !== "unknown";
    if (!material) {
      continue;
    }
    // (c) the strict value-of-information gate (§13).
    if (gain <= config.userFrictionThreshold) {
      continue;
    }
    const questionKind = questionKindForClass(finding.class);
    candidates.push({
      findingId: finding.findingId,
      questionKind,
      question: EVALUATION_QUESTIONS[questionKind],
      expectedInformationGain: gain,
      userFrictionThreshold: config.userFrictionThreshold,
      basis: [
        `confidence=${level}`,
        `population=${finding.confidence.population}`,
        `gain=${gain}>threshold=${config.userFrictionThreshold}`,
        `class=${finding.class}`,
      ],
    });
  }

  // Deterministic ordering: highest gain first, then finding id.
  candidates.sort((a, b) =>
    a.expectedInformationGain !== b.expectedInformationGain
      ? b.expectedInformationGain - a.expectedInformationGain
      : a.findingId < b.findingId
        ? -1
        : 1,
  );
  return candidates.slice(0, config.maxPrompts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed closed-shape validation of a prompt (round-trip). */
export function validateEvaluationPrompt(value: unknown): asserts value is EvaluationPrompt {
  if (!isRecord(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "prompt must be an object" });
  }
  const prompt = value;
  for (const key of [
    "promptId",
    "analysisId",
    "applicationId",
    "tenantId",
    "findingId",
    "question",
    "emittedAt",
  ] as const) {
    const field = prompt[key];
    if (typeof field !== "string" || field.length === 0 || field.length > 512) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `prompt ${key} must be a non-empty string`,
        details: { field: key },
      });
    }
  }
  if (typeof prompt.questionKind !== "string" || !isEvaluationQuestionKind(prompt.questionKind)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "prompt questionKind must be the closed question vocabulary",
      details: { allowed: EVALUATION_QUESTION_KINDS },
    });
  }
  for (const key of ["expectedInformationGain", "userFrictionThreshold"] as const) {
    const number = prompt[key];
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 1) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `prompt ${key} must be a number in [0,1]`,
        details: { field: key },
      });
    }
  }
  // M24 (physical half): a persisted prompt MUST satisfy the strict
  // value-of-information inequality.
  if (
    typeof prompt.expectedInformationGain === "number" &&
    typeof prompt.userFrictionThreshold === "number" &&
    prompt.expectedInformationGain <= prompt.userFrictionThreshold
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "prompt violates the value-of-information gate (expectedInformationGain must EXCEED userFrictionThreshold — M24)",
    });
  }
  const basis = prompt.basis;
  if (
    !Array.isArray(basis) ||
    basis.length === 0 ||
    basis.some((item) => typeof item !== "string")
  ) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "prompt basis must be non-empty (the recorded VOI decision basis)",
    });
  }
  if (prompt.schemaVersion !== EVALUATION_PROMPT_SCHEMA_VERSION) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "prompt schemaVersion must match the frozen prompt schema",
      details: { expected: EVALUATION_PROMPT_SCHEMA_VERSION },
    });
  }
}
