/**
 * Canonical JSON for the audit module (WORK-059 domain).
 *
 * Deterministic serialization for content-addressed identities and
 * integrity digests: object keys sorted lexicographically, no
 * insignificant whitespace, UTF-8 — the same discipline as the
 * platform `canonicalJson` (WORK-049), kept module-local so the audit
 * domain stays provider-neutral and dependency-light (domain layers
 * never import `src/platform/**`).
 *
 * Canonicalizability is total: the value must be built from null,
 * booleans, finite numbers, strings, arrays and plain objects (no
 * `undefined` properties, no bigint/symbol/function/date) — audit
 * content is typed data, not arbitrary JavaScript.
 */

/** The set of shapes that canonicalize (everything else fails closed). */
export function isCanonicalizable(value: unknown): boolean {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isCanonicalizable(entry));
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).every(
      ([key, entry]) => key !== "__proto__" && entry !== undefined && isCanonicalizable(entry),
    );
  }
  return false;
}

function escapeString(value: string): string {
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (character === '"') {
      out += '\\"';
    } else if (character === "\\") {
      out += "\\\\";
    } else if (code >= 0x20 && code !== 0x7f) {
      out += character;
    } else if (code === 0x7f) {
      out += "\\u007f";
    } else {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
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
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return escapeString(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${escapeString(key)}:${serialize(entry)}`).join(",")}}`;
}

/**
 * The canonical JSON form of an audit value. Throws on
 * non-canonicalizable input (fail closed — never digests an
 * undeterministic shape).
 */
export function canonicalAuditJson(value: unknown): string {
  if (!isCanonicalizable(value)) {
    throw new TypeError("audit value is not canonicalizable");
  }
  return serialize(value);
}
