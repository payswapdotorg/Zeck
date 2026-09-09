/**
 * Discrimination tests — the tool-surface plane protections (WORK-051,
 * HIGH_ASSURANCE; the worker-runbook rule: "For HIGH_ASSURANCE and
 * CRITICAL, add an explicit discrimination test that proves a weakened
 * protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-051 is
 * mutation-proven — the WEAKENED or VIOLATING form is rejected by the
 * machinery that owns it:
 *
 *  - D1 invented representations are unrepresentable: an unknown
 *    representation key in a config binding and an unknown
 *    representation value in a surface are both rejected with typed
 *    codes (the closed set has no extension point).
 *  - D2 capability-widening and policy-bypassing derivations are
 *    rejected: a need whose tool capability is unmet (or absent) fails
 *    closed EVEN WHEN a fully materializable config binding exists —
 *    the config is DATA and can never widen, grant or bypass the
 *    governing facts; a denied tool fails closed across ALL SEVEN
 *    representations; the constraint inputs are never mutated.
 *  - D3 unbounded programmatic work fails closed: removed, missing,
 *    non-positive, non-integer and over-cap bounds are typed
 *    rejections; the kernel enforces the iteration and output bounds
 *    on adversarial inputs (an unbounded workload cannot run).
 *  - D4 untyped or oversized results are rejected: a kernel sum over
 *    non-numeric records, an oversized compact-result value and an
 *    executor envelope whose value violates the operation's typed
 *    shape all fail closed — never coerced, never truncated.
 *  - D5 non-minimal surfaces are rejected: a superset surface is
 *    rejected by the minimality proof EVEN WHEN the attacker
 *    recomputes the content digest (identity forgery does not
 *    smuggle a superset past the audit).
 *  - D6 deterministic re-derivation mismatches are detected: a
 *    re-digested drifted surface (every field consistent, digest
 *    recomputed) is still caught by the audit's deterministic replay
 *    — while the clean chain re-derives byte-identically.
 *  - D7 MCP is never required: an mcp-only binding with the adapter
 *    disabled fails closed honestly (no silent enablement); a
 *    fully-representable plan with zero mcp bindings and the adapter
 *    enabled derives without MCP ever being injected.
 *  - D8 the sandbox runner's closed envelope is never trusted: an
 *    invented envelope code, an unparseable envelope and a typed
 *    bound violation are each mapped to their closed codes — the
 *    executor never fabricates a success from a mutating runner.
 *  - D9 programmatic results bind only to the plan's mechanical
 *    family: a result claiming an unknown step or a non-mechanical
 *    (probabilistic) step is rejected (EXECUTION-PROVENANCE).
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan, createNodeDigest } from "../../src/modules/planning/public";
import { canonicalJson } from "../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../src/platform/execution-ir/constraints";
import { deriveExecutionIr, type ExecutionIr } from "../../src/platform/execution-ir/ir";
import {
  type ToolSurfaceConfig,
  ToolSurfaceError,
  validateToolSurfaceConfig,
} from "../../src/platform/tool-surface/catalog";
import {
  assertSurfaceMinimal,
  auditToolSurface,
  type DeriveToolSurfaceInput,
  deriveToolSurface,
  type ToolSurface,
  validateToolSurface,
} from "../../src/platform/tool-surface/derive";
import { runProgrammaticExecution } from "../../src/platform/tool-surface/executor";
import { extractToolNeeds } from "../../src/platform/tool-surface/needs";
import {
  evaluateProgrammaticSpec,
  PROGRAMMATIC_BOUND_CAPS,
  ProgrammaticError,
  type ProgrammaticSpec,
  validateProgrammaticInput,
  validateProgrammaticSpec,
} from "../../src/platform/tool-surface/programmatic";
import type { ResultStepFacts } from "../../src/platform/tool-surface/results";
import { buildCompactResult, checkTypedValue } from "../../src/platform/tool-surface/results";
import type {
  ProgrammaticSandboxObservation,
  ProgrammaticSandboxRequest,
  SandboxComputeSeam,
} from "../../src/platform/tool-surface/seams";

const nodeDigest = createNodeDigest();
const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000c1",
  applicationId: "00000000-0000-7000-8000-0000000000b1",
  tenantId: "00000000-0000-7000-8000-0000000000a1",
};

/** A governed plan with two tool needs and one mechanical declaration. */
function governedIr(): ExecutionIr {
  const plan = buildPlan(
    {
      revision: 3,
      strategyClass: "hybrid",
      steps: [
        { id: "fetch", stepClass: "call-tool", capabilityId: "web-retrieval" },
        {
          id: "curate",
          stepClass: "transform",
          config: {
            programmatic: {
              specId: "curate-filter",
              stepId: "curate",
              operation: "filter",
              params: { field: "status", equals: "ok" },
              bounds: {
                maxInputItems: 64,
                maxIterations: 512,
                maxOutputBytes: 8192,
                wallClockMs: 5000,
              },
            },
          },
        },
        { id: "parse", stepClass: "call-tool", capabilityId: "parsing" },
      ],
      edges: [
        { from: "fetch", to: "curate" },
        { from: "curate", to: "parse" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

function satisfiedConstraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "capability-satisfaction",
      kind: "capability",
      enforcement: "hard",
      source: { authority: "capability", catalogRevision: "rev-1" },
      payload: { satisfiedIds: ["web-retrieval", "parsing"], unmetIds: [] },
    },
    {
      constraintId: "policy-eligibility",
      kind: "policy",
      enforcement: "hard",
      source: { authority: "policy", policySetId: "ps-1" },
      payload: { providerModel: { allowedProviders: ["rail-a"] } },
    },
  ];
}

function allSevenConfig(): ToolSurfaceConfig {
  return {
    configSchema: 1,
    mcpEnabled: true,
    programmaticEnabled: true,
    bindings: [
      {
        toolId: "web-retrieval",
        representations: {
          direct: { typed: true },
          deferred: { discoverable: true },
          cli: { command: "fetch-cli" },
          script: { scriptRef: "fetch-script" },
          code: { api: "fetch-api" },
          mcp: { server: "tools-mcp" },
          competence: { competenceRef: "fetch-competence" },
        },
      },
      {
        toolId: "parsing",
        representations: {
          direct: { typed: true },
          deferred: { discoverable: true },
          cli: { command: "parse-cli" },
          script: { scriptRef: "parse-script" },
          code: { api: "parse-api" },
          mcp: { server: "tools-mcp" },
          competence: { competenceRef: "parse-competence" },
        },
      },
    ],
  };
}

function cleanInput(): DeriveToolSurfaceInput {
  return {
    ir: governedIr(),
    constraints: satisfiedConstraints(),
    config: allSevenConfig(),
    digest: nodeDigest,
  };
}

/** A mutable surface mirror for mutation proofs (validation must reject the forged forms). */
type MutableSurface = Omit<ToolSurface, "toolBindings" | "surfaceId"> & {
  surfaceId: string;
  toolBindings: {
    needId: string;
    stepId: string;
    toolId: string;
    representation: string;
    bindingRef: string | null;
    selectionBasis: string;
    rejected: { representation: string; code: string }[];
  }[];
};

/** The constraint at an index, guaranteed present (the fixture always carries two). */
function constraintAt(
  constraints: OptimizationConstraint[],
  index: number,
): OptimizationConstraint {
  const constraint = constraints.at(index);
  if (constraint === undefined) {
    throw new Error("fixture requires the constraint to exist");
  }
  return constraint;
}

/** The step facts at an index, guaranteed present. */
function stepAt(steps: readonly ResultStepFacts[], index: number): ResultStepFacts {
  const step = steps.at(index);
  if (step === undefined) {
    throw new Error("fixture requires the step to exist");
  }
  return step;
}

function mutableCopy(surface: ToolSurface): MutableSurface {
  return JSON.parse(JSON.stringify(surface)) as MutableSurface;
}

/** Recompute the content digest over a mutated surface (the identity-forgery attempt). */
function recomputeSurfaceId(surface: MutableSurface): string {
  const form = {
    surfaceSchema: 1,
    planId: surface.planId,
    planRevision: surface.planRevision,
    irId: surface.irId,
    ...(surface.sourceVariantIrId === null ? {} : { sourceVariantIrId: surface.sourceVariantIrId }),
    toolBindings: surface.toolBindings,
    programmatic: surface.programmatic,
    provenance: surface.provenance,
  };
  return nodeDigest.sha256Hex(canonicalJson(form));
}

function caughtOf(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return new Error("expected a typed rejection, got a success");
}

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

function filterSpec(bounds?: Record<string, unknown>): ProgrammaticSpec {
  return validateProgrammaticSpec({
    specId: "curate-filter",
    stepId: "curate",
    operation: "filter",
    params: { field: "status", equals: "ok" },
    bounds: bounds ?? {
      maxInputItems: 64,
      maxIterations: 512,
      maxOutputBytes: 8192,
      wallClockMs: 5000,
    },
  });
}

/** A fake seam answering with a fixed observation (envelope-level mutation proofs). */
function fakeSeam(stdout: string): SandboxComputeSeam {
  return {
    async runProgrammaticWork(
      _request: ProgrammaticSandboxRequest,
    ): Promise<ProgrammaticSandboxObservation> {
      return {
        status: "completed",
        sandboxId: "sandbox-mutation",
        stdout,
        outputDigest: "a".repeat(64),
        failure: null,
        durationMs: 3,
      };
    },
  };
}

describe("tool-surface plane discrimination (WORK-051)", () => {
  // -------------------------------------------------------------------------
  // D1 — invented representations are unrepresentable
  // -------------------------------------------------------------------------
  test("D1 an invented representation key in a config binding is rejected (closed set, no extension point)", () => {
    const inventions = ["grpc", "rest-api", "direct2", "Direct", "mcp-server", "plugin"];
    for (const invented of inventions) {
      const config = {
        configSchema: 1,
        mcpEnabled: false,
        programmaticEnabled: true,
        bindings: [
          {
            toolId: "web-retrieval",
            representations: { [invented]: { ref: "x" } },
          },
        ],
      };
      const error = caughtOf(() => validateToolSurfaceConfig(config)) as ToolSurfaceError;
      expect(error).toBeInstanceOf(ToolSurfaceError);
      expect(error.invariant).toBe("surface-config");
    }
    // An invented representation VALUE inside a derived surface is
    // equally unrepresentable (validation rejects it).
    const surface = deriveToolSurface(cleanInput());
    const mutated = mutableCopy(surface);
    const binding = mutated.toolBindings.at(0);
    if (binding === undefined) {
      throw new Error("fixture requires a binding to mutate");
    }
    binding.representation = "quantum-link";
    const error = caughtOf(() => validateToolSurface(mutated, nodeDigest)) as ToolSurfaceError;
    expect(error).toBeInstanceOf(ToolSurfaceError);
    expect(error.invariant).toBe("surface-shape");
  });

  // -------------------------------------------------------------------------
  // D2 — capability-widening / policy-bypassing derivations are rejected
  // -------------------------------------------------------------------------
  test("D2 a fully materializable config binding can NEVER widen an unmet capability (fail closed)", () => {
    const ir = governedIr();
    // `parsing` is UNMET in the governing facts, but its config binding
    // is fully materializable (all seven representations): the
    // derivation still fails closed — the config is DATA, never a
    // capability grant.
    const unmet: OptimizationConstraint[] = [
      {
        constraintId: "capability-satisfaction",
        kind: "capability",
        enforcement: "hard",
        source: { authority: "capability", catalogRevision: "rev-1" },
        payload: { satisfiedIds: ["web-retrieval"], unmetIds: ["parsing"] },
      },
      ...satisfiedConstraints().slice(1),
    ];
    const error = caughtOf(() =>
      deriveToolSurface({ ir, constraints: unmet, config: allSevenConfig(), digest: nodeDigest }),
    ) as ToolSurfaceError;
    expect(error).toBeInstanceOf(ToolSurfaceError);
    expect(error.invariant).toBe("capability-condition");
    expect(error.details.toolId).toBe("parsing");
    // Absent facts entirely (no capability constraint): fail closed.
    const absent = satisfiedConstraints().slice(1);
    const errorAbsent = caughtOf(() =>
      deriveToolSurface({ ir, constraints: absent, config: allSevenConfig(), digest: nodeDigest }),
    ) as ToolSurfaceError;
    expect(errorAbsent.invariant).toBe("capability-condition");
  });

  test("D2b a policy-denied tool fails closed across ALL SEVEN representations (no representation bypasses policy)", () => {
    const ir = governedIr();
    const denied: OptimizationConstraint[] = [
      constraintAt(satisfiedConstraints(), 0),
      {
        constraintId: "policy-eligibility",
        kind: "policy",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: { tool: { deniedTools: ["parsing"] } },
      },
    ];
    const error = caughtOf(() =>
      deriveToolSurface({ ir, constraints: denied, config: allSevenConfig(), digest: nodeDigest }),
    ) as ToolSurfaceError;
    expect(error).toBeInstanceOf(ToolSurfaceError);
    expect(error.invariant).toBe("policy-condition");
    expect(error.details.toolId).toBe("parsing");
  });

  test("D2c the governing constraint inputs are never mutated by derivation (read-only consultation)", () => {
    const constraints = satisfiedConstraints();
    const before = JSON.stringify(constraints);
    deriveToolSurface({ ...cleanInput(), constraints });
    expect(JSON.stringify(constraints)).toBe(before);
    // A deep-frozen constraint set derives identically (the derivation
    // cannot have written anywhere inside it).
    const frozen = deepFreeze(JSON.parse(JSON.stringify(satisfiedConstraints())));
    const surface = deriveToolSurface({
      ir: governedIr(),
      constraints: frozen,
      config: allSevenConfig(),
      digest: nodeDigest,
    });
    expect(surface.toolBindings).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // D3 — unbounded programmatic work fails closed
  // -------------------------------------------------------------------------
  test("D3 removed, missing, non-integer, non-positive and over-cap bounds are typed rejections", () => {
    const badBounds: unknown[] = [
      {},
      { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192 },
      { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 0 },
      { maxInputItems: -1, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
      { maxInputItems: 1.5, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
      { maxInputItems: 64, maxIterations: 100_000, maxOutputBytes: 8192, wallClockMs: 5000 },
      null,
      "no-bounds",
    ];
    for (const bounds of badBounds) {
      const error = caughtOf(() =>
        validateProgrammaticSpec({
          specId: "curate-filter",
          stepId: "curate",
          operation: "filter",
          params: { field: "status", equals: "ok" },
          bounds,
        }),
      ) as ProgrammaticError;
      expect(error).toBeInstanceOf(ProgrammaticError);
      expect(error.code).toBe("bound-violation");
    }
  });

  test("D3b the kernel enforces the iteration and output bounds on adversarial workloads", () => {
    // A fan-out whose items exceed maxIterations: the evaluation fails
    // closed (an unbounded workload cannot complete).
    const tight = filterSpec({
      maxInputItems: 64,
      maxIterations: 8,
      maxOutputBytes: 8192,
      wallClockMs: 5000,
    });
    const items = Array.from({ length: 64 }, (_, index) => ({ status: "ok", index }));
    const kernel = caughtOf(() =>
      evaluateProgrammaticSpec({ ...tight, operation: "fan-out", params: {} }, { items }),
    ) as ProgrammaticError;
    expect(kernel).toBeInstanceOf(ProgrammaticError);
    expect(kernel.code).toBe("iteration-exceeded");
    // An output larger than maxOutputBytes: rejected, never truncated.
    const tinyOutput = filterSpec({
      maxInputItems: 64,
      maxIterations: 512,
      maxOutputBytes: 16,
      wallClockMs: 5000,
    });
    const oversized = caughtOf(() =>
      evaluateProgrammaticSpec(tinyOutput, { items: [{ status: "ok", pad: "x".repeat(64) }] }),
    ) as ProgrammaticError;
    expect(oversized.code).toBe("output-unbounded");
    // The input item bound is enforced at validation AND evaluation.
    const error = caughtOf(() =>
      validateProgrammaticInput({ items: new Array(65).fill({ status: "ok" }) }, tight.bounds),
    ) as ProgrammaticError;
    expect(error.code).toBe("input-unbounded");
  });

  // -------------------------------------------------------------------------
  // D4 — untyped or oversized results are rejected
  // -------------------------------------------------------------------------
  test("D4 a kernel sum over non-numeric records is a typed rejection (never coerced)", () => {
    const spec = validateProgrammaticSpec({
      specId: "sum-1",
      stepId: "curate",
      operation: "aggregate",
      params: { metric: "sum", field: "n" },
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
    });
    const error = caughtOf(() =>
      evaluateProgrammaticSpec(spec, { items: [{ n: 1 }, { n: "two" }] }),
    ) as ProgrammaticError;
    expect(error).toBeInstanceOf(ProgrammaticError);
    expect(error.code).toBe("output-untyped");
  });

  test("D4b an oversized compact-result value is rejected at construction (never truncated)", () => {
    const spec = filterSpec({
      maxInputItems: 64,
      maxIterations: 512,
      maxOutputBytes: 16,
      wallClockMs: 5000,
    });
    const error = caughtOf(() =>
      buildCompactResult({
        spec,
        value: [{ status: "ok", pad: "x".repeat(64) }],
        sandboxId: "sandbox-1",
        outputDigest: "a".repeat(64),
        surfaceId: null,
        digest: nodeDigest,
      }),
    ) as ProgrammaticError;
    expect(error).toBeInstanceOf(ProgrammaticError);
    expect(error.code).toBe("output-unbounded");
  });

  test("D4c an executor envelope whose value violates the operation's typed shape is rejected", async () => {
    // A filter envelope whose value is an aggregate-shaped object.
    const seam = fakeSeam(JSON.stringify({ ok: true, value: { count: 2 } }));
    const caught = await runProgrammaticExecution(
      {
        spec: filterSpec(),
        input: { items: [{ status: "ok" }, { status: "bad" }] },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: "env-1",
          idempotencyKey: "disc-untyped",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: STEPS,
      },
      seam,
      nodeDigest,
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProgrammaticError);
    expect((caught as ProgrammaticError).code).toBe("output-untyped");
    // A filter envelope whose value is a scalar.
    const seamScalar = fakeSeam(JSON.stringify({ ok: true, value: 42 }));
    const caughtScalar = await runProgrammaticExecution(
      {
        spec: filterSpec(),
        input: { items: [] },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: "env-1",
          idempotencyKey: "disc-scalar",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: STEPS,
      },
      seamScalar,
      nodeDigest,
    ).catch((error: unknown) => error);
    expect((caughtScalar as ProgrammaticError).code).toBe("output-untyped");
  });

  // -------------------------------------------------------------------------
  // D5 — non-minimal surfaces are rejected (even with a forged digest)
  // -------------------------------------------------------------------------
  test("D5 a superset surface is rejected EVEN WHEN the digest is recomputed (identity forgery does not smuggle bindings)", () => {
    const input = cleanInput();
    const surface = deriveToolSurface(input);
    const needs = extractToolNeeds(input.ir.steps);
    // The mutation: an extra binding beyond the plan's declared needs,
    // with the surfaceId RECOMPUTED over the mutated content.
    const superset = mutableCopy(surface);
    const template = superset.toolBindings.at(0);
    if (template === undefined) {
      throw new Error("fixture requires a binding to clone");
    }
    superset.toolBindings.push({
      ...template,
      needId: "ghost",
      stepId: "ghost",
      toolId: "ghost-tool",
    });
    superset.surfaceId = recomputeSurfaceId(superset);
    // Shape + identity validation PASSES (the digest matches the content)…
    const validated = validateToolSurface(superset as unknown as ToolSurface, nodeDigest);
    expect(validated.toolBindings).toHaveLength(3);
    // …but the minimality proof rejects the superset…
    const minimal = caughtOf(() =>
      assertSurfaceMinimal(validated, needs, input.ir.steps),
    ) as ToolSurfaceError;
    expect(minimal.invariant).toBe("surface-non-minimal");
    // …and the deterministic audit reports BOTH the non-minimality and
    // the derivation mismatch (the forged identity cannot reproduce the
    // canonical derivation output).
    const violations = auditToolSurface(superset as unknown as ToolSurface, input);
    expect(violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(["derivation-mismatch", "surface-non-minimal"]),
    );
  });

  test("D5b a subset surface (dropped binding) is equally rejected", () => {
    const input = cleanInput();
    const surface = deriveToolSurface(input);
    const needs = extractToolNeeds(input.ir.steps);
    const subset = mutableCopy(surface);
    subset.toolBindings = subset.toolBindings.slice(0, 1);
    subset.surfaceId = recomputeSurfaceId(subset);
    const minimal = caughtOf(() =>
      assertSurfaceMinimal(subset as unknown as ToolSurface, needs, input.ir.steps),
    ) as ToolSurfaceError;
    expect(minimal.invariant).toBe("surface-non-minimal");
  });

  // -------------------------------------------------------------------------
  // D6 — deterministic re-derivation mismatches are detected
  // -------------------------------------------------------------------------
  test("D6 a re-digested drifted surface is caught by the deterministic replay (digest forgery is not derivation forgery)", () => {
    const input = cleanInput();
    const surface = deriveToolSurface(input);
    // Positive control: the clean chain audits with ZERO violations and
    // re-derives byte-identically.
    expect(auditToolSurface(surface, input)).toEqual([]);
    const rederived = deriveToolSurface(input);
    expect(rederived.surfaceId).toBe(surface.surfaceId);
    expect(JSON.stringify(rederived)).toBe(JSON.stringify(surface));
    // The mutation: a drifted rejection record (a code flipped to a
    // DIFFERENT closed code — still vocabulary-legal), digest
    // recomputed. Shape and identity validation pass, but the audit's
    // deterministic replay detects the drift.
    const drifted = mutableCopy(surface);
    const driftedBinding = drifted.toolBindings.at(0);
    if (driftedBinding === undefined) {
      throw new Error("fixture requires a binding to drift");
    }
    const rejection = driftedBinding.rejected.find(
      (entry) => entry.code === "lower-canonical-rank",
    );
    if (rejection === undefined) {
      throw new Error("fixture must carry a lower-canonical-rank rejection");
    }
    rejection.code = "binding-absent";
    drifted.surfaceId = recomputeSurfaceId(drifted);
    expect(() => validateToolSurface(drifted as unknown as ToolSurface, nodeDigest)).not.toThrow();
    const violations = auditToolSurface(drifted as unknown as ToolSurface, input);
    expect(violations.map((violation) => violation.code)).toContain("derivation-mismatch");
  });

  // -------------------------------------------------------------------------
  // D7 — MCP is one representation among the closed set, never required
  // -------------------------------------------------------------------------
  test("D7 an mcp-only binding with the adapter disabled fails closed honestly (never silently enabled)", () => {
    const ir = governedIr();
    const mcpOnly: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: false,
      programmaticEnabled: true,
      bindings: [
        { toolId: "web-retrieval", representations: { cli: { command: "fetch-cli" } } },
        { toolId: "parsing", representations: { mcp: { server: "tools-mcp" } } },
      ],
    };
    const error = caughtOf(() =>
      deriveToolSurface({
        ir,
        constraints: satisfiedConstraints(),
        config: mcpOnly,
        digest: nodeDigest,
      }),
    ) as ToolSurfaceError;
    expect(error).toBeInstanceOf(ToolSurfaceError);
    expect(error.invariant).toBe("no-admissible-representation");
    expect(String(error.details.rejections)).toContain("mcp:mcp-adapter-disabled");
  });

  test("D7b a plan with zero mcp bindings derives with the adapter enabled (MCP is never injected)", () => {
    const ir = governedIr();
    const noMcp: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: true,
      programmaticEnabled: true,
      bindings: [
        { toolId: "web-retrieval", representations: { direct: { typed: true } } },
        { toolId: "parsing", representations: { cli: { command: "parse-cli" } } },
      ],
    };
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: noMcp,
      digest: nodeDigest,
    });
    expect(surface.toolBindings.map((binding) => binding.representation)).toEqual([
      "direct",
      "cli",
    ]);
    // MCP is never SELECTED without a binding, and its recorded
    // rejection is the honest binding-absent code (the adapter is
    // enabled — mcp was a candidate, it simply has no materialization;
    // the disabled-adapter code never appears when enabled).
    for (const binding of surface.toolBindings) {
      const mcp = binding.rejected.find((entry) => entry.representation === "mcp");
      expect(mcp?.code).toBe("binding-absent");
    }
  });

  // -------------------------------------------------------------------------
  // D8 — the sandbox runner's closed envelope is never trusted
  // -------------------------------------------------------------------------
  test("D8 an invented envelope code is never mapped to a success (unknown codes fail closed)", async () => {
    const invented = fakeSeam(
      JSON.stringify({ ok: false, code: "totally-invented-failure", message: "x" }),
    );
    const caught = await runProgrammaticExecution(
      {
        spec: filterSpec(),
        input: { items: [{ status: "ok" }] },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: "env-1",
          idempotencyKey: "disc-invented-code",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: STEPS,
      },
      invented,
      nodeDigest,
    ).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ProgrammaticError);
    expect((caught as ProgrammaticError).code).toBe("seam-shape");
  });

  test("D8b an unparseable envelope is a typed rejection (never a fabricated success)", async () => {
    for (const stdout of ["not json", "", JSON.stringify({ ok: true }), JSON.stringify(null)]) {
      const seam = fakeSeam(stdout);
      const caught = await runProgrammaticExecution(
        {
          spec: filterSpec(),
          input: { items: [{ status: "ok" }] },
          scope: {
            executionId: EXECUTION_ID,
            environmentId: "env-1",
            idempotencyKey: `disc-unparseable-${stdout.length}`,
            actor: ACTOR,
          },
          surfaceId: null,
          steps: STEPS,
        },
        seam,
        nodeDigest,
      ).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(ProgrammaticError);
      expect((caught as ProgrammaticError).code).toBe("output-unparseable");
    }
  });

  // -------------------------------------------------------------------------
  // D9 — programmatic results bind only to the plan's mechanical family
  // -------------------------------------------------------------------------
  test("D9 a result claiming an unknown or non-mechanical step is rejected (provenance binding)", async () => {
    const seam = fakeSeam(JSON.stringify({ ok: true, value: [{ status: "ok" }] }));
    // Unknown step id.
    const unknownStep = await runProgrammaticExecution(
      {
        spec: filterSpec(),
        input: { items: [{ status: "ok" }] },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: "env-1",
          idempotencyKey: "disc-unknown-step",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: [{ ...stepAt(STEPS, 0), stepId: "elsewhere" }],
      },
      seam,
      nodeDigest,
    ).catch((error: unknown) => error);
    expect((unknownStep as ProgrammaticError).code).toBe("result-shape");
    // A NON-mechanical step (probabilistic call-model): the compact
    // result contract binds only to the mechanical family.
    const nonMechanical = await runProgrammaticExecution(
      {
        spec: { ...filterSpec(), stepId: "gen" },
        input: { items: [{ status: "ok" }] },
        scope: {
          executionId: EXECUTION_ID,
          environmentId: "env-1",
          idempotencyKey: "disc-non-mechanical",
          actor: ACTOR,
        },
        surfaceId: null,
        steps: STEPS,
      },
      seam,
      nodeDigest,
    ).catch((error: unknown) => error);
    expect((nonMechanical as ProgrammaticError).code).toBe("result-shape");
  });

  test("D10 a NON-mechanical plan step cannot DECLARE programmatic work (unrepresentable, never silently ignored)", () => {
    // Programmatic work binds ONLY to deterministic pure steps: a
    // call-model step carrying a programmatic declaration fails the
    // derivation closed (`programmatic-spec`) — the plan's own
    // declared semantics exclude the work; no configuration can
    // revive it.
    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          {
            id: "gen",
            stepClass: "call-model",
            capabilityId: "text-generation",
            routeRef: { provider: "rail-a", model: "model-x" },
            config: {
              programmatic: {
                specId: "gen-work",
                stepId: "gen",
                operation: "filter",
                params: { field: "status", equals: "ok" },
                bounds: {
                  maxInputItems: 4,
                  maxIterations: 8,
                  maxOutputBytes: 512,
                  wallClockMs: 500,
                },
              },
            },
          },
        ],
        edges: [],
      },
      digestValue,
    );
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
    const error = caughtOf(() =>
      deriveToolSurface({
        ir,
        constraints: [
          {
            constraintId: "capability-satisfaction",
            kind: "capability",
            enforcement: "hard",
            source: { authority: "capability", catalogRevision: "rev-1" },
            payload: { satisfiedIds: ["text-generation"], unmetIds: [] },
          },
        ],
        config: {
          configSchema: 1,
          mcpEnabled: false,
          programmaticEnabled: true,
          bindings: [],
        },
        digest: nodeDigest,
      }),
    ) as ToolSurfaceError;
    expect(error).toBeInstanceOf(ToolSurfaceError);
    expect(error.invariant).toBe("programmatic-spec");
  });

  test("D11 the compact-result typed-value matrix: every operation's untyped shape is rejected", () => {
    // The per-operation typed shapes are enforced at the value level
    // (the compact-result contract): aggregates carry exactly one
    // finite numeric metric; fan-out arrays carry {index, item} units;
    // filter/projection arrays carry closed-universe records.
    for (const [operation, value] of [
      ["aggregate", { median: 1 }],
      ["aggregate", [1, 2]],
      ["aggregate", { count: "three" }],
      ["aggregate", { count: 1, sum: 2 }],
      ["fan-out", { index: 0 }],
      ["fan-out", [{}]],
      ["filter", { a: 1 }],
      ["filter", ["scalar"]],
      ["projection", "nope"],
      ["filter", [{ a: undefined }]],
    ] as const) {
      const error = caughtOf(() =>
        checkTypedValue(operation, value as unknown, PROGRAMMATIC_BOUND_CAPS.maxOutputBytes),
      ) as ProgrammaticError;
      expect(
        error,
        `operation ${operation} value ${JSON.stringify(value)} must be untyped`,
      ).toBeInstanceOf(ProgrammaticError);
      expect(error.code).toBe("output-untyped");
    }
  });
});

/** Deep-freeze a JSON value (mutation-proof read-only consultation). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}
