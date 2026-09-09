/**
 * The bounded programmatic-execution executor (platform tool-surface
 * plane; WORK-051 / E1.1 charter stage 3 — ADR-0019 §6).
 *
 * `runProgrammaticExecution` executes ONE declared mechanical work
 * item OUTSIDE model context INSIDE the existing sandbox authority:
 *
 *  1. VALIDATE (fail closed, before anything crosses): the closed spec
 *     vocabulary + every explicit bound; the input's shape, item bound
 *     and serialized crossing bound;
 *  2. SUBMIT through the neutral `SandboxComputeSeam` — the module-side
 *     adapter's wrapping of the sandbox module's PUBLIC service: the
 *     full existing admission chain (policy → capability → budget),
 *     durable identity, ledger evidence, provider dispatch and timeout
 *     enforcement run VERBATIM (SANDBOX-BOUNDARY: no second sandbox,
 *     no escape path, no capability widening);
 *  3. VALIDATE THE OUTPUT (total): the sandbox run's stdout must parse
 *     as the runner's closed result envelope; the value must satisfy
 *     the operation's TYPED shape and the spec's output bound; the
 *     compact structured result is built content-addressed with the
 *     exact provenance chain (spec, sandbox identity, output digest,
 *     surface identity);
 *  4. BIND the result to the plan's result contract (the step must
 *     exist in the source plan's mechanical family — the round-trip
 *     proof of ADR-0019 §6's "compact structured result" crossing back
 *     into the plan).
 *
 * Every failure is a typed `ProgrammaticError` from the closed
 * vocabulary — an honest `sandbox-failed` / `sandbox-denied` /
 * `non-convergent` carries the sandbox authority's own failure class
 * and message, never a fabricated success. The executor itself is
 * deterministic in every decision it makes (the observation's
 * duration is evidence carried from the authority, never an input to
 * any decision).
 */

import type { IrDigestPort } from "../execution-ir/ir";
import {
  isProgrammaticOperation,
  PROGRAMMATIC_ERROR_CODES,
  type ProgrammaticErrorCode,
  type ProgrammaticInput,
  type ProgrammaticSpec,
  rejectProgrammatic,
  serializeInput,
  validateProgrammaticInput,
  validateProgrammaticSpec,
} from "./programmatic";
import {
  bindResultToPlan,
  buildCompactResult,
  type CompactStructuredResult,
  checkTypedValue,
  type ResultStepFacts,
} from "./results";
import type { ProgrammaticSandboxScope, SandboxComputeSeam } from "./seams";

export type ProgrammaticExecutorErrorCode = Extract<
  ProgrammaticErrorCode,
  | "spec-shape"
  | "input-shape"
  | "input-unbounded"
  | "output-unparseable"
  | "output-untyped"
  | "output-unbounded"
  | "result-shape"
  | "sandbox-failed"
  | "sandbox-denied"
  | "non-convergent"
  | "seam-shape"
>;

export { PROGRAMMATIC_ERROR_CODES };

// ---------------------------------------------------------------------------
// The runner's closed result envelope (the output contract)
// ---------------------------------------------------------------------------

/**
 * The closed envelope a sandbox runner prints on stdout:
 * `{"ok":true,"value":…}` on success, `{"ok":false,"code":"…",
 * "message":"…"}` on a typed bound violation. The executor trusts
 * NOTHING: the envelope's code is checked against the closed
 * vocabulary and the value is fully re-validated.
 */
export interface RunnerResultEnvelope {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly code?: string;
  readonly message?: string;
}

/** The closed error-code subset a runner may report. */
const RUNNER_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  "input-shape",
  "input-unbounded",
  "iteration-exceeded",
  "output-unbounded",
  "output-untyped",
  "operation-vocabulary",
  "seam-shape",
]);

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export interface ProgrammaticExecutionInput {
  /** The declared mechanical spec (validated fail-closed before crossing). */
  readonly spec: ProgrammaticSpec;
  /** The bounded input (validated fail-closed before crossing). */
  readonly input: ProgrammaticInput;
  /** The sandbox-authority scope (execution/environment/actor/key). */
  readonly scope: ProgrammaticSandboxScope;
  /**
   * The tool-surface identity the work was derived through (provenance;
   * null when the run was not derived through a surface).
   */
  readonly surfaceId: string | null;
  /**
   * The source plan's step facts (the result-contract binding target).
   * Required: the result must round-trip into the plan.
   */
  readonly steps: readonly ResultStepFacts[];
}

/**
 * Execute one bounded programmatic work item through the existing
 * sandbox authority. Total: every failure is a typed
 * `ProgrammaticError`; the returned compact structured result is
 * validated, typed, bounded and provenance-bound.
 */
export async function runProgrammaticExecution(
  input: ProgrammaticExecutionInput,
  seam: SandboxComputeSeam,
  digest: IrDigestPort,
): Promise<CompactStructuredResult> {
  // 1. Fail-closed validation of everything that crosses.
  const spec = validateProgrammaticSpec(input.spec);
  const programmaticInput = validateProgrammaticInput(input.input, spec.bounds);
  if (input.scope === null || typeof input.scope !== "object") {
    rejectProgrammatic("seam-shape", "the execution requires a sandbox scope");
  }

  // 2. Submit through the existing sandbox authority (the seam).
  const observation = await seam.runProgrammaticWork({
    scope: input.scope,
    spec,
    input: programmaticInput,
  });
  if (
    typeof observation !== "object" ||
    observation === null ||
    typeof observation.status !== "string"
  ) {
    rejectProgrammatic("seam-shape", "the seam returned a malformed observation");
  }
  const sandboxId =
    observation.sandboxId === null || observation.sandboxId === undefined
      ? null
      : String(observation.sandboxId);

  // 3. Map the sandbox authority's outcome honestly (never fabricated).
  if (observation.status === "denied") {
    rejectProgrammatic(
      "sandbox-denied",
      `the sandbox admission authority denied the programmatic run (${
        observation.failure?.failureClass ?? "unknown"
      }: ${observation.failure?.message ?? "no reason recorded"})`,
      {
        sandboxId: sandboxId ?? "",
        denialClass: observation.failure?.failureClass ?? "",
      },
    );
  }
  if (observation.status === "non-convergent") {
    rejectProgrammatic(
      "non-convergent",
      "the sandbox left an honest unknown-outcome state (crash or concurrent claim); the programmatic run fails closed instead of assuming an outcome",
      { sandboxId: sandboxId ?? "" },
    );
  }
  if (observation.status === "failed") {
    rejectProgrammatic(
      "sandbox-failed",
      `the sandbox execution failed (${observation.failure?.failureClass ?? "sandbox-execution"}: ${
        observation.failure?.message ?? "no failure recorded"
      })`,
      {
        sandboxId: sandboxId ?? "",
        failureClass: observation.failure?.failureClass ?? "",
      },
    );
  }
  if (observation.status !== "completed") {
    rejectProgrammatic("seam-shape", "the seam returned an unknown status", {
      status: String(observation.status),
    });
  }

  // 4. Parse the runner's closed envelope (trust nothing).
  const stdout = observation.stdout ?? "";
  let envelope: RunnerResultEnvelope;
  try {
    envelope = JSON.parse(stdout) as RunnerResultEnvelope;
  } catch {
    rejectProgrammatic("output-unparseable", "the sandbox run's stdout is not parseable JSON", {
      sandboxId: sandboxId ?? "",
      stdoutLength: stdout.length,
    });
  }
  if (typeof envelope !== "object" || envelope === null || typeof envelope.ok !== "boolean") {
    rejectProgrammatic("output-unparseable", "the sandbox run's output envelope is malformed");
  }
  if (!envelope.ok) {
    const code = typeof envelope.code === "string" ? envelope.code : "";
    if (!RUNNER_ERROR_CODES.has(code)) {
      // A code outside the closed vocabulary is never trusted.
      rejectProgrammatic("seam-shape", "the sandbox runner reported an unknown error code", {
        code,
      });
    }
    rejectProgrammatic(
      code as ProgrammaticErrorCode,
      `the programmatic work failed its bounds inside the sandbox authority: ${
        typeof envelope.message === "string" ? envelope.message : "no message recorded"
      }`,
      { sandboxId: sandboxId ?? "" },
    );
  }
  if (envelope.value === undefined) {
    rejectProgrammatic("output-unparseable", "a successful envelope must carry a value");
  }
  if (!isProgrammaticOperation(spec.operation)) {
    rejectProgrammatic("operation-vocabulary", "the operation is outside the closed set");
  }
  // Total output validation: typed shape + the spec's output bound.
  checkTypedValue(spec.operation, envelope.value, spec.bounds.maxOutputBytes);

  // 5. Build the compact structured result (content-addressed, provenance-bound).
  const result = buildCompactResult({
    spec,
    value: envelope.value,
    sandboxId,
    outputDigest: observation.outputDigest ?? null,
    surfaceId: input.surfaceId,
    digest,
  });

  // 6. Round-trip into the plan's result contract (fail closed).
  return bindResultToPlan(result, input.steps);
}

/**
 * The serialized crossing payloads the executor hands the seam
 * (bounded; exposed for the seam adapter's task materialization and
 * for tests proving the crossing bounds).
 */
export function crossingPayloads(input: ProgrammaticExecutionInput): {
  readonly specJson: string;
  readonly inputJson: string;
} {
  const spec = validateProgrammaticSpec(input.spec);
  const programmaticInput = validateProgrammaticInput(input.input, spec.bounds);
  return {
    specJson: JSON.stringify(spec),
    inputJson: serializeInput(programmaticInput.items),
  };
}
