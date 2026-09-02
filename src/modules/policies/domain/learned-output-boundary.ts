/**
 * The learned-output restriction-vocabulary boundary (policies module
 * domain; WORK-020 / LRN-002, `spec/architecture.md` §2.11/§16).
 *
 * HARD POLICY PROHIBITIONS ARE IMMUTABLE TO LEARNING OUTPUT (the
 * Work Order's acceptance criterion 2, mechanically enforced here):
 * a learned output record (a learned planning policy, a
 * recommendation, any learning-produced artifact) may carry ONLY
 * advisory preference semantics. It may NEVER carry the policy
 * restriction vocabulary — the typed leaf fields through which the
 * policy authority expresses prohibitions:
 *
 *   maxCostMicroUsd, minQuality, maxLatencyMs,
 *   allowedProviders, deniedProviders, allowedModels, deniedModels,
 *   allowedTools, deniedTools, egress, allowedHosts, deniedHosts,
 *   access, allowedSecretRefs, deniedSecretRefs, maxAutonomy,
 *   minIsolation
 *
 * If ANY key anywhere in a learned output record matches one of those
 * field names, the record is a smuggled restriction surface and the
 * boundary rejects it (`POLICY_DENIED` — the policy authority's own
 * failure code, because this IS a policy-boundary denial: learning
 * output attempting to speak policy vocabulary).
 *
 * This is the policies-owned half of the LRN-002 proof. The learning
 * module's closed artifact shape makes restrictions unrepresentable at
 * the source; THIS scan makes them undeliverable at the consumer seam
 * — the planning adapter runs it over every consulted learned output
 * before anything reaches the ordering input (defense in depth: even
 * a compromised/mutated learning module cannot smuggle a prohibition
 * through the policies-owned vocabulary check).
 *
 * This file is PURE domain: no I/O, no adapters, total over the closed
 * JSON universe it walks.
 */

import { PlatformError } from "../../../shared/errors";
import type { RestrictionSet } from "./policy";

/**
 * The typed leaf restriction vocabulary of `RestrictionSet` (POL-002)
 * — the machine-readable names through which the policy authority
 * expresses prohibitions. Learning output may never carry any of
 * these as keys.
 */
export const RESTRICTION_FIELD_VOCABULARY: readonly string[] = [
  "maxCostMicroUsd",
  "minQuality",
  "maxLatencyMs",
  "allowedProviders",
  "deniedProviders",
  "allowedModels",
  "deniedModels",
  "allowedTools",
  "deniedTools",
  "egress",
  "allowedHosts",
  "deniedHosts",
  "access",
  "allowedSecretRefs",
  "deniedSecretRefs",
  "maxAutonomy",
  "minIsolation",
] as const;

/**
 * The restriction-dimension container keys (`POLICY_DIMENSIONS`, the
 * nine governing dimensions) — a learned output may not carry a
 * restriction DIMENSION either, only preference semantics.
 */
export const RESTRICTION_DIMENSION_VOCABULARY: readonly string[] = [
  "cost",
  "quality",
  "latency",
  "providerModel",
  "tool",
  "network",
  "secrets",
  "autonomy",
  "isolation",
] as const;

const RESTRICTION_FIELDS = new Set<string>(RESTRICTION_FIELD_VOCABULARY);
const RESTRICTION_DIMENSIONS = new Set<string>(RESTRICTION_DIMENSION_VOCABULARY);

/** Maximum walked depth (bounded traversal — fail closed on absurd shapes). */
const MAX_WALK_DEPTH = 12;

/** Is this value inside the closed, walkable JSON universe? (local twin of the canonicalization rule) */
function isWalkable(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isWalkable);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isWalkable);
  }
  return false;
}

function walk(value: unknown, depth: number, path: string, violations: string[]): void {
  if (depth > MAX_WALK_DEPTH) {
    violations.push(`${path}:walk-depth-exceeded`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], depth + 1, `${path}[${index}]`, violations);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (RESTRICTION_FIELDS.has(key) || RESTRICTION_DIMENSIONS.has(key)) {
        violations.push(`${path}.${key}`);
      }
      walk(record[key], depth + 1, `${path}.${key}`, violations);
    }
  }
}

/**
 * Scan a learned output record for smuggled policy-restriction
 * vocabulary (leaf fields AND dimension containers). Returns the
 * offending key paths (empty = clean).
 *
 * Pure and total: non-walkable values (functions, symbols,
 * NaN/Infinity) fail closed as violations — learning output outside
 * the closed JSON universe is never policy-trustworthy.
 */
export function learnedOutputRestrictionViolations(value: unknown): string[] {
  if (!isWalkable(value)) {
    return ["<root>:non-walkable"];
  }
  const violations: string[] = [];
  walk(value, 0, "$", violations);
  return violations;
}

/**
 * The policies-owned admission decision for learned output (the hard
 * boundary): a learned output record carrying ANY restriction-vocabulary
 * key is REJECTED with `POLICY_DENIED`. Learning output never speaks
 * policy semantics.
 */
export function assertLearnedOutputFreeOfRestrictions(value: unknown): void {
  const violations = learnedOutputRestrictionViolations(value);
  if (violations.length > 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message:
        "learned output carries policy restriction vocabulary (hard prohibitions are immutable to learning output — a learned artifact may only carry preferences)",
      details: { violations: violations.slice(0, 20) },
    });
  }
}

export type { RestrictionSet };
