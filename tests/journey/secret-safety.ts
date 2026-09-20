/**
 * PPR-003 — the secret-safety dimension (names, never values).
 *
 * Mirrors the repository's own credential-shaped literal patterns
 * (deploy/lib.ts scanManifestsForSecretPlaintext + the integration
 * kit's scan under tests/unit/developer-docs/secret-scan.test.ts) —
 * one pattern authority, not a second one. Applied to:
 *
 *  - every page/response body the harness fetches (the target's
 *    surfaces — a leaking page fires a secret-exposure finding);
 *  - the harness's OWN serialized report before it is emitted (the
 *    URL-hygiene doctrine: no secret value may cross in the output).
 *
 * REDACTION DISCIPLINE: a match is NEVER echoed. Findings record the
 * pattern name, the surface and a heavily redacted shape marker (first
 * 3 chars + length class) — enough to identify the class, never the
 * value.
 */

export interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/** The credential-shaped literal patterns (mirrors deploy/lib.ts + the kit scan). */
export const SECRET_PATTERNS: readonly SecretPattern[] = Object.freeze([
  {
    name: "URL-embedded credentials (scheme://user:password@host)",
    pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/i,
  },
  { name: "OpenAI-style key literal", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "GitHub token literal", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key literal", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack token literal", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "credential assignment (token/secret/password/api_key = value)",
    pattern: /["'](token|secret|password|api[_-]?key)["']\s*:\s*["'][^"']{12,}["']/i,
  },
  {
    name: "provider key prefix literal (sk-or-v1/sk-proj/sk-ws/apikey-/ak_/ck_)",
    pattern:
      /(sk-or-v1-|sk-proj-|sk-ws-|apikey-[A-Za-z0-9]{8}|ak_[A-Za-z0-9]{8}|ck_[A-Za-z0-9]{8})/,
  },
  {
    name: "bearer literal with long token",
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{24,}/,
  },
] as const);

/** One secret-safety match (the redacted, never-echoed record). */
export interface SecretMatch {
  readonly patternName: string;
  /** The redacted shape marker: first 3 chars + '…' + total length class. */
  readonly redactedShape: string;
}

/** Scan a text for secret-shaped values; return the REDACTED matches. */
export function scanForSecrets(text: string): readonly SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match === null) {
      continue;
    }
    const value = match[0];
    matches.push({
      patternName: name,
      redactedShape: redactShapeOf(value),
    });
  }
  return matches;
}

/**
 * The redaction shape: the first 3 characters + an ellipsis + the
 * total length — enough to distinguish the class of leak in a
 * finding's evidence, never the value.
 */
function redactShapeOf(value: string): string {
  const prefix = value.slice(0, 3);
  return `${prefix}…(${value.length} chars)`;
}

/** True when the text is free of every secret-shaped pattern. */
export function isSecretFree(text: string): boolean {
  return scanForSecrets(text).length === 0;
}

/** The URL-hygiene preflight: a target URL must not carry userinfo credentials. */
export function urlCarriesCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}
