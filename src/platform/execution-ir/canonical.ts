/**
 * Canonical serialization for Execution IR identity (platform execution-ir
 * plane; WORK-049 / E1.1 foundation, ADR-0019 §3, ADR-0020).
 *
 * Execution IRs, constraint sets, cost claims and optimization decision
 * records are DIGEST-ADDRESSED (irId / decisionId / recordDigest): the
 * digest is taken over the canonical serialization of the exact typed
 * value, mirroring the repository-wide WORK-008 canonicalization
 * discipline already used by the planning module (sorted keys at every
 * depth, closed JSON universe, minimal deterministic escaping, no
 * whitespace):
 *
 *  - object keys sorted lexicographically at EVERY depth;
 *  - a CLOSED JSON universe (null, boolean, string, number, array,
 *    object);
 *  - integers serialize via base-10; FINITE floats serialize via the
 *    ECMAScript shortest round-trip decimal (`String(value)` — injective
 *    on doubles, deterministic across engines); NaN, Infinity and
 *    -Infinity are REJECTED (never silently rounded). Quality and
 *    reliability expectations are probabilities — floats are part of the
 *    IR universe, and distinct doubles must keep distinct identities
 *    (digest stability without collisions);
 *  - strings escaped minimally and deterministically;
 *  - no whitespace between tokens.
 *
 * This plane is platform code (`src/platform/**` never imports modules),
 * so the discipline is implemented here over neutral values instead of
 * importing the planning module's serializer; boundary tests pin the two
 * serializers byte-for-byte against each other so identity reconstruction
 * (the plan→IR losslessness proof) stays exact.
 */

/**
 * Is this value inside the closed, digest-stable JSON universe? Pure;
 * total over `unknown`.
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

/**
 * Canonical JSON: sorted keys at every depth, closed universe, no
 * whitespace. Fails closed for anything outside the closed universe.
 */
export function canonicalJson(value: unknown): string {
  if (!isCanonicalizable(value)) {
    throw new TypeError(
      "execution-ir value is not canonicalizable (closed JSON universe — non-finite numbers are rejected)",
    );
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
