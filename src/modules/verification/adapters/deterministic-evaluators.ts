/**
 * Deterministic evaluators (verification module adapters; WORK-013).
 *
 * The deterministic-first evaluator bank (ADR-0007/0011 applied to
 * verification): schema validation, invariant assertions, digest
 * equality, exact matching and evidence-reference checks are established
 * by DETERMINISTIC code — never by a model call. These evaluators:
 *
 *   - import NO models/provider surface (M18: deterministic verification
 *     replaced by a hidden AI call is unrepresentable — the evaluator is
 *     pure code over the evidence bundle);
 *   - produce PASS only from EVIDENCE that satisfies the declared
 *     criteria (M4: an empty evidence bundle yields the honest
 *     INCONCLUSIVE, never PASS);
 *   - FAIL only when the evidence DEMONSTRATES the criteria are unmet;
 *   - are registered for exactly their criterion kinds (`establishes`)
 *     so selection can never hand a deterministic criterion to a judge.
 */

import type { CriterionKind } from "../domain/criteria";
import type { EvaluationOutcome, Evaluator, EvidenceBundle } from "../domain/evaluator";

type CriteriaSpec = Parameters<Evaluator["evaluate"]>[1];

const EMPTY_EVIDENCE: EvaluationOutcome = {
  status: "INCONCLUSIVE",
  observations: ["no evidence to assess (empty evidence bundle)"],
  evidenceRefs: [],
};

function hasEvidence(evidence: EvidenceBundle): boolean {
  return Object.keys(evidence.facts).length > 0 || evidence.evidenceRefs.length > 0;
}

function invariant(observations: string[], evidenceRefs: readonly string[]): EvaluationOutcome {
  return {
    status: observations.length === 0 ? "PASS" : "FAIL",
    observations: observations.length === 0 ? ["all assertions hold"] : observations,
    evidenceRefs,
  };
}

function navigate(facts: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = facts;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>).sort();
    const bKeys = Object.keys(b as Record<string, unknown>).sort();
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((key, index) => key === bKeys[index]) &&
      aKeys.every((key) =>
        deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

const TYPE_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
};

export const DETERMINISTIC_EVALUATOR_VERSION = "1";

/** `schema` criteria: declared field expectations over the evidence facts. */
export function createSchemaEvaluator(id = "schema-evaluator"): Evaluator {
  return {
    identity: { kind: "deterministic", id, version: DETERMINISTIC_EVALUATOR_VERSION },
    establishes: ["schema" satisfies CriterionKind],
    async evaluate(evidence, criteria: CriteriaSpec, _context): Promise<EvaluationOutcome> {
      if (!hasEvidence(evidence)) {
        return EMPTY_EVIDENCE;
      }
      const fields = (criteria.definition.fields ?? []) as readonly {
        name?: string;
        type?: string;
        required?: boolean;
      }[];
      const observations: string[] = [];
      for (const field of fields) {
        const name = field.name ?? "";
        const value = evidence.facts[name];
        const present = value !== undefined;
        if (!present) {
          if (field.required !== false) {
            observations.push(`required field "${name}" is absent from the evidence`);
          }
          continue;
        }
        const check = TYPE_CHECKS[field.type ?? ""];
        if (check === undefined) {
          observations.push(`field "${name}" has unknown declared type "${field.type}"`);
        } else if (!check(value)) {
          observations.push(
            `field "${name}" expected type ${field.type} but the evidence carries ${typeof value}`,
          );
        }
      }
      return invariant(observations, evidence.evidenceRefs);
    },
  };
}

/** `invariant` criteria: declarative assertions over evidence fact paths. */
export function createInvariantEvaluator(id = "invariant-evaluator"): Evaluator {
  return {
    identity: { kind: "deterministic", id, version: DETERMINISTIC_EVALUATOR_VERSION },
    establishes: ["invariant" satisfies CriterionKind],
    async evaluate(evidence, criteria: CriteriaSpec, _context): Promise<EvaluationOutcome> {
      if (!hasEvidence(evidence)) {
        return EMPTY_EVIDENCE;
      }
      const assertions = (criteria.definition.assertions ?? []) as readonly {
        path?: string;
        op?: string;
        value?: unknown;
      }[];
      const observations: string[] = [];
      for (const [index, assertion] of assertions.entries()) {
        const path = assertion.path ?? `assertions[${index}]`;
        const actual = navigate(evidence.facts, path);
        const op = assertion.op ?? "";
        switch (op) {
          case "exists": {
            const shouldExist = assertion.value !== false;
            if (shouldExist && actual === undefined) {
              observations.push(`path "${path}" does not exist`);
            }
            if (!shouldExist && actual !== undefined) {
              observations.push(`path "${path}" exists but must not`);
            }
            break;
          }
          case "type": {
            const check = TYPE_CHECKS[String(assertion.value)];
            if (check === undefined) {
              observations.push(
                `path "${path}" has unknown declared type "${String(assertion.value)}"`,
              );
            } else if (actual === undefined) {
              observations.push(
                `path "${path}" is absent (expected type ${String(assertion.value)})`,
              );
            } else if (!check(actual)) {
              observations.push(
                `path "${path}" expected type ${String(assertion.value)} but carries ${typeof actual}`,
              );
            }
            break;
          }
          case "eq": {
            if (actual === undefined) {
              observations.push(
                `path "${path}" is absent (expected ${JSON.stringify(assertion.value)})`,
              );
            } else if (!deepEqual(actual, assertion.value)) {
              observations.push(
                `path "${path}" is ${JSON.stringify(actual)} but must equal ${JSON.stringify(assertion.value)}`,
              );
            }
            break;
          }
          case "ne": {
            if (actual !== undefined && deepEqual(actual, assertion.value)) {
              observations.push(`path "${path}" must not equal ${JSON.stringify(assertion.value)}`);
            }
            break;
          }
          case "gt":
          case "gte":
          case "lt":
          case "lte": {
            if (typeof actual !== "number" || typeof assertion.value !== "number") {
              observations.push(`path "${path}" comparison ${op} requires numeric operands`);
              break;
            }
            const holds =
              op === "gt"
                ? actual > assertion.value
                : op === "gte"
                  ? actual >= assertion.value
                  : op === "lt"
                    ? actual < assertion.value
                    : actual <= assertion.value;
            if (!holds) {
              observations.push(`path "${path}" is ${actual} but must be ${op} ${assertion.value}`);
            }
            break;
          }
          case "contains": {
            if (!Array.isArray(actual)) {
              observations.push(`path "${path}" must be an array for the contains check`);
            } else if (!actual.some((item) => deepEqual(item, assertion.value))) {
              observations.push(
                `path "${path}" does not contain ${JSON.stringify(assertion.value)}`,
              );
            }
            break;
          }
          default: {
            observations.push(`unknown assertion op "${op}"`);
          }
        }
      }
      return invariant(observations, evidence.evidenceRefs);
    },
  };
}

/** `digest` criteria: declared content-digest equality over evidence facts. */
export function createDigestEvaluator(id = "digest-evaluator"): Evaluator {
  return {
    identity: { kind: "deterministic", id, version: DETERMINISTIC_EVALUATOR_VERSION },
    establishes: ["digest" satisfies CriterionKind],
    async evaluate(evidence, criteria: CriteriaSpec, _context): Promise<EvaluationOutcome> {
      if (!hasEvidence(evidence)) {
        return EMPTY_EVIDENCE;
      }
      const expected = criteria.definition.expected;
      const actual = evidence.facts.digest;
      if (typeof actual !== "string") {
        return {
          status: "INCONCLUSIVE",
          observations: ["no digest fact in the evidence (cannot establish digest equality)"],
          evidenceRefs: evidence.evidenceRefs,
        };
      }
      if (typeof expected !== "string") {
        return {
          status: "INCONCLUSIVE",
          observations: ["criterion declares no expected digest"],
          evidenceRefs: evidence.evidenceRefs,
        };
      }
      if (actual === expected) {
        return {
          status: "PASS",
          observations: [`digest ${actual} matches the declared expectation`],
          evidenceRefs: evidence.evidenceRefs,
        };
      }
      return {
        status: "FAIL",
        observations: [`digest ${actual} does not match the declared expectation ${expected}`],
        evidenceRefs: evidence.evidenceRefs,
      };
    },
  };
}

/** `exact-match` criteria: deep equality over the evidence value fact. */
export function createExactMatchEvaluator(id = "exact-match-evaluator"): Evaluator {
  return {
    identity: { kind: "deterministic", id, version: DETERMINISTIC_EVALUATOR_VERSION },
    establishes: ["exact-match" satisfies CriterionKind],
    async evaluate(evidence, criteria: CriteriaSpec, _context): Promise<EvaluationOutcome> {
      if (!hasEvidence(evidence)) {
        return EMPTY_EVIDENCE;
      }
      const expected = criteria.definition.expected;
      const actual = evidence.facts.value;
      if (actual === undefined) {
        return {
          status: "INCONCLUSIVE",
          observations: ["no value fact in the evidence (cannot establish equality)"],
          evidenceRefs: evidence.evidenceRefs,
        };
      }
      if (deepEqual(actual, expected)) {
        return {
          status: "PASS",
          observations: ["the evidence value equals the declared expectation"],
          evidenceRefs: evidence.evidenceRefs,
        };
      }
      return {
        status: "FAIL",
        observations: [
          `the evidence value ${JSON.stringify(actual)} does not equal the declared expectation ${JSON.stringify(expected)}`,
        ],
        evidenceRefs: evidence.evidenceRefs,
      };
    },
  };
}

/** `reference` criteria: required durable evidence references exist. */
export function createReferenceEvaluator(id = "reference-evaluator"): Evaluator {
  return {
    identity: { kind: "deterministic", id, version: DETERMINISTIC_EVALUATOR_VERSION },
    establishes: ["reference" satisfies CriterionKind],
    async evaluate(evidence, criteria: CriteriaSpec, _context): Promise<EvaluationOutcome> {
      if (!hasEvidence(evidence)) {
        return EMPTY_EVIDENCE;
      }
      const requiredRefs = (criteria.definition.requiredRefs ?? []) as readonly string[];
      const missing = requiredRefs.filter((ref) => !evidence.evidenceRefs.includes(ref));
      if (missing.length === 0) {
        return {
          status: "PASS",
          observations: [`all ${requiredRefs.length} required evidence references are present`],
          evidenceRefs: evidence.evidenceRefs,
        };
      }
      return {
        status: "FAIL",
        observations: missing.map((ref) => `required evidence reference "${ref}" is missing`),
        evidenceRefs: evidence.evidenceRefs,
      };
    },
  };
}

/** The full deterministic bank (all five kinds). */
export function createDeterministicEvaluatorBank(): readonly Evaluator[] {
  return [
    createSchemaEvaluator(),
    createInvariantEvaluator(),
    createDigestEvaluator(),
    createExactMatchEvaluator(),
    createReferenceEvaluator(),
  ];
}
