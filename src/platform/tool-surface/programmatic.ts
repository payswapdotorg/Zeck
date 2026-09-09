/**
 * Bounded programmatic execution (platform tool-surface plane; WORK-051
 * / E1.1 charter stage 3 — ADR-0019 §6 "Programmatic tool calling").
 *
 * Bounded mechanical work — fan-out, filter, aggregate, projection —
 * executes OUTSIDE model context INSIDE the existing sandbox
 * authority:
 *
 *  - the OPERATION vocabulary is CLOSED and typed (four mechanical
 *    operations over the closed JSON universe; an invented operation is
 *    unrepresentable — validation rejects it);
 *  - the BOUNDS are EXPLICIT and fail closed (architecture invariant 3):
 *    `maxInputItems`, `maxIterations`, `maxOutputBytes` and
 *    `wallClockMs` are REQUIRED fields of every spec, each bounded by a
 *    hard cap; a missing or over-cap bound is a typed rejection —
 *    unbounded programmatic work cannot be represented, let alone run;
 *  - the evaluator KERNEL (`evaluateProgrammaticSpec`) is the pure,
 *    in-process reference implementation of the closed semantics: it
 *    enforces the input-item, iteration and output-byte bounds and
 *    returns typed, bounded failures. The module-side sandbox adapter
 *    ships the SAME closed semantics as the bounded runner program
 *    executed inside the dispatched sandbox process (the synthesis
 *    executor precedent); a dedicated test pins the two implementations
 *    together over a representative corpus so they cannot drift
 *    silently;
 *  - execution THROUGH the sandbox authority happens in `executor.ts`
 *    via the neutral `SandboxComputeSeam` (seams.ts): the full existing
 *    admission chain (policy → capability → budget), durable identity,
 *    evidence envelopes and provider dispatch run VERBATIM — no second
 *    sandbox, no escape path, no capability widening;
 *  - the RESULT is a compact, structured, typed value (results.ts):
 *    untyped or oversized results are rejected, never truncated.
 *
 * The wall-clock bound is enforced by the sandbox authority itself (the
 * environment's `executionTimeoutMs` plus the service's defensive
 * timeout): a timed-out run surfaces as a typed sandbox failure. The
 * input-serialization bound below is the honest v1 bound for crossing
 * the sandbox task boundary in bounded argv chunks (4096 chars each,
 * the frozen task-argument bound).
 */

// ---------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------

/** The four mechanical operations of ADR-0019 §6 (closed set). */
export const PROGRAMMATIC_OPERATIONS = ["fan-out", "filter", "aggregate", "projection"] as const;
export type ProgrammaticOperation = (typeof PROGRAMMATIC_OPERATIONS)[number];

export function isProgrammaticOperation(value: unknown): value is ProgrammaticOperation {
  return (
    typeof value === "string" && (PROGRAMMATIC_OPERATIONS as readonly string[]).includes(value)
  );
}

/** The aggregate metrics (closed set). */
export const AGGREGATE_METRICS = ["count", "sum"] as const;
export type AggregateMetric = (typeof AGGREGATE_METRICS)[number];

/**
 * The typed, bounded programmatic-execution error vocabulary.
 *
 *  - `spec-shape` — the spec value is structurally invalid;
 *  - `operation-vocabulary` — the operation is outside the closed set;
 *  - `bound-violation` — a bound is missing, non-integer, non-positive
 *    or above its hard cap (unbounded work is unrepresentable);
 *  - `input-shape` — the input does not carry a bounded `items` array;
 *  - `input-unbounded` — the input exceeds its declared/serialization
 *    bounds;
 *  - `iteration-exceeded` — the evaluation exceeded `maxIterations`;
 *  - `output-unbounded` — the result exceeds `maxOutputBytes`;
 *  - `output-unparseable` — the sandbox output is not parseable JSON;
 *  - `output-untyped` — the result does not match the operation's typed
 *    value shape;
 *  - `result-shape` — the compact structured result is invalid;
 *  - `sandbox-failed` — the sandbox execution failed (typed sandbox
 *    failure details ride along);
 *  - `sandbox-denied` — the sandbox admission authority denied the run;
 *  - `non-convergent` — the sandbox left an honest unknown-outcome
 *    state (crash/concurrent claim) — fail closed, never assumed;
 *  - `seam-shape` — the seam observation is malformed, or the sandbox
 *    runner reported a code outside the closed vocabulary (never
 *    trusted).
 */
export const PROGRAMMATIC_ERROR_CODES = [
  "spec-shape",
  "operation-vocabulary",
  "bound-violation",
  "input-shape",
  "input-unbounded",
  "iteration-exceeded",
  "output-unbounded",
  "output-unparseable",
  "output-untyped",
  "result-shape",
  "sandbox-failed",
  "sandbox-denied",
  "non-convergent",
  "seam-shape",
] as const;
export type ProgrammaticErrorCode = (typeof PROGRAMMATIC_ERROR_CODES)[number];

const DETAIL_LIMIT = 300;

function boundedDetail(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/** The typed, bounded programmatic-execution error. */
export class ProgrammaticError extends Error {
  readonly code: ProgrammaticErrorCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ProgrammaticErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "ProgrammaticError";
    this.code = code;
    const bounded: Record<string, string | number | boolean | null> = {};
    if (details !== undefined) {
      for (const [key, value] of Object.entries(details)) {
        bounded[key] = typeof value === "string" ? boundedDetail(value) : value;
      }
    }
    this.details = Object.freeze(bounded);
  }
}

export function rejectProgrammatic(
  code: ProgrammaticErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new ProgrammaticError(code, message, details);
}

// ---------------------------------------------------------------------------
// Bounds (explicit, bounded, fail-closed)
// ---------------------------------------------------------------------------

/**
 * The four explicit bounds every programmatic spec MUST carry
 * (architecture invariant 3: resource limits, output size, iteration
 * count and wall-clock budget are explicit and fail closed).
 */
export interface ProgrammaticBounds {
  readonly maxInputItems: number;
  readonly maxIterations: number;
  readonly maxOutputBytes: number;
  readonly wallClockMs: number;
}

/** The hard caps on each bound (unbounded work is unrepresentable). */
export const PROGRAMMATIC_BOUND_CAPS = {
  maxInputItems: 1024,
  maxIterations: 10_000,
  maxOutputBytes: 65_536,
  wallClockMs: 60_000,
} as const;

/**
 * The serialized-input bound (the honest v1 crossing bound: the input
 * crosses the sandbox task boundary in bounded argv chunks of the
 * frozen 4096-char task-argument size — 8 chunks).
 */
export const PROGRAMMATIC_INPUT_JSON_MAX = 32_768;
export const PROGRAMMATIC_INPUT_CHUNK = 4096;

/**
 * The serialized-spec bound (one argv chunk: the frozen task-argument
 * size).
 */
export const PROGRAMMATIC_SPEC_JSON_MAX = 4096;

function validateBound(value: unknown, what: keyof ProgrammaticBounds): number {
  const cap = PROGRAMMATIC_BOUND_CAPS[what];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    rejectProgrammatic("bound-violation", `the ${what} bound must be an integer`, {
      bound: what,
      got: boundedDetail(value),
    });
  }
  if (value < 1) {
    rejectProgrammatic("bound-violation", `the ${what} bound must be positive`, {
      bound: what,
      got: value,
    });
  }
  if (value > cap) {
    rejectProgrammatic("bound-violation", `the ${what} bound exceeds its hard cap`, {
      bound: what,
      got: value,
      cap,
    });
  }
  return value;
}

// ---------------------------------------------------------------------------
// The programmatic spec (closed, typed, bounded DATA)
// ---------------------------------------------------------------------------

/** Filter parameters (a closed equality predicate). */
export interface FilterParams {
  readonly field: string;
  readonly equals: string | number | boolean | null;
}

/** Aggregate parameters (count, or sum over a numeric field). */
export interface AggregateParams {
  readonly metric: AggregateMetric;
  readonly field?: string;
}

/** Projection parameters (a bounded field subset). */
export interface ProjectionParams {
  readonly fields: readonly string[];
}

export interface ProgrammaticSpecParams {
  /** filter */
  readonly field?: string;
  readonly equals?: string | number | boolean | null;
  /** aggregate */
  readonly metric?: AggregateMetric;
  /** projection */
  readonly fields?: readonly string[];
}

/**
 * The bounded mechanical-work spec: pure DATA carrying the operation,
 * the closed parameters, the explicit bounds and the identity anchors
 * (the plan step it belongs to; the spec's own stable slug id).
 */
export interface ProgrammaticSpec {
  readonly specId: string;
  readonly stepId: string;
  readonly operation: ProgrammaticOperation;
  readonly params: ProgrammaticSpecParams;
  readonly bounds: ProgrammaticBounds;
}

const SPEC_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROJECTION_FIELDS_MAX = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Total, deterministic validation of a programmatic spec. Fail-closed
 * on: shape, closed operation/metric vocabularies, per-operation
 * parameter shapes, and every bound (missing, non-integer,
 * non-positive or over-cap — unbounded work is unrepresentable).
 */
export function validateProgrammaticSpec(value: unknown): ProgrammaticSpec {
  if (!isRecord(value)) {
    rejectProgrammatic("spec-shape", "the programmatic spec must be an object");
  }
  if (typeof value.specId !== "string" || !SPEC_ID.test(value.specId)) {
    rejectProgrammatic("spec-shape", "the spec id must be a lowercase slug", {
      got: boundedDetail(value.specId),
    });
  }
  if (typeof value.stepId !== "string" || !SPEC_ID.test(value.stepId)) {
    rejectProgrammatic("spec-shape", "the spec stepId must be a lowercase slug", {
      got: boundedDetail(value.stepId),
    });
  }
  if (!isProgrammaticOperation(value.operation)) {
    rejectProgrammatic("operation-vocabulary", "the operation is outside the closed set", {
      got: boundedDetail(value.operation),
    });
  }
  const operation = value.operation;
  if (!isRecord(value.params)) {
    rejectProgrammatic("spec-shape", "the programmatic spec requires a params object");
  }
  if (!isRecord(value.bounds)) {
    rejectProgrammatic(
      "bound-violation",
      "the programmatic spec requires an explicit bounds object",
    );
  }
  const bounds: ProgrammaticBounds = {
    maxInputItems: validateBound(value.bounds.maxInputItems, "maxInputItems"),
    maxIterations: validateBound(value.bounds.maxIterations, "maxIterations"),
    maxOutputBytes: validateBound(value.bounds.maxOutputBytes, "maxOutputBytes"),
    wallClockMs: validateBound(value.bounds.wallClockMs, "wallClockMs"),
  };
  const params: {
    field?: string;
    equals?: string | number | boolean | null;
    metric?: AggregateMetric;
    fields?: readonly string[];
  } = {};
  if (operation === "filter") {
    if (typeof value.params.field !== "string" || !FIELD_NAME.test(value.params.field)) {
      rejectProgrammatic("spec-shape", "the filter field must be a lowercase field name", {
        got: boundedDetail(value.params.field),
      });
    }
    const equals = value.params.equals;
    if (
      equals !== null &&
      typeof equals !== "string" &&
      typeof equals !== "number" &&
      typeof equals !== "boolean"
    ) {
      rejectProgrammatic("spec-shape", "the filter equals value must be a scalar", {
        got: boundedDetail(equals),
      });
    }
    params.field = value.params.field;
    params.equals = equals;
  } else if (operation === "aggregate") {
    if (
      typeof value.params.metric !== "string" ||
      !(AGGREGATE_METRICS as readonly string[]).includes(value.params.metric)
    ) {
      rejectProgrammatic("spec-shape", "the aggregate metric is outside the closed set", {
        got: boundedDetail(value.params.metric),
      });
    }
    params.metric = value.params.metric as AggregateMetric;
    if (params.metric === "sum") {
      if (typeof value.params.field !== "string" || !FIELD_NAME.test(value.params.field)) {
        rejectProgrammatic("spec-shape", "the sum aggregate requires a lowercase field name", {
          got: boundedDetail(value.params.field),
        });
      }
      params.field = value.params.field;
    }
  } else if (operation === "projection") {
    if (!Array.isArray(value.params.fields) || value.params.fields.length === 0) {
      rejectProgrammatic("spec-shape", "the projection requires a non-empty fields array");
    }
    if (value.params.fields.length > PROJECTION_FIELDS_MAX) {
      rejectProgrammatic("spec-shape", "the projection field list exceeds the bounded size", {
        count: value.params.fields.length,
        max: PROJECTION_FIELDS_MAX,
      });
    }
    for (const field of value.params.fields) {
      if (typeof field !== "string" || !FIELD_NAME.test(field)) {
        rejectProgrammatic("spec-shape", "the projection fields must be lowercase field names", {
          got: boundedDetail(field),
        });
      }
    }
    params.fields = [...value.params.fields];
  }
  return { specId: value.specId, stepId: value.stepId, operation, params, bounds };
}

// ---------------------------------------------------------------------------
// The input (bounded, closed JSON universe)
// ---------------------------------------------------------------------------

export interface ProgrammaticInput {
  readonly items: readonly unknown[];
}

/**
 * Validate the programmatic input: an `items` array inside the closed
 * JSON universe, bounded by the spec's `maxInputItems` and by the
 * serialized crossing bound.
 */
export function validateProgrammaticInput(
  value: unknown,
  bounds: ProgrammaticBounds,
): ProgrammaticInput {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    rejectProgrammatic("input-shape", "the programmatic input must carry an items array");
  }
  const items = value.items;
  if (items.length > bounds.maxInputItems) {
    rejectProgrammatic("input-unbounded", "the input items exceed the declared bound", {
      count: items.length,
      max: bounds.maxInputItems,
    });
  }
  const serialized = serializeInput(items);
  if (serialized.length > PROGRAMMATIC_INPUT_JSON_MAX) {
    rejectProgrammatic("input-unbounded", "the serialized input exceeds the crossing bound", {
      length: serialized.length,
      max: PROGRAMMATIC_INPUT_JSON_MAX,
    });
  }
  return { items };
}

/** Serialize the input deterministically (closed JSON universe). */
export function serializeInput(items: readonly unknown[]): string {
  return JSON.stringify({ items });
}

/** Chunk a serialized payload into bounded argv-sized pieces. */
export function chunkPayload(serialized: string): readonly string[] {
  const chunks: string[] = [];
  for (let index = 0; index < serialized.length; index += PROGRAMMATIC_INPUT_CHUNK) {
    chunks.push(serialized.slice(index, index + PROGRAMMATIC_INPUT_CHUNK));
  }
  return chunks.length === 0 ? [""] : chunks;
}

// ---------------------------------------------------------------------------
// The evaluator kernel (pure, bounded, typed — the reference semantics)
// ---------------------------------------------------------------------------

/**
 * The typed value shape per operation (the compact-result contract):
 *
 *  - `fan-out` → an array of `{ index, item }` work units;
 *  - `filter` → the array of matching items;
 *  - `aggregate` → `{ count }` or `{ sum }` (a finite number);
 *  - `projection` → the array of projected field-subset records.
 */
export type ProgrammaticValue =
  | readonly { readonly index: number; readonly item: unknown }[]
  | readonly unknown[]
  | { readonly count: number }
  | { readonly sum: number };

export interface EvaluationOutcome {
  readonly value: ProgrammaticValue;
  /** The iterations actually consumed (bounded evidence). */
  readonly iterations: number;
}

function isItemRecord(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}

/**
 * Evaluate a VALIDATED spec over a VALIDATED input (the pure reference
 * kernel). Enforces the iteration and output-byte bounds fail-closed;
 * every failure is a typed `ProgrammaticError`. Deterministic: the same
 * (spec, input) always produce the same value and iteration count.
 */
export function evaluateProgrammaticSpec(
  spec: ProgrammaticSpec,
  input: ProgrammaticInput,
): EvaluationOutcome {
  const { params, bounds, operation } = spec;
  const items = input.items;
  if (items.length > bounds.maxInputItems) {
    rejectProgrammatic("input-unbounded", "the input items exceed the declared bound", {
      count: items.length,
      max: bounds.maxInputItems,
    });
  }
  let iterations = 0;
  const bump = (): void => {
    iterations += 1;
    if (iterations > bounds.maxIterations) {
      rejectProgrammatic("iteration-exceeded", "the evaluation exceeded the iteration bound", {
        bound: bounds.maxIterations,
      });
    }
  };
  let value: ProgrammaticValue;
  if (operation === "fan-out") {
    const units: { index: number; item: unknown }[] = [];
    for (let index = 0; index < items.length; index += 1) {
      bump();
      units.push({ index, item: items[index] });
    }
    value = units;
  } else if (operation === "filter") {
    const field = params.field as string;
    const equals = params.equals;
    const kept: unknown[] = [];
    for (const item of items) {
      bump();
      if (isItemRecord(item) && item[field] === equals) {
        kept.push(item);
      }
    }
    value = kept;
  } else if (operation === "aggregate") {
    if (params.metric === "count") {
      for (const _item of items) {
        bump();
      }
      value = { count: items.length };
    } else {
      const field = params.field as string;
      let sum = 0;
      for (const item of items) {
        bump();
        if (!isItemRecord(item)) {
          rejectProgrammatic("output-untyped", "a sum aggregate requires record items", {
            itemIndex: iterations - 1,
          });
        }
        const number = item[field];
        if (typeof number !== "number" || !Number.isFinite(number)) {
          rejectProgrammatic("output-untyped", "a sum aggregate requires finite numeric fields", {
            field,
            got: boundedDetail(number),
          });
        }
        sum += number;
      }
      if (!Number.isFinite(sum)) {
        rejectProgrammatic("output-untyped", "the aggregate sum is not finite");
      }
      value = { sum };
    }
  } else {
    const fields = params.fields as readonly string[];
    const projected: Record<string, unknown>[] = [];
    for (const item of items) {
      bump();
      if (!isItemRecord(item)) {
        rejectProgrammatic("output-untyped", "a projection requires record items", {
          itemIndex: iterations - 1,
        });
      }
      const out: Record<string, unknown> = {};
      for (const field of fields) {
        out[field] = item[field];
      }
      projected.push(out);
    }
    value = projected;
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > bounds.maxOutputBytes) {
    rejectProgrammatic("output-unbounded", "the result exceeds the declared output bound", {
      length: serialized.length,
      max: bounds.maxOutputBytes,
    });
  }
  return { value, iterations };
}
