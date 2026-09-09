/**
 * Programmatic-execution executor unit tests (WORK-051): the bounded
 * executor over a FAKE seam — fail-closed validation before crossing,
 * honest outcome mapping (completed/failed/denied/non-convergent),
 * total output validation of the runner's closed envelope (unknown
 * codes are never trusted), the compact-result construction and the
 * plan result-contract binding.
 */

import { describe, expect, test } from "vitest";
import { runProgrammaticExecution } from "../../../../src/platform/tool-surface/executor";
import {
  ProgrammaticError,
  validateProgrammaticSpec,
} from "../../../../src/platform/tool-surface/programmatic";
import type { ResultStepFacts } from "../../../../src/platform/tool-surface/results";
import type {
  ProgrammaticSandboxObservation,
  ProgrammaticSandboxRequest,
  SandboxComputeSeam,
} from "../../../../src/platform/tool-surface/seams";
import { nodeDigest } from "./world";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const ENVIRONMENT_ID = "00000000-0000-7000-8000-0000000000f1";
const ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000c1",
  applicationId: "00000000-0000-7000-8000-0000000000b1",
  tenantId: "00000000-0000-7000-8000-0000000000a1",
};

const STEPS: readonly ResultStepFacts[] = [
  {
    stepId: "curate",
    stepClass: "transform",
    computationType: "deterministic",
    sideEffectClass: "pure",
  },
  {
    stepId: "gen",
    stepClass: "call-model",
    computationType: "probabilistic",
    sideEffectClass: "model-inference",
  },
];

function filterSpec() {
  return validateProgrammaticSpec({
    specId: "curate-filter",
    stepId: "curate",
    operation: "filter",
    params: { field: "status", equals: "ok" },
    bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
  });
}

function input() {
  return {
    items: [
      { status: "ok", n: 1 },
      { status: "bad", n: 2 },
    ],
  };
}

function fakeSeam(
  respond: (request: ProgrammaticSandboxRequest) => ProgrammaticSandboxObservation,
): SandboxComputeSeam & { readonly requests: ProgrammaticSandboxRequest[] } {
  const requests: ProgrammaticSandboxRequest[] = [];
  return {
    requests,
    async runProgrammaticWork(request) {
      requests.push(request);
      return respond(request);
    },
  };
}

const COMPLETED: ProgrammaticSandboxObservation = {
  status: "completed",
  sandboxId: "sandbox-1",
  stdout: JSON.stringify({ ok: true, value: [{ status: "ok", n: 1 }] }),
  outputDigest: "a".repeat(64),
  failure: null,
  durationMs: 12,
};

describe("programmatic execution executor (WORK-051)", () => {
  test("executes through the seam and validates the compact result end-to-end", async () => {
    const seam = fakeSeam(() => COMPLETED);
    const result = await runProgrammaticExecution(
      {
        spec: filterSpec(),
        input: input(),
        scope: {
          executionId: EXECUTION_ID,
          environmentId: ENVIRONMENT_ID,
          idempotencyKey: "run-1",
          actor: ACTOR,
        },
        surfaceId: "b".repeat(64),
        steps: STEPS,
      },
      seam,
      nodeDigest,
    );
    expect(result.stepId).toBe("curate");
    expect(result.operation).toBe("filter");
    expect(result.value).toEqual([{ status: "ok", n: 1 }]);
    expect(result.provenance.sandboxId).toBe("sandbox-1");
    expect(result.provenance.outputDigest).toBe("a".repeat(64));
    expect(result.provenance.surfaceId).toBe("b".repeat(64));
    expect(result.provenance.specId).toBe("curate-filter");
    expect(result.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    // The seam received the VALIDATED spec and the bounded input.
    expect(seam.requests).toHaveLength(1);
    expect(seam.requests[0]?.spec.operation).toBe("filter");
    expect(seam.requests[0]?.input.items).toHaveLength(2);
  });

  test("fail-closed validation before anything crosses (unbounded input)", async () => {
    const seam = fakeSeam(() => COMPLETED);
    await expect(
      runProgrammaticExecution(
        {
          spec: filterSpec(),
          input: { items: new Array(65).fill({ status: "ok" }) },
          scope: {
            executionId: EXECUTION_ID,
            environmentId: ENVIRONMENT_ID,
            idempotencyKey: "run-2",
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS,
        },
        seam,
        nodeDigest,
      ),
    ).rejects.toMatchObject({ code: "input-unbounded" });
    expect(seam.requests).toHaveLength(0);
  });

  test("honest outcome mapping: failed, denied, non-convergent", async () => {
    const cases: readonly [ProgrammaticSandboxObservation, string][] = [
      [
        {
          status: "failed",
          sandboxId: "sandbox-2",
          stdout: null,
          outputDigest: null,
          failure: { failureClass: "timeout", message: "process exceeded its admitted timeout" },
          durationMs: 30_000,
        },
        "sandbox-failed",
      ],
      [
        {
          status: "denied",
          sandboxId: "sandbox-3",
          stdout: null,
          outputDigest: null,
          failure: { failureClass: "POLICY_DENIED", message: "denied by policy" },
          durationMs: null,
        },
        "sandbox-denied",
      ],
      [
        {
          status: "non-convergent",
          sandboxId: "sandbox-4",
          stdout: null,
          outputDigest: null,
          failure: { failureClass: "non-convergent", message: "dispatching" },
          durationMs: null,
        },
        "non-convergent",
      ],
    ];
    for (const [observation, code] of cases) {
      const seam = fakeSeam(() => observation);
      let caught: unknown;
      try {
        await runProgrammaticExecution(
          {
            spec: filterSpec(),
            input: input(),
            scope: {
              executionId: EXECUTION_ID,
              environmentId: ENVIRONMENT_ID,
              idempotencyKey: `run-${code}`,
              actor: ACTOR,
            },
            surfaceId: null,
            steps: STEPS,
          },
          seam,
          nodeDigest,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProgrammaticError);
      expect((caught as ProgrammaticError).code).toBe(code);
    }
  });

  test("the runner envelope is validated: unparseable, malformed, unknown codes, untyped values", async () => {
    const badObservations: readonly [string, string][] = [
      ["not json at all", "output-unparseable"],
      [JSON.stringify({ ok: "yes" }), "output-unparseable"],
      [JSON.stringify({ ok: false, code: "totally-invented", message: "x" }), "seam-shape"],
      [JSON.stringify({ ok: true, value: { count: 1 } }), "output-untyped"],
      [JSON.stringify({ ok: true }), "output-unparseable"],
    ];
    for (const [stdout, code] of badObservations) {
      const seam = fakeSeam(() => ({
        status: "completed",
        sandboxId: "sandbox-5",
        stdout,
        outputDigest: "d".repeat(64),
        failure: null,
        durationMs: 5,
      }));
      let caught: unknown;
      try {
        await runProgrammaticExecution(
          {
            spec: filterSpec(),
            input: input(),
            scope: {
              executionId: EXECUTION_ID,
              environmentId: ENVIRONMENT_ID,
              idempotencyKey: `run-${code}`,
              actor: ACTOR,
            },
            surfaceId: null,
            steps: STEPS,
          },
          seam,
          nodeDigest,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProgrammaticError);
      expect((caught as ProgrammaticError).code).toBe(code);
    }
  });

  test("a typed bound violation reported by the runner maps to its closed code", async () => {
    const seam = fakeSeam(() => ({
      status: "completed",
      sandboxId: "sandbox-6",
      stdout: JSON.stringify({
        ok: false,
        code: "iteration-exceeded",
        message: "iteration bound exceeded",
      }),
      outputDigest: null,
      failure: null,
      durationMs: 4,
    }));
    let caught: unknown;
    try {
      await runProgrammaticExecution(
        {
          spec: filterSpec(),
          input: input(),
          scope: {
            executionId: EXECUTION_ID,
            environmentId: ENVIRONMENT_ID,
            idempotencyKey: "run-iter",
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS,
        },
        seam,
        nodeDigest,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as ProgrammaticError).code).toBe("iteration-exceeded");
  });

  test("the result binds only to mechanical-family plan steps", async () => {
    const seam = fakeSeam(() => COMPLETED);
    // The filter spec declares step `curate`; binding against steps that
    // do not include it fails closed.
    let caught: unknown;
    try {
      await runProgrammaticExecution(
        {
          spec: filterSpec(),
          input: input(),
          scope: {
            executionId: EXECUTION_ID,
            environmentId: ENVIRONMENT_ID,
            idempotencyKey: "run-bind",
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS.slice(1),
        },
        seam,
        nodeDigest,
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as ProgrammaticError).code).toBe("result-shape");
  });
});
