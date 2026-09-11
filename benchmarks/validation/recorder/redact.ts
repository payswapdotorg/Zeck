/**
 * Secret redaction (VAL-004, acceptance criterion 6 — enforced and
 * tested).
 *
 * Every value entering a run record passes through this engine:
 * secret-SHAPED strings (API keys, tokens, bearer credentials, private
 * key headers) are replaced with a stable redaction marker, and
 * secret-NAMED keys (password/token/secret/credential/apikey) have
 * their values redacted structurally regardless of shape. The engine
 * is deep (objects and arrays), deterministic and idempotent — already
 * redacted material survives unchanged.
 */

/** The redaction marker (stable, greppable, never secret-shaped). */
export const REDACTED = "[REDACTED:validation]";

/** Secret-shaped value patterns (prefix families observed in the wild). */
const SECRET_SHAPED: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{16,}/,
  /sk-proj-[A-Za-z0-9_-]{16,}/,
  /sk-ws-[A-Za-z0-9._-]{16,}/,
  /sk-ant-[A-Za-z0-9_-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xoxb-[A-Za-z0-9-]{16,}/,
  /apikey-[A-Za-z0-9]{12,}/,
  /ak_[A-Za-z0-9]{10,}/,
  /ck_[A-Za-z0-9]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /postgres:\/\/[^\s]*:[^\s@]+@/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Key names whose VALUES are always redacted structurally. */
const SECRET_KEY_NAMES: readonly RegExp[] = [
  /secret/i,
  /password/i,
  /^token$/i,
  /token_/i,
  /_token$/i,
  /credential/i,
  /api[-_]?key/i,
  /authorization/i,
  /cookie/i,
];

/** Does this string contain secret-shaped material? */
export function containsSecretShaped(value: string): boolean {
  return SECRET_SHAPED.some((pattern) => pattern.test(value));
}

/** Does this key name mark its value as secret structurally? */
export function isSecretKeyName(key: string): boolean {
  return SECRET_KEY_NAMES.some((pattern) => pattern.test(key));
}

/**
 * Redact one unknown value deeply. Objects and arrays recurse; strings
 * with secret-shaped material replace the match with the marker;
 * secret-named keys redact their whole value; already-redacted strings
 * pass through unchanged (idempotence).
 */
export function redactDeep<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      out[key] = isSecretKeyName(key) && isRedactable(child) ? REDACTED : redactValue(child);
    }
    return out;
  }
  return value;
}

function isRedactable(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function redactString(value: string): string {
  if (value === REDACTED) {
    return value;
  }
  let out = value;
  for (const pattern of SECRET_SHAPED) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Scan a value deeply for remaining secret-shaped material AFTER
 * redaction — the enforcement gate. Returns the JSON paths of any
 * leaked secrets (empty = clean).
 */
export function findResidualSecrets(value: unknown, prefix = "$"): readonly string[] {
  const findings: string[] = [];
  if (typeof value === "string") {
    if (containsSecretShaped(value) && value !== REDACTED) {
      findings.push(prefix);
    }
    return findings;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      findings.push(...findResidualSecrets(item, `${prefix}[${index}]`));
    });
    return findings;
  }
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const child = (value as Record<string, unknown>)[key];
      findings.push(...findResidualSecrets(child, `${prefix}.${key}`));
    }
  }
  return findings;
}
