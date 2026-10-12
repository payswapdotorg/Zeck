/**
 * The evaluation's canonical-serialization and digest port (PCR-003).
 *
 * THE BOUNDARY DISCIPLINE (the customer boundary — VAL-002 AC7 — forbids
 * importing `src/**` from the application tree): this evaluation follows
 * the repository's OWN established answer to exactly this situation, the
 * WORK-008 canonicalization discipline as stated by the execution-ir
 * plane's canonical serializer — "when a boundary forbids importing the
 * serializer, the discipline is implemented locally over neutral values,
 * and a boundary test pins the serializers byte-for-byte against each
 * other" (the planning module's serializer vs the execution-ir plane's
 * serializer is the in-repository precedent this module mirrors).
 *
 * The discipline (identical semantics, locally implemented):
 * closed JSON universe (null, boolean, string, number, array, object);
 * object keys sorted lexicographically at EVERY depth; integers via
 * base-10, finite floats via the ECMAScript shortest round-trip decimal
 * (`String(value)`); NaN/Infinity/-Infinity REJECTED (fail-closed, never
 * silently rounded); strings escaped minimally and deterministically; no
 * whitespace between tokens.
 *
 * The digest port (content addressing): the recovery seam's own injection
 * contract — `IrDigestPort` is an injected, never-ambient port by design
 * (the WORK-008 node-digest adapter precedent: node:crypto confined to
 * the adapter, sha256 lowercase hex). This module's port is
 * byte-identical to the platform's `createNodeDigest()` (pinned by the
 * test suite over a value corpus).
 *
 * The test suite (tests/unit/validation/pcr-003-recovery-plan-evaluation.test.ts)
 * pins BOTH byte-for-byte equalities against the platform's own
 * implementations — drift is caught, never silent.
 */

import { createHash } from "node:crypto";
import type { ExperimentRecoveryPlanInputs } from "../shared/seam";

/**
 * The digest port the recovery seam consumes (the lab's own interface
 * type — the injection contract; never derived from `src/**`).
 */
export type EvaluationDigestPort = ExperimentRecoveryPlanInputs["digest"];

/**
 * The sha256 digest port (lowercase hex) — the WORK-008 node-digest
 * adapter discipline over node:crypto.
 */
export function createEvaluationDigestPort(): EvaluationDigestPort {
  return {
    sha256Hex(value: string): string {
      return createHash("sha256").update(value, "utf8").digest("hex");
    },
  };
}

/**
 * Is this value inside the closed, digest-stable JSON universe? Pure;
 * total over `unknown` (fail-closed outside it — never a guess).
 */
export function isCanonicalizable(value: unknown): boolean {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value === "string") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isCanonicalizable);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isCanonicalizable);
  }
  return false;
}

/** Deterministic key order for serialization (lexicographic). */
function sortedKeys(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value).sort();
}

/** Escape the minimal JSON set, deterministically. */
function escapeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      out += "\\r";
    } else if (ch === "\t") {
      out += "\\t";
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return `${out}"`;
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return escapeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = sortedKeys(record).map((key) => `${escapeString(key)}:${serialize(record[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Canonical JSON: sorted keys at every depth, closed universe, no
 * whitespace. Fails closed for anything outside the closed universe.
 */
export function canonicalJson(value: unknown): string {
  if (!isCanonicalizable(value)) {
    throw new TypeError(
      "evaluation value is not canonicalizable (closed JSON universe — non-finite numbers are rejected)",
    );
  }
  return serialize(value);
}
