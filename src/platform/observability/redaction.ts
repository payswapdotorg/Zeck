/**
 * Telemetry redaction (WORK-047 / D-06; invariant 4/6: telemetry is
 * secret-free, bounded).
 *
 * THREE-LAYER DISCIPLINE, applied BEFORE any record is buffered:
 *
 * 1. KEY layer — secret-shaped attribute keys are REJECTED (the
 *    record is dropped and counted): a telemetry field literally
 *    named token/secret/password/api-key must never exist, because
 *    redacting its value still advertises that a secret was there.
 *
 * 2. VALUE layer — credential-shaped values are redacted in place
 *    (URL-embedded credentials, token-prefixed literals like
 *    sk-/ghp_/AKIA, bearer/authorization assignments) and control
 *    characters are stripped; every surviving value is
 *    length-capped.
 *
 * 3. SHAPE layer — attribute count and value length are capped;
 *    non-string input values are deterministically stringified (no
 *    objects, no JSON dumps of payloads — reference-only telemetry).
 *
 * The result is a classification: either the record's attributes are
 * admissible (possibly with redactions applied and counted), or the
 * record is REJECTED with the exact reason. Nothing the collector
 * receives can carry secret material.
 */

import type { TelemetryAttributes } from "./port";
import { TELEMETRY_BOUNDS } from "./port";

export interface RedactionResult {
  readonly admissible: boolean;
  readonly reason?: string;
  readonly attributes: TelemetryAttributes;
  readonly redactions: number;
}

/**
 * Secret-shaped KEYS: the attribute must not exist at all. Keys are
 * normalized (camelCase → kebab, lowercased) before matching so
 * `apiToken`, `api-token` and `API_TOKEN` are equally unrepresentable.
 */
const SECRET_KEY_PATTERN =
  /^(?:[a-z0-9]+[-_])?(?:token|secret|password|passwd|credential|apikey|api[-_]?key|auth|authorization|private[-_]?key|client[-_]?secret|session[-_]?key)(?:[-_][a-z0-9]+)*$/;

/** Credential-shaped VALUES (redacted in place, counted). */
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const TOKEN_LITERAL_PATTERN = /\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs]|AKIA)[A-Za-z0-9_-]{16,}\b/g;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(bearer|authorization|token|secret|password|api[-_]?key)\b["'\s:=]+[A-Za-z0-9._~+/=-]{20,}/gi;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control-char stripping is the point.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/g;

/** Deterministic stringification: numbers/booleans only; objects are opaque. */
function stringifyValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  // Objects, arrays, null, undefined: unrepresentable (reference-only
  // telemetry — payload dumps are never attributes).
  return null;
}

/**
 * Classify (and, when admissible, redact) one record's attributes.
 * Pure: no clock, no randomness, no side effects.
 */
export function redactTelemetryAttributes(
  input: Readonly<Record<string, unknown>>,
): RedactionResult {
  const entries = Object.entries(input);
  if (entries.length > TELEMETRY_BOUNDS.maxAttributes) {
    return {
      admissible: false,
      reason: `attribute count ${entries.length} exceeds the bound ${TELEMETRY_BOUNDS.maxAttributes}`,
      attributes: {},
      redactions: 0,
    };
  }
  let redactions = 0;
  const attributes: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.slice(0, TELEMETRY_BOUNDS.maxNameLength);
    const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    if (SECRET_KEY_PATTERN.test(normalizedKey)) {
      return {
        admissible: false,
        reason: `secret-shaped attribute key "${key}" is unrepresentable in telemetry`,
        attributes: {},
        redactions,
      };
    }
    const value = stringifyValue(rawValue);
    if (value === null) {
      return {
        admissible: false,
        reason: `attribute "${key}" has an unrepresentable value type (reference-only telemetry)`,
        attributes: {},
        redactions,
      };
    }
    let scrubbed = value
      .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
      .replace(TOKEN_LITERAL_PATTERN, "[redacted]")
      .replace(ASSIGNMENT_SECRET_PATTERN, "$1 [redacted]")
      .replace(CONTROL_CHAR_PATTERN, " ");
    if (scrubbed !== value) {
      redactions += 1;
    }
    if (scrubbed.length > TELEMETRY_BOUNDS.maxAttributeLength) {
      scrubbed = `${scrubbed.slice(0, TELEMETRY_BOUNDS.maxAttributeLength)}…`;
      redactions += 1;
    }
    attributes[key] = scrubbed;
  }
  return { admissible: true, attributes, redactions };
}

/** Message-level scrub (bounded log messages). */
export function redactTelemetryMessage(message: string): string {
  const scrubbed = message
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
    .replace(TOKEN_LITERAL_PATTERN, "[redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1 [redacted]")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control-char stripping is the point.
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  return scrubbed.slice(0, TELEMETRY_BOUNDS.maxMessageLength);
}
