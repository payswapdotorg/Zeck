/**
 * Capability fact/requirement validation (capabilities module domain).
 *
 * Pure functions — the arbitration logic the registry application layer
 * runs BEFORE a published fact can influence any resolution. Publishing is
 * an input, never an authority: a fact that fails validation here is
 * rejected regardless of which adapter published it (acceptance criterion 2).
 */

import type {
  CapabilityDescriptor,
  CapabilityKind,
  CapabilityRequirement,
  FactValidation,
  PublishedCapabilityFact,
} from "./capability";
import { CAPABILITY_KINDS } from "./capability";

/** Neutral vocabulary identifiers: lowercase slug, no provider namespacing. */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** `major[.minor[.patch]]` — numeric, zero-padded comparisons handled by parseVersion. */
const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}$/;

const isKind = (value: unknown): value is CapabilityKind =>
  typeof value === "string" && (CAPABILITY_KINDS as readonly string[]).includes(value);

const isAttributeValue = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export function parseVersion(version: string): ParsedVersion | null {
  if (!VERSION_PATTERN.test(version)) {
    return null;
  }
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
  };
}

/** Negative when `left < right`, zero when equal, positive when greater. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a === null || b === null) {
    return null;
  }
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function validateDescriptor(claim: CapabilityDescriptor): string | null {
  if (typeof claim.id !== "string" || !ID_PATTERN.test(claim.id)) {
    return `claim.id must be a neutral vocabulary slug (lowercase, <=64 chars): ${String(claim.id)}`;
  }
  if (!isKind(claim.kind)) {
    return `claim.kind must be one of ${CAPABILITY_KINDS.join("|")}`;
  }
  if (typeof claim.version !== "string" || parseVersion(claim.version) === null) {
    return `claim.version must match major[.minor[.patch]] numerically: ${String(claim.version)}`;
  }
  if (claim.attributes !== undefined) {
    if (claim.attributes === null || typeof claim.attributes !== "object") {
      return "claim.attributes must be a record of primitive values";
    }
    for (const [key, value] of Object.entries(claim.attributes)) {
      if (!isAttributeValue(value)) {
        return `claim.attributes.${key} must be a primitive (string|number|boolean|null)`;
      }
    }
  }
  return null;
}

/**
 * Validate a published fact IN FULL — descriptor shape, provenance and
 * evidence. Evidence is MANDATORY: a claim without a durable evidence
 * reference cannot enter the catalog (INT-002 acceptance criterion 4).
 */
export function validatePublishedFact(fact: PublishedCapabilityFact): FactValidation {
  if (fact === null || typeof fact !== "object") {
    return { valid: false, reason: "fact must be an object" };
  }
  const descriptorError = validateDescriptor(fact.claim);
  if (descriptorError !== null) {
    return { valid: false, reason: descriptorError };
  }
  if (
    typeof fact.provenance?.publisher !== "string" ||
    fact.provenance.publisher.length === 0 ||
    fact.provenance.publisher.length > 128
  ) {
    return { valid: false, reason: "provenance.publisher must be a non-empty string (<=128)" };
  }
  if (typeof fact.provenance.publishedAt !== "string" || fact.provenance.publishedAt.length === 0) {
    return { valid: false, reason: "provenance.publishedAt must be a non-empty timestamp string" };
  }
  if (typeof fact.evidence?.reference !== "string" || fact.evidence.reference.length === 0) {
    return { valid: false, reason: "evidence.reference is mandatory for every capability claim" };
  }
  return { valid: true };
}

/** Validate one requirement of a task profile (fail closed on shape errors). */
export function validateRequirement(requirement: CapabilityRequirement): FactValidation {
  if (requirement === null || typeof requirement !== "object") {
    return { valid: false, reason: "requirement must be an object" };
  }
  if (typeof requirement.id !== "string" || !ID_PATTERN.test(requirement.id)) {
    return {
      valid: false,
      reason: `requirement.id must be a neutral vocabulary slug: ${String(requirement.id)}`,
    };
  }
  if (!isKind(requirement.kind)) {
    return {
      valid: false,
      reason: `requirement.kind must be one of ${CAPABILITY_KINDS.join("|")}`,
    };
  }
  if (requirement.minVersion !== undefined && parseVersion(requirement.minVersion) === null) {
    return {
      valid: false,
      reason: `requirement.minVersion must match major[.minor[.patch]]: ${String(requirement.minVersion)}`,
    };
  }
  return { valid: true };
}
