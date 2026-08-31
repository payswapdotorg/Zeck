/**
 * Canonical serialization for learning identity (learning module domain;
 * WORK-014).
 *
 * Telemetry fingerprints, scorecard digests, rating fingerprints and
 * shadow strategy description digests are taken over the canonical
 * serialization of the exact typed value (the WORK-008/WORK-009
 * canonicalization discipline):
 *
 *  - object keys sorted lexicographically at EVERY depth;
 *  - a CLOSED JSON universe (null, boolean, string, number, array, object);
 *  - integers serialize via base-10; FINITE floats via the ECMAScript
 *    shortest round-trip decimal; NaN/Infinity are REJECTED;
 *  - strings escaped minimally and deterministically;
 *  - no whitespace between tokens.
 *
 * Fails closed with a typed `PROVIDER_ERROR` outside the closed universe
 * (digest stability: identical observations produce identical
 * fingerprints, independent of key order).
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

function sortedKeys(value: Record<string, unknown>): readonly string[] {
  return Object.keys(value).sort();
}

function escapeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"') {
      out += '\\"';
    } else if (ch === "\\") {
      out += "\\\\";
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
    if (!Number.isFinite(value)) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "non-finite numbers are outside the canonical universe (digest stability)",
      });
    }
    return String(value);
  }
  if (typeof value === "string") {
    return escapeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const body = sortedKeys(record)
      .map((key) => `${escapeString(key)}:${serialize(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new PlatformError({
    code: "PROVIDER_ERROR",
    message: "value is outside the canonical universe",
  });
}

/**
 * Canonical JSON: deterministic serialization of the closed universe.
 * Fails closed for non-canonicalizable values.
 */
export function canonicalJson(value: unknown): string {
  if (!isCanonicalizable(value)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "value is not canonicalizable (closed JSON universe only)",
    });
  }
  return serialize(value);
}
