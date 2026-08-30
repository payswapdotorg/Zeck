/**
 * Canonical JSON serialization — the determinism discipline of the artifact
 * substrate (artifacts module domain; WORK-008).
 *
 * Byte-stability rules (CTX-001 criterion 5 / CTX-002):
 *  - object keys are sorted lexicographically (UTF-16 code units) at every
 *    depth — insertion order never influences bytes;
 *  - arrays keep their order (order is data);
 *  - strings serialize per JSON.stringify (no lone surrogates admitted by
 *    validation);
 *  - numbers: ONLY integers within the safe range are canonical. Floating
 *    point and non-finite values are REJECTED (determinism discipline: no
 *    floating point anywhere in digest-covered content);
 *  - `undefined`, functions, symbols, bigints and sparse exotic objects are
 *    rejected — the canonical universe is closed.
 */

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const SAFE_INTEGER_ABS = 2n ** 53n;

/** Validate + serialize a JSON value canonically (sorted keys, integers only). */
export function canonicalJson(value: unknown, indent?: string): string {
  return serialize(value, indent, 0);
}

function serialize(value: unknown, indent: string | undefined, depth: number): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalizationError(
        `values of type ${typeof value} are not canonicalizable (got ${String(value)})`,
      );
  }

  if (Array.isArray(value)) {
    return serializeArray(value, indent, depth);
  }
  return serializeObject(value as Record<string, unknown>, indent, depth);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError("non-finite numbers are not canonicalizable");
  }
  if (!Number.isInteger(value)) {
    throw new CanonicalizationError(
      "floating-point numbers are not canonicalizable — encode measures as integers or strings",
    );
  }
  if (Math.abs(value) >= Number(SAFE_INTEGER_ABS)) {
    throw new CanonicalizationError("integers outside the safe range are not canonicalizable");
  }
  return String(value);
}

function serializeArray(
  values: readonly unknown[],
  indent: string | undefined,
  depth: number,
): string {
  if (values.length === 0) {
    return "[]";
  }
  const parts = values.map((item) => serialize(item, indent, depth + 1));
  if (indent === undefined) {
    return `[${parts.join(",")}]`;
  }
  const pad = indent.repeat(depth + 1);
  const close = indent.repeat(depth);
  return `[\n${pad}${parts.join(`,\n${pad}`)}\n${close}]`;
}

function serializeObject(
  value: Record<string, unknown>,
  indent: string | undefined,
  depth: number,
): string {
  const keys = Object.keys(value).sort();
  if (keys.length === 0) {
    return "{}";
  }
  const parts = keys.map((key) => {
    const serialized = serialize(value[key], indent, depth + 1);
    return `${JSON.stringify(key)}:${indent !== undefined ? " " : ""}${serialized}`;
  });
  if (indent === undefined) {
    return `{${parts.join(",")}}`;
  }
  const pad = indent.repeat(depth + 1);
  const close = indent.repeat(depth);
  return `{\n${pad}${parts.join(`,\n${pad}`)}\n${close}]`;
}

/**
 * Structural deep-equality against the canonical universe (values that
 * `canonicalJson` accepts). Used by validation of inbound payloads.
 */
export function isCanonicalizable(value: unknown): boolean {
  try {
    canonicalJson(value);
    return true;
  } catch {
    return false;
  }
}
