/**
 * Canonical serialization for planning identity (planning module domain;
 * WORK-009).
 *
 * Plans and planning decisions are DIGEST-ADDRESSED (planId / decision
 * binding): the digest is taken over the canonical serialization of the
 * exact typed value, mirroring the WORK-008 canonicalization discipline —
 *
 *  - object keys sorted lexicographically at EVERY depth;
 *  - a CLOSED JSON universe (null, boolean, string, number, array, object);
 *  - integers serialize via base-10; FINITE floats serialize via the
 *    ECMAScript shortest round-trip decimal (`String(value)` — injective
 *    on doubles, deterministic across engines); NaN, Infinity and
 *    -Infinity are REJECTED (never silently rounded). Quality estimates
 *    are probabilities — floats are part of the planning universe, and
 *    distinct doubles must keep distinct identities (digest stability
 *    without collisions);
 *  - strings escaped minimally and deterministically;
 *  - no whitespace between tokens.
 *
 * The serializer is total over the closed universe and fails closed with a
 * typed `PROVIDER_ERROR` for anything outside it (planning inputs and step
 * configs must be digest-stable: identical plans must produce identical
 * identities, independent of key order).
 */

import { PlatformError } from "../../../shared/errors";

/** Is this value inside the closed, digest-stable JSON universe? */
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

/**
 * Canonical JSON: sorted keys at every depth, closed universe, no
 * whitespace. Throws typed `PROVIDER_ERROR` outside the universe (NaN,
 * Infinity, -Infinity, symbols, functions…).
 */
export function canonicalJson(value: unknown): string {
  if (!isCanonicalizable(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message:
        "planning value is not canonicalizable (closed JSON universe — non-finite numbers are rejected)",
    });
  }
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    // Integers and finite floats: the ECMAScript shortest round-trip
    // decimal is deterministic AND injective on doubles.
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
