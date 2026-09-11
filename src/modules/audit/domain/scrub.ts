/**
 * Audit seam scrubbing (WORK-059 / SEC-004 domain).
 *
 * THE SEAM RULE (Work Order forbidden list): "secrets/credential-shaped
 * values in audit records (scrubbed at the seam)". This module is the
 * seam scrubber — the D-06 observability three-layer redaction
 * discipline (docs/WORK-047, `src/platform/observability/redaction.ts`)
 * extended to the audit plane's STRUCTURED action detail:
 *
 *  1. KEY layer — secret-shaped keys are REJECTED (the whole submission
 *     fails closed): a detail field literally named token/secret/
 *     password/api-key must never reach the durable projection, because
 *     redacting its value still advertises that a secret was there;
 *  2. VALUE layer — credential-shaped values are redacted in place
 *     (URL-embedded credentials, token-prefixed literals like
 *     sk-/ghp_/AKIA, bearer/authorization assignments) and control
 *     characters are stripped; every surviving value is length-capped;
 *  3. SHAPE layer — nesting depth, key count and total canonical size
 *     are capped (audit detail is reference-typed evidence, bounded by
 *     construction — never a payload dump).
 *
 * Pure and deterministic: no clock, no randomness, no side effects.
 */

import { canonicalAuditJson } from "./canonical";
import { AUDIT_BOUNDS } from "./vocabularies";

export interface ScrubResult {
  /** False when the detail is unrepresentable (secret-shaped key). */
  readonly admissible: boolean;
  readonly reason?: string;
  /** The scrubbed detail (empty object when inadmissible). */
  readonly detail: Record<string, unknown>;
  /** Count of value-level redactions applied. */
  readonly redactions: number;
}

/** Secret-shaped KEYS: the attribute must not exist at all. */
const SECRET_KEY_PATTERN =
  /^(?:[a-z0-9]+[-_])?(?:token|secret|password|passwd|credential|apikey|api[-_]?key|auth|authorization|private[-_]?key|client[-_]?secret|session[-_]?key)(?:[-_][a-z0-9]+)*$/;

/** Credential-shaped VALUES (redacted in place, counted). */
const URL_CREDENTIAL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi;
const TOKEN_LITERAL_PATTERN = /\b(?:sk|pk|ghp|gho|ghu|ghs|xox[baprs]|AKIA)[A-Za-z0-9_-]{16,}\b/g;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(bearer|authorization|token|secret|password|api[-_]?key)\b["'\s:=]+[A-Za-z0-9._~+/=-]{20,}/gi;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control-char stripping is the point.
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/g;

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

function scrubString(value: string): { value: string; redacted: boolean } {
  const scrubbed = value
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
    .replace(TOKEN_LITERAL_PATTERN, "[redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1 [redacted]")
    .replace(CONTROL_CHAR_PATTERN, " ");
  if (scrubbed.length > AUDIT_BOUNDS.detailValueMax) {
    return { value: `${scrubbed.slice(0, AUDIT_BOUNDS.detailValueMax)}…`, redacted: true };
  }
  return { value: scrubbed, redacted: scrubbed !== value };
}

/**
 * Scrub ONE submission's action detail (recursive, bounded). Fail-closed
 * classification: secret-shaped keys make the whole detail
 * inadmissible (the submission is rejected by the service); values are
 * redacted and counted.
 */
export function scrubAuditDetail(input: unknown): ScrubResult {
  const counter = { count: 0 };
  try {
    const detail = scrubValue(input, 0, "$", counter);
    const canonical = canonicalAuditJson(detail);
    if (canonical.length > AUDIT_BOUNDS.detailMaxBytes) {
      return {
        admissible: false,
        reason: `action detail exceeds the bounded canonical size (${canonical.length} > ${AUDIT_BOUNDS.detailMaxBytes} bytes) — audit detail is reference-typed evidence, never a payload dump`,
        detail: {},
        redactions: 0,
      };
    }
    return {
      admissible: true,
      detail: detail as Record<string, unknown>,
      redactions: counter.count,
    };
  } catch (error) {
    return {
      admissible: false,
      reason: `action detail is unrepresentable: ${String(error instanceof Error ? error.message : error)}`,
      detail: {},
      redactions: counter.count,
    };
  }
}

function scrubValue(
  value: unknown,
  depth: number,
  path: string,
  counter: { count: number },
): unknown {
  if (depth > AUDIT_BOUNDS.detailMaxDepth) {
    throw new Error(`nesting depth exceeds the bound at ${path}`);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`non-finite number at ${path}`);
    }
    return value;
  }
  if (typeof value === "string") {
    const scrubbed = scrubString(value);
    if (scrubbed.redacted) {
      counter.count += 1;
    }
    return scrubbed.value;
  }
  if (Array.isArray(value)) {
    if (value.length > AUDIT_BOUNDS.detailMaxKeys) {
      throw new Error(`array length exceeds the bound at ${path}`);
    }
    return value.map((entry, index) => scrubValue(entry, depth + 1, `${path}[${index}]`, counter));
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > AUDIT_BOUNDS.detailMaxKeys) {
      throw new Error(`key count exceeds the bound at ${path}`);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      if (entry === undefined) {
        continue;
      }
      if (SECRET_KEY_PATTERN.test(normalizeKey(key))) {
        throw new Error(`secret-shaped detail key "${key}" is unrepresentable in audit records`);
      }
      out[key] = scrubValue(entry, depth + 1, `${path}.${key}`, counter);
    }
    return out;
  }
  // Functions, symbols, bigints, undefined: unrepresentable.
  throw new Error(`value of type ${typeof value} at ${path} is unrepresentable`);
}

/** A pure check: does a (already built) detail still pass the scrub gate? */
export function auditDetailIsAdmissible(detail: unknown): boolean {
  return scrubAuditDetail(detail).admissible;
}

/**
 * Value-level scrub for bounded audit text (rationale/why, reasons) —
 * the D-06 message-level discipline: credential-shaped values are
 * redacted, control characters stripped, length capped. Pure.
 */
export function scrubAuditText(value: string): string {
  const scrubbed = value
    .replace(URL_CREDENTIAL_PATTERN, "$1[redacted]@")
    .replace(TOKEN_LITERAL_PATTERN, "[redacted]")
    .replace(ASSIGNMENT_SECRET_PATTERN, "$1 [redacted]")
    .replace(CONTROL_CHAR_PATTERN, " ");
  return scrubbed.length > AUDIT_BOUNDS.whyMax
    ? `${scrubbed.slice(0, AUDIT_BOUNDS.whyMax)}…`
    : scrubbed;
}
