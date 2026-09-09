/**
 * Compact structured results (platform tool-surface plane; WORK-051 /
 * E1.1 charter stage 3 — ADR-0019 §6 "compact structured result").
 *
 * A programmatic execution's result crosses back into the plan as a
 * STRUCTURED, BOUNDED, TYPED value (architecture invariant 6):
 *
 *  - the value lives inside the closed JSON universe and matches the
 *    operation's typed shape (fan-out/projection → arrays; filter →
 *    array; aggregate → `{count}` | `{sum}`);
 *  - the serialized result is bounded by the spec's `maxOutputBytes`
 *    (an oversized result is rejected, never truncated);
 *  - the result is content-addressed (`resultDigest`: sha256 over the
 *    canonical `{stepId, operation, value}` form) — digest stability
 *    makes round-trips and audits replayable;
 *  - the result carries EXACT provenance (the spec id, the durable
 *    sandbox execution identity, the sandbox output digest, and the
 *    tool-surface identity when the work was derived through one);
 *  - `bindResultToPlan` proves the result round-trips into the plan's
 *    result contract: the step it claims MUST exist in the source plan
 *    IR and belong to the mechanical family (a result for an invented
 *    or non-mechanical step is unrepresentable);
 *  - `roundTripCompactResult` re-serializes, re-parses and re-validates
 *    the result value — the byte-stable round-trip proof.
 *
 * Untyped or unbounded results are rejected with typed errors — never
 * silently coerced.
 */

import { canonicalJson, isCanonicalizable } from "../execution-ir/canonical";
import type { IrDigestPort, PlanStepClass, SideEffectClass } from "../execution-ir/ir";
import {
  isProgrammaticOperation,
  PROGRAMMATIC_BOUND_CAPS,
  type ProgrammaticOperation,
  type ProgrammaticSpec,
  rejectProgrammatic,
} from "./programmatic";

// ---------------------------------------------------------------------------
// The compact structured result
// ---------------------------------------------------------------------------

/**
 * The step facts a result binds against (carried from the source IR —
 * the plan's own derived facts, never re-derived here).
 */
export interface ResultStepFacts {
  readonly stepId: string;
  readonly stepClass: PlanStepClass;
  readonly computationType: string;
  readonly sideEffectClass: SideEffectClass;
}

/**
 * The compact structured result: typed, bounded, content-addressed,
 * provenance-bound evidence of ONE programmatic execution's value.
 */
export interface CompactStructuredResult {
  readonly resultSchema: 1;
  /** The plan step the value belongs to (the result contract's anchor). */
  readonly stepId: string;
  readonly operation: ProgrammaticOperation;
  /** The typed value (shape enforced per operation). */
  readonly value: unknown;
  /** sha256 over the canonical {stepId, operation, value} form. */
  readonly resultDigest: string;
  readonly provenance: {
    readonly specId: string;
    /** The durable sandbox execution identity (when it ran in the sandbox). */
    readonly sandboxId: string | null;
    /** The sandbox observation's output digest. */
    readonly outputDigest: string | null;
    /** The tool-surface identity the work was derived through. */
    readonly surfaceId: string | null;
  };
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The typed per-operation value check (total): fan-out arrays carry
 * `{index, item}` units; filter/projection arrays carry closed-universe
 * records; aggregates carry exactly the count/sum record. An untyped
 * value is rejected (`output-untyped`), an unbounded one
 * (`output-unbounded`).
 */
export function checkTypedValue(
  operation: ProgrammaticOperation,
  value: unknown,
  maxOutputBytes: number,
): void {
  if (!isCanonicalizable(value)) {
    rejectProgrammatic("output-untyped", "the result value is outside the closed JSON universe");
  }
  if (operation === "aggregate") {
    if (!isRecord(value)) {
      rejectProgrammatic("output-untyped", "an aggregate result must be a record");
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== 1) {
      rejectProgrammatic("output-untyped", "an aggregate result carries exactly one metric", {
        keys: keys.join(","),
      });
    }
    const metricKey = keys[0] as string;
    if (metricKey !== "count" && metricKey !== "sum") {
      rejectProgrammatic("output-untyped", "the aggregate metric is outside the closed set", {
        metric: metricKey,
      });
    }
    const metric = value[metricKey];
    if (typeof metric !== "number" || !Number.isFinite(metric)) {
      rejectProgrammatic("output-untyped", "the aggregate metric must be a finite number", {
        got: String(metric),
      });
    }
    return;
  }
  if (!Array.isArray(value)) {
    rejectProgrammatic("output-untyped", `a ${operation} result must be an array`);
  }
  if (operation === "fan-out") {
    for (const unit of value) {
      if (!isRecord(unit) || typeof unit.index !== "number" || !("item" in unit)) {
        rejectProgrammatic("output-untyped", "a fan-out result carries {index, item} units");
      }
    }
  } else {
    // filter/projection arrays carry closed-universe records.
    for (const item of value) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        continue;
      }
      rejectProgrammatic("output-untyped", `a ${operation} result carries records`);
    }
  }
  if (canonicalJson(value).length > maxOutputBytes) {
    rejectProgrammatic("output-unbounded", "the result exceeds the declared output bound", {
      max: maxOutputBytes,
    });
  }
}

/** The canonical digest input of a compact result's typed core. */
export function canonicalResultCore(result: {
  readonly stepId: string;
  readonly operation: ProgrammaticOperation;
  readonly value: unknown;
}): unknown {
  return { stepId: result.stepId, operation: result.operation, value: result.value };
}

/**
 * Build a compact structured result (validates everything, fail
 * closed): typed value, bounded serialization, digest derived — never
 * caller-supplied.
 */
export function buildCompactResult(input: {
  readonly spec: ProgrammaticSpec;
  readonly value: unknown;
  readonly sandboxId: string | null;
  readonly outputDigest: string | null;
  readonly surfaceId: string | null;
  readonly digest: IrDigestPort;
}): CompactStructuredResult {
  checkTypedValue(input.spec.operation, input.value, input.spec.bounds.maxOutputBytes);
  const core = canonicalResultCore({
    stepId: input.spec.stepId,
    operation: input.spec.operation,
    value: input.value,
  });
  const resultDigest = input.digest.sha256Hex(canonicalJson(core));
  return {
    resultSchema: 1,
    stepId: input.spec.stepId,
    operation: input.spec.operation,
    value: input.value,
    resultDigest,
    provenance: {
      specId: input.spec.specId,
      sandboxId: input.sandboxId,
      outputDigest: input.outputDigest,
      surfaceId: input.surfaceId,
    },
  };
}

/**
 * Total, deterministic validation of a compact structured result value
 * (e.g. after a round-trip): shape, closed vocabularies, typed value,
 * bounded serialization, AND identity verification (the digest must
 * cover the content). Untyped, unbounded, or tampered results are
 * typed errors, never silently surfaced.
 */
export function validateCompactResult(
  value: unknown,
  digest: IrDigestPort,
): CompactStructuredResult {
  if (!isRecord(value)) {
    rejectProgrammatic("result-shape", "a compact result must be an object");
  }
  if (value.resultSchema !== 1) {
    rejectProgrammatic("result-shape", "the compact result schema must be 1");
  }
  if (typeof value.stepId !== "string" || !STEP_ID.test(value.stepId)) {
    rejectProgrammatic("result-shape", "the compact result stepId must be a lowercase slug", {
      got: String(value.stepId),
    });
  }
  if (!isProgrammaticOperation(value.operation)) {
    rejectProgrammatic("result-shape", "the compact result operation is outside the closed set", {
      got: String(value.operation),
    });
  }
  const operation = value.operation;
  if (typeof value.resultDigest !== "string" || !SHA256_HEX.test(value.resultDigest)) {
    rejectProgrammatic("result-shape", "the compact result digest must be sha256 hex", {
      got: String(value.resultDigest),
    });
  }
  if (!isRecord(value.provenance)) {
    rejectProgrammatic("result-shape", "the compact result requires provenance");
  }
  const provenance = value.provenance;
  if (typeof provenance.specId !== "string" || !STEP_ID.test(provenance.specId)) {
    rejectProgrammatic("result-shape", "the compact result provenance specId must be a slug");
  }
  if (
    provenance.sandboxId !== null &&
    (typeof provenance.sandboxId !== "string" || provenance.sandboxId.length === 0)
  ) {
    rejectProgrammatic(
      "result-shape",
      "the compact result provenance sandboxId must be a non-empty string or null",
    );
  }
  if (
    provenance.outputDigest !== null &&
    (typeof provenance.outputDigest !== "string" || !SHA256_HEX.test(provenance.outputDigest))
  ) {
    rejectProgrammatic(
      "result-shape",
      "the compact result provenance outputDigest must be sha256 hex or null",
    );
  }
  if (
    provenance.surfaceId !== null &&
    (typeof provenance.surfaceId !== "string" || !SHA256_HEX.test(provenance.surfaceId))
  ) {
    rejectProgrammatic(
      "result-shape",
      "the compact result provenance surfaceId must be sha256 hex or null",
    );
  }
  // The typed value check needs a bound: a foreign value is validated
  // against the hard output cap (the spec that produced it carries the
  // tighter bound, re-checked at build/audit time).
  checkTypedValue(operation, value.value, PROGRAMMATIC_BOUND_CAPS.maxOutputBytes);
  const result: CompactStructuredResult = {
    resultSchema: 1,
    stepId: value.stepId,
    operation,
    value: value.value,
    resultDigest: value.resultDigest,
    provenance: {
      specId: provenance.specId,
      sandboxId: provenance.sandboxId === null ? null : (provenance.sandboxId as string),
      outputDigest: provenance.outputDigest === null ? null : (provenance.outputDigest as string),
      surfaceId: provenance.surfaceId === null ? null : (provenance.surfaceId as string),
    },
  };
  const core = canonicalResultCore({
    stepId: result.stepId,
    operation: result.operation,
    value: result.value,
  });
  const computed = digest.sha256Hex(canonicalJson(core));
  if (computed !== result.resultDigest) {
    rejectProgrammatic(
      "result-shape",
      "the compact result content does not digest to the claimed digest",
      {
        claimed: result.resultDigest,
        computed,
      },
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// The plan's result contract (round-trip binding)
// ---------------------------------------------------------------------------

/**
 * Bind a compact result to the plan's result contract: the step it
 * claims must exist in the source plan's step facts AND belong to the
 * mechanical family (deterministic, pure side-effect class — the only
 * steps whose work may execute programmatically). A result for an
 * invented step, a generative step, a tool step or a verification step
 * is unrepresentable (fail closed).
 */
export function bindResultToPlan(
  result: CompactStructuredResult,
  steps: readonly ResultStepFacts[],
): CompactStructuredResult {
  const step = steps.find((entry) => entry.stepId === result.stepId);
  if (step === undefined) {
    rejectProgrammatic("result-shape", "the result's step does not exist in the source plan", {
      stepId: result.stepId,
    });
  }
  if (step.computationType !== "deterministic" || step.sideEffectClass !== "pure") {
    rejectProgrammatic(
      "result-shape",
      "the result's step is outside the mechanical family (programmatic results bind only to deterministic pure steps)",
      { stepId: result.stepId, stepClass: step.stepClass },
    );
  }
  return result;
}

/**
 * The round-trip proof: canonical serialization → parse → re-validate
 * must reproduce the identical digest (byte-stable round-trip into the
 * plan's closed config universe).
 */
export function roundTripCompactResult(
  result: CompactStructuredResult,
  digest: IrDigestPort,
): CompactStructuredResult {
  const serialized = JSON.stringify(result);
  const reparsed: unknown = JSON.parse(serialized);
  const roundTripped = validateCompactResult(reparsed, digest);
  if (roundTripped.resultDigest !== result.resultDigest) {
    rejectProgrammatic("result-shape", "the compact result failed the round-trip identity proof", {
      claimed: result.resultDigest,
      roundTripped: roundTripped.resultDigest,
    });
  }
  return roundTripped;
}
