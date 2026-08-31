/**
 * Verification criteria (verification module domain; WORK-013, VER-001/002).
 *
 * The DECLARED evaluation contract: what "verified" means for a target.
 * A VerificationResult can never exist without a criteria binding —
 * `spec/architecture.md` §18 ("A successful provider call is never itself
 * sufficient evidence of task correctness") and the WORK-013 result model
 * ("Against what criteria?" is a first-class question) make the criteria
 * the load-bearing identity of every verification statement.
 *
 * Criteria are DECLARED (registered) before use, immutable once declared,
 * and versioned: a new definition is a NEW version, never an edit
 * (revision/provenance-bound evidence — architecture-lock invariant 6's
 * evidence discipline). `criterionId + version` is the criteria identity
 * recorded on every result.
 *
 * `kind` decides how the criterion CAN be established (the
 * deterministic-first rule, ADR-0007/0011, applied to verification):
 *
 *   - `schema`           — a declared field schema the evidence must satisfy
 *   - `invariant`        — declarative assertions over evidence facts
 *   - `digest`           — expected content digest (checksum equality)
 *   - `exact-match`      — deep equality against an expected value
 *   - `reference`        — required durable evidence references exist
 *   - `model-judged`     — semantic judgment only a model can produce
 *                          (evaluator ADAPTER, never authority — see
 *                          `ports/evaluator.ts`)
 *   - `human-judged`     — explicit human/user decision required
 *                          (ADR-0009/0012: selective human evaluation)
 *
 * Deterministic kinds (schema/invariant/digest/exact-match/reference) MUST
 * be established by deterministic evaluators — never by a model call
 * (the "deterministic verification replaced by hidden AI call" mutant is
 * unrepresentable in evaluator selection: `establishes` is kind-bound).
 */

export const CRITERION_KINDS = [
  "schema",
  "invariant",
  "digest",
  "exact-match",
  "reference",
  "model-judged",
  "human-judged",
] as const;

export type CriterionKind = (typeof CRITERION_KINDS)[number];

/** Kinds a deterministic evaluator may establish (never model-dispatched). */
export const DETERMINISTIC_CRITERION_KINDS: readonly CriterionKind[] = [
  "schema",
  "invariant",
  "digest",
  "exact-match",
  "reference",
];

/** Kinds that require a semantic judge (model adapter or human decision). */
export const JUDGED_CRITERION_KINDS: readonly CriterionKind[] = ["model-judged", "human-judged"];

export function isCriterionKind(value: string): value is CriterionKind {
  return (CRITERION_KINDS as readonly string[]).includes(value);
}

export function isDeterministicCriterionKind(kind: CriterionKind): boolean {
  return DETERMINISTIC_CRITERION_KINDS.includes(kind);
}

/**
 * The declared criteria record (the durable, immutable declaration).
 * `definition` is the kind-specific expectation payload:
 *
 *   - schema:     { fields: [{ name, type, required? }] }
 *   - invariant:  { assertions: [{ path, op, value? }] }
 *   - digest:     { algorithm: "sha256", expected: "<hex>" }
 *   - exact-match:{ expected: <json value> }
 *   - reference:  { requiredRefs: ["<evidence ref>", ...] }
 *   - model-judged:   { rubric: "<what the judge assesses>" }
 *   - human-judged:   { question: "<what the human answers>" }
 */
export interface VerificationCriteria {
  readonly criterionId: string;
  readonly version: number;
  readonly kind: CriterionKind;
  /** Gate-blocking when unmet (required criteria must all PASS to conclude met). */
  readonly required: boolean;
  readonly description: string;
  readonly definition: Readonly<Record<string, unknown>>;
}

export interface CriteriaDeclarationIssues {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "exists", "type", "contains"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validAssertion(assertion: unknown, index: number): string | null {
  if (!isPlainObject(assertion)) {
    return `assertions[${index}] must be an object`;
  }
  if (typeof assertion.path !== "string" || assertion.path.length === 0) {
    return `assertions[${index}].path must be a non-empty string`;
  }
  const op = assertion.op;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) {
    return `assertions[${index}].op must be one of ${OPS.join("|")}`;
  }
  if (
    (op === "eq" || op === "ne" || op === "gt" || op === "gte" || op === "lt" || op === "lte") &&
    !("value" in assertion)
  ) {
    return `assertions[${index}].op ${op} requires a value`;
  }
  if (op === "type" && typeof assertion.value !== "string") {
    return `assertions[${index}].op type requires a string value`;
  }
  return null;
}

function validField(field: unknown, index: number): string | null {
  if (!isPlainObject(field)) {
    return `fields[${index}] must be an object`;
  }
  if (typeof field.name !== "string" || field.name.length === 0) {
    return `fields[${index}].name must be a non-empty string`;
  }
  if (typeof field.type !== "string" || field.type.length === 0) {
    return `fields[${index}].type must be a non-empty string`;
  }
  if (field.required !== undefined && typeof field.required !== "boolean") {
    return `fields[${index}].required must be a boolean`;
  }
  return null;
}

/**
 * Validate a criteria declaration BEFORE it becomes durable (the
 * registry-admission discipline: malformed criteria are rejected, never
 * stored — a criterion that cannot be evaluated can never gate anything).
 */
export function validateCriteriaDeclaration(criteria: {
  criterionId?: unknown;
  version?: unknown;
  kind?: unknown;
  required?: unknown;
  description?: unknown;
  definition?: unknown;
}): CriteriaDeclarationIssues {
  const issues: string[] = [];
  if (typeof criteria.criterionId !== "string" || criteria.criterionId.length < 1) {
    issues.push("criterionId must be a non-empty string");
  } else if (criteria.criterionId.length > 200) {
    issues.push("criterionId must be at most 200 characters");
  }
  if (
    typeof criteria.version !== "number" ||
    !Number.isInteger(criteria.version) ||
    criteria.version < 1
  ) {
    issues.push("version must be a positive integer");
  }
  if (typeof criteria.kind !== "string" || !isCriterionKind(criteria.kind)) {
    issues.push(`kind must be one of ${CRITERION_KINDS.join("|")}`);
  }
  if (criteria.required !== undefined && typeof criteria.required !== "boolean") {
    issues.push("required must be a boolean when present");
  }
  if (typeof criteria.description !== "string" || criteria.description.length === 0) {
    issues.push("description must be a non-empty string");
  }
  if (!isPlainObject(criteria.definition)) {
    issues.push("definition must be an object");
  } else if (criteria.kind === "schema") {
    const fields = criteria.definition.fields;
    if (!Array.isArray(fields) || fields.length === 0) {
      issues.push("schema definition requires a non-empty fields array");
    } else {
      for (let index = 0; index < fields.length; index += 1) {
        const issue = validField(fields[index], index);
        if (issue !== null) {
          issues.push(issue);
        }
      }
    }
  } else if (criteria.kind === "invariant") {
    const assertions = criteria.definition.assertions;
    if (!Array.isArray(assertions) || assertions.length === 0) {
      issues.push("invariant definition requires a non-empty assertions array");
    } else {
      for (let index = 0; index < assertions.length; index += 1) {
        const issue = validAssertion(assertions[index], index);
        if (issue !== null) {
          issues.push(issue);
        }
      }
    }
  } else if (criteria.kind === "digest") {
    if (
      criteria.definition.algorithm !== "sha256" ||
      typeof criteria.definition.expected !== "string" ||
      criteria.definition.expected.length === 0
    ) {
      issues.push("digest definition requires algorithm sha256 and a non-empty expected digest");
    }
  } else if (criteria.kind === "exact-match") {
    if (!("expected" in criteria.definition)) {
      issues.push("exact-match definition requires an expected value");
    }
  } else if (criteria.kind === "reference") {
    const refs = criteria.definition.requiredRefs;
    if (
      !Array.isArray(refs) ||
      refs.length === 0 ||
      refs.some((ref) => typeof ref !== "string" || ref.length === 0)
    ) {
      issues.push("reference definition requires a non-empty requiredRefs string array");
    }
  } else if (criteria.kind === "model-judged") {
    if (typeof criteria.definition.rubric !== "string" || criteria.definition.rubric.length === 0) {
      issues.push("model-judged definition requires a non-empty rubric");
    }
  } else if (criteria.kind === "human-judged") {
    if (
      typeof criteria.definition.question !== "string" ||
      criteria.definition.question.length === 0
    ) {
      issues.push("human-judged definition requires a non-empty question");
    }
  }
  return { ok: issues.length === 0, issues };
}

/** Content digest of a criteria declaration (redeclare convergence check). */
export function criteriaFingerprint(criteria: VerificationCriteria): string {
  const canonical = JSON.stringify([
    criteria.criterionId,
    criteria.version,
    criteria.kind,
    criteria.required,
    criteria.description,
    canonicalValue(criteria.definition),
  ]);
  // Deterministic structural fingerprint (not a security boundary — the
  // store's unique key is the identity; this detects definition drift on
  // redeclare).
  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) | 0;
  }
  return `fp-${(hash >>> 0).toString(16)}-${canonical.length}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]);
  }
  return value;
}
