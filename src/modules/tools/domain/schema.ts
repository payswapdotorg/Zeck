/**
 * Tool schema contracts (tools module domain; WORK-010, acceptance
 * criterion 1).
 *
 * A `ToolFieldSchema` is the provider-neutral, dependency-light shape
 * declaration every tool contract uses for BOTH its input and its output.
 * It answers exactly one question — "does this JSON object have the
 * declared shape?" — with a pure, total, typed verdict:
 *
 *   - every declared field carries one of the five primitive JSON types;
 *   - `required` fields must be present and non-undefined;
 *   - undeclared fields are REJECTED (contracts are closed, not open — an
 *     adapter silently tolerating unexpected fields is a contract
 *     violation, and a tool consuming undeclared inputs is untestable
 *     evidence);
 *   - `null` is only accepted for nullable fields.
 *
 * This is deliberately NOT a general JSON-Schema engine: the frozen
 * architecture needs tool contracts whose validation is deterministic,
 * side-effect-free and reviewable at a glance (Zod-style rich schemas stay
 * at transport/adapter boundaries per `IMPLEMENTATION.md` §1 — the domain
 * keeps hand-rolled, total validators, the WORK-006/007 discipline).
 */

/** The five primitive JSON types a tool field may declare. */
export const TOOL_FIELD_TYPES = ["string", "number", "boolean", "object", "array"] as const;
export type ToolFieldType = (typeof TOOL_FIELD_TYPES)[number];

export interface ToolFieldSpec {
  readonly name: string;
  readonly type: ToolFieldType;
  /** The field must be present (non-null unless `nullable`). */
  readonly required: boolean;
  /** Accept explicit `null` in addition to the declared type. */
  readonly nullable?: boolean;
  /** Human-readable intent (evidence/review surface; never validated). */
  readonly description?: string;
}

export interface ToolFieldSchema {
  readonly fields: readonly ToolFieldSpec[];
}

export type SchemaCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly field?: string };

export function isToolFieldSchema(value: unknown): value is ToolFieldSchema {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const schema = value as ToolFieldSchema;
  if (!Array.isArray(schema.fields)) {
    return false;
  }
  const names = new Set<string>();
  for (const field of schema.fields) {
    if (field === null || typeof field !== "object") {
      return false;
    }
    if (typeof field.name !== "string" || field.name.length === 0 || field.name.length > 100) {
      return false;
    }
    if (names.has(field.name)) {
      return false;
    }
    names.add(field.name);
    if (!(TOOL_FIELD_TYPES as readonly string[]).includes(field.type)) {
      return false;
    }
    if (field.required !== true && field.required !== false) {
      return false;
    }
  }
  return true;
}

function typeMatches(spec: ToolFieldSpec, value: unknown): boolean {
  if (value === null) {
    return spec.nullable === true;
  }
  switch (spec.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}

/** Validate a candidate payload against a field schema (pure and total). */
export function checkAgainstSchema(schema: ToolFieldSchema, payload: unknown): SchemaCheck {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be a JSON object" };
  }
  const record = payload as Record<string, unknown>;
  const specs = new Map(schema.fields.map((field) => [field.name, field] as const));
  for (const [name, value] of Object.entries(record)) {
    const spec = specs.get(name);
    if (spec === undefined) {
      return {
        ok: false,
        reason: `undeclared field "${name}" is not part of the tool contract`,
        field: name,
      };
    }
    if (!typeMatches(spec, value)) {
      return {
        ok: false,
        reason: `field "${name}" must be of type ${spec.type}${spec.nullable === true ? " (or null)" : ""}`,
        field: name,
      };
    }
  }
  for (const spec of schema.fields) {
    if (spec.required && !(spec.name in record)) {
      return { ok: false, reason: `required field "${spec.name}" is missing`, field: spec.name };
    }
  }
  return { ok: true };
}
