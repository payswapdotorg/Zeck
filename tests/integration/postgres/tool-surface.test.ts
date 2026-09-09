/**
 * Real-PostgreSQL — the tool-surface compiler and programmatic
 * execution integration (WORK-051; checkpoint contracts
 * POLICY-BEFORE-DISPATCH, DEPENDENCY-DIRECTION, IDENTITY-IDEMPOTENCY,
 * EXECUTION-PROVENANCE, SANDBOX-BOUNDARY, CONCURRENCY-CRASH-SAFETY).
 *
 * Proves against real PostgreSQL with the FULL production composition
 * (the sandbox-world fabric: SQL execution store + service, real
 * policy authority behind both seams, real capability registry, real
 * budget service, SQL sandbox store + catalog + service with the REAL
 * admission/capability/ledger adapters, the REAL process provider):
 *
 *  - the FULL E1.1 stage-3 chain over the REAL planner: governed
 *    execution → REAL `planExecution` (policy `allow`, deterministic
 *    sufficiency composition) → the governed plan (a REAL `call-tool`
 *    step, capability-bound) → planning-seam snapshot → derived IR →
 *    governing constraints from the CAPTURED policy inputs + the REAL
 *    capability resolution → `deriveToolSurface` (pure derivation:
 *    capability conditioning read-only, minimal surface, recorded
 *    selection evidence) → total validation + the deterministic
 *    provenance audit (ZERO violations) → byte-identical
 *    re-derivation;
 *  - bounded programmatic execution through the REAL sandbox
 *    authority: every mechanical run is a FULLY ADMITTED, DISPATCHED
 *    and JOURNALED sandbox execution over the SQL store (durable
 *    identity, policy → capability admission chain, ledger evidence
 *    envelopes, the REAL platform process runtime executing the
 *    generic runner shim); the compact structured result round-trips
 *    (content-addressed digest, real sandbox identity + output
 *    digest, the plan result-contract binding); the same idempotency
 *    key replays without re-execution (exactly one durable row);
 *  - CONCURRENCY-CRASH-SAFETY: N=8 SIMULTANEOUS derivations of the
 *    same real-planner IR converge on the identical surface identity;
 *    N=8 SIMULTANEOUS programmatic executions with DISTINCT keys
 *    produce eight distinct durable sandbox rows with the IDENTICAL
 *    compact-result digest (no tearing, no duplication); N=8
 *    SIMULTANEOUS programmatic executions with the SAME key converge
 *    on exactly ONE durable sandbox row (the store's unique index
 *    serializes the race; the one-shot dispatch discipline fails the
 *    losers closed — never a torn or duplicated durable effect).
 */

import { expect, test } from "vitest";
import {
  capabilityConstraintFromResolution,
  constraintsFromPolicyInputs,
  createIrPlanSource,
} from "../../../src/modules/planning/adapters/ir-plan-source";
import {
  buildPlan,
  createCapabilityAuthorityAdapter,
  createInMemoryDeterministicCatalog,
  createNodeDigest,
  createPlannerService,
  createPlanningSinkAdapter,
  createPolicyInputsAdapter,
  createRouteTableExplorer,
  publishDeterministicCapabilityFacts,
} from "../../../src/modules/planning/public";
import { ProcessSandboxProvider } from "../../../src/modules/sandbox/adapters/process-provider";
import { createToolSurfaceComputeSeam } from "../../../src/modules/sandbox/adapters/tool-surface-compute-seam";
import { canonicalJson } from "../../../src/platform/execution-ir/canonical";
import { deriveExecutionIr } from "../../../src/platform/execution-ir/ir";
import type { ToolSurfaceConfig } from "../../../src/platform/tool-surface/catalog";
import {
  auditToolSurface,
  deriveToolSurface,
  validateToolSurface,
} from "../../../src/platform/tool-surface/derive";
import { runProgrammaticExecution } from "../../../src/platform/tool-surface/executor";
import { extractToolNeeds } from "../../../src/platform/tool-surface/needs";
import {
  evaluateProgrammaticSpec,
  validateProgrammaticSpec,
} from "../../../src/platform/tool-surface/programmatic";
import { validateCompactResult } from "../../../src/platform/tool-surface/results";
import { definePgSuite } from "./harness";
import { seedSandboxWorld } from "./sandbox-world";

const digest = createNodeDigest();
const planSource = createIrPlanSource();

definePgSuite("tool-surface compiler and programmatic execution (real PG)", (ctx) => {
  test("the full stage-3 chain over the real planner: derived minimal surface, audited provenance, byte-identical re-derivation", async () => {
    const world = await seedSandboxWorld(ctx.port);
    // The execution must sit in PLANNING when the planner records its
    // durable decision (the planning-sink contract): drive the
    // lifecycle to exactly that state.
    const created = await world.executionService.createExecution(
      {
        applicationId: world.applicationId,
        task: { kind: "analysis", input: { documents: ["doc-1"] } },
      },
      `create-${world.applicationId}:tool-surface`,
      { actorId: world.actor().actorId, tenantId: world.tenantId },
    );
    const executionId = created.executionId;
    for (const [command, key] of [
      ["authorize", `auth-${world.applicationId}:tool-surface`],
      ["plan", `plan-${world.applicationId}:tool-surface`],
    ] as const) {
      await world.executionService.transition(
        {
          command,
          actorId: world.actor().actorId,
          applicationId: world.applicationId,
          tenantId: world.tenantId,
          executionId,
        },
        key,
      );
    }

    // The REAL planner over the world's own authorities (registry,
    // policy authority, executions sink). The deterministic facts are
    // published through the sanctioned path.
    await publishDeterministicCapabilityFacts(world.capabilityRegistry);
    const planner = createPlannerService({
      capabilityAuthority: createCapabilityAuthorityAdapter(world.capabilityRegistry),
      policyInputs: createPolicyInputsAdapter(world.policyAuthority),
      routeExplorer: createRouteTableExplorer([
        {
          provider: "rail-a",
          model: "model-x",
          satisfies: ["text-generation"],
          expectedCostMicroUsd: "1000",
          expectedQuality: 0.92,
          expectedLatencyMs: 2000,
        },
      ]),
      deterministicCatalog: createInMemoryDeterministicCatalog(),
      sink: createPlanningSinkAdapter(world.executionService),
      digest,
      generateId: () =>
        `00000000-0000-7000-8000-${Math.random().toString().slice(2, 14).padStart(12, "0")}`,
      now: () => new Date("2026-09-22T12:00:00Z"),
    });

    // A governed analysis execution: the REAL planner composes the
    // deterministic-sufficient plan with a REAL call-tool step.
    const outcome = await planner.planExecution(
      {
        applicationId: world.applicationId,
        executionId,
        tenantId: world.tenantId,
        actorId: world.actor().actorId,
        task: { kind: "analysis", input: { documents: ["doc-1"] } },
      },
      `ts-plan-${executionId}`,
    );
    expect(outcome.decision.policyInputs.outcome).toBe("allow");
    expect(outcome.selectedPlan.strategyClass).toBe("deterministic-only");
    const callToolSteps = outcome.selectedPlan.steps.filter(
      (step) => step.stepClass === "call-tool",
    );
    expect(callToolSteps).toHaveLength(1);
    expect(callToolSteps[0]?.capabilityId).toBe("document-retrieval");

    // The IR from the governed plan through the planning seam.
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(outcome.selectedPlan), digest);
    expect(ir.planId).toBe(outcome.selectedPlan.planId);

    // The governing constraints: the CAPTURED policy inputs + the REAL
    // capability resolution (the derivation's read-only conditioning
    // facts — exactly what the authorities produced; the permissive
    // policy set contributes no restriction constraints, so the
    // capability mirror is the conditioning fact).
    const constraints = [
      ...constraintsFromPolicyInputs(outcome.decision.policyInputs),
      capabilityConstraintFromResolution(outcome.decision.capabilityResolution),
    ];
    const capabilityConstraint = constraints.find((c) => c.kind === "capability");
    expect(capabilityConstraint).toBeDefined();

    const config: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: false,
      programmaticEnabled: true,
      bindings: [
        {
          toolId: "document-retrieval",
          representations: {
            direct: { typed: true },
            cli: { command: "retrieve-cli" },
            mcp: { server: "tools-mcp" },
          },
        },
      ],
    };

    // DERIVE: the minimal tool surface for the real governed plan.
    const surface = deriveToolSurface({ ir, constraints, config, digest });
    // Minimality: exactly the declared need set (one binding, one need).
    const needs = extractToolNeeds(ir.steps);
    expect(needs.map((need) => need.needId).sort()).toEqual(
      surface.toolBindings.map((binding) => binding.needId).sort(),
    );
    expect(surface.toolBindings).toHaveLength(1);
    const binding = surface.toolBindings[0];
    expect(binding?.toolId).toBe("document-retrieval");
    expect(binding?.representation).toBe("direct");
    expect(binding?.bindingRef).toBeNull();
    // The recorded selection evidence: every non-selected representation
    // carries exactly one closed code (mcp disabled records its typed
    // rejection — never required).
    const codes = new Map(
      binding?.rejected.map((rejection) => [rejection.representation, rejection.code]),
    );
    expect(codes.get("mcp")).toBe("mcp-adapter-disabled");
    expect(codes.get("cli")).toBe("lower-canonical-rank");
    // The provenance chain is preserved verbatim.
    expect(surface.planId).toBe(ir.planId);
    expect(surface.irId).toBe(ir.irId);
    expect(surface.sourceVariantIrId).toBeNull();
    expect(surface.provenance.source).toBe("execution-ir.governed-plan");

    // DURABLE ROUND-TRIP: the surface value survives a JSON round-trip
    // (durable storage shape) and re-validates identically.
    const roundTripped = validateToolSurface(JSON.parse(JSON.stringify(surface)), digest);
    expect(roundTripped.surfaceId).toBe(surface.surfaceId);

    // THE DETERMINISTIC AUDIT: re-derive from the same inputs and prove
    // the identity chain + minimality — ZERO violations, replayable.
    const audit = auditToolSurface(surface, { ir, constraints, config, digest });
    expect(audit).toEqual([]);

    // BYTE-IDENTICAL RE-DERIVATION (determinism over the real chain).
    const rederived = deriveToolSurface({ ir, constraints, config, digest });
    expect(rederived.surfaceId).toBe(surface.surfaceId);
    expect(JSON.stringify(rederived)).toBe(JSON.stringify(surface));
  });

  test("bounded programmatic execution through the REAL sandbox authority with REAL process runs", async () => {
    const world = await seedSandboxWorld(ctx.port);
    world.registerProvider(new ProcessSandboxProvider());
    const executionId = await world.seedExecution("RUNNING");
    const environmentId = await world.registerEnvironment("programmatic-runtime", {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "0" },
    });

    // A governed plan with a declared mechanical step (the planner-
    // independent path is legitimate for the programmatic-execution
    // proof: the surface/decision chain is what matters).
    const plan = buildPlan(
      {
        revision: 1,
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
          { id: "verify", stepClass: "verify", verificationStrategy: "schema-check" },
        ],
        edges: [
          { from: "fetch", to: "curate" },
          { from: "curate", to: "verify" },
        ],
      },
      (value) => digest.sha256Hex(canonicalJson(value)),
    );
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(plan), digest);
    const constraints = [
      {
        constraintId: "capability-satisfaction",
        kind: "capability" as const,
        enforcement: "hard" as const,
        source: { authority: "capability" as const, catalogRevision: "rev-1" },
        payload: { satisfiedIds: ["web-retrieval"], unmetIds: [] },
      },
      {
        constraintId: "verification-anchor",
        kind: "verification" as const,
        enforcement: "hard" as const,
        source: { authority: "verification" as const },
        payload: { requiresVerificationAnchor: true },
      },
    ];
    const config: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: false,
      programmaticEnabled: true,
      bindings: [{ toolId: "web-retrieval", representations: { direct: { typed: true } } }],
    };
    const surface = deriveToolSurface({ ir, constraints, config, digest });
    // The honest mechanical decision: the transform step declared
    // filter work and programmatic execution is enabled.
    expect(surface.programmatic).toHaveLength(1);
    const decision = surface.programmatic[0];
    expect(decision?.reason).toBe("declared");
    expect(decision?.spec?.operation).toBe("filter");
    expect(auditToolSurface(surface, { ir, constraints, config, digest })).toEqual([]);

    // The seam over the REAL sandbox service (SQL store, real policy
    // admission, real capability gate, real ledger, real provider).
    const seam = createToolSurfaceComputeSeam({
      service: world.service,
      catalog: world.catalog,
      options: { environmentId, runnerCommand: process.execPath },
    });

    const spec = validateProgrammaticSpec({
      specId: "curate-filter",
      stepId: "curate",
      operation: "filter",
      params: { field: "status", equals: "ok" },
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
    });
    const items = [
      { status: "ok", n: 1 },
      { status: "bad", n: 2 },
      { status: "ok", n: 3 },
    ];

    // EXECUTE: one bounded programmatic run through the authority.
    const result = await runProgrammaticExecution(
      {
        spec,
        input: { items },
        scope: {
          executionId,
          environmentId,
          idempotencyKey: `prog-${executionId}-1`,
          actor: world.actor(),
        },
        surfaceId: surface.surfaceId,
        steps: ir.steps.map((step) => ({
          stepId: step.id,
          stepClass: step.stepClass,
          computationType: step.computationType,
          sideEffectClass: step.sideEffectClass,
        })),
      },
      seam,
      digest,
    );

    // The compact structured result: typed value, content-addressed
    // digest, EXACT provenance (real sandbox identity + output digest
    // + the surface it was derived through).
    expect(result.value).toEqual([
      { status: "ok", n: 1 },
      { status: "ok", n: 3 },
    ]);
    expect(result.provenance.sandboxId).not.toBeNull();
    expect(result.provenance.outputDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.provenance.surfaceId).toBe(surface.surfaceId);
    // The kernel equivalence: the value the sandbox process produced
    // is exactly the pure evaluator's value.
    const kernel = evaluateProgrammaticSpec(spec, { items });
    expect(result.value).toEqual(kernel.value as unknown);

    // THE DURABLE EVIDENCE over real PG: the terminal sandbox row and
    // the canonical ledger envelopes (admitted + completed).
    const rows = await world.service.listSandboxesByExecution(world.applicationId, executionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("completed");
    expect(rows[0]?.id).toBe(result.provenance.sandboxId);
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    const types = events.map((event) => event.type);
    expect(types).toContain("execution.sandbox-admitted");
    expect(types).toContain("execution.sandbox-completed");

    // THE RESULT ROUND-TRIP: the compact result survives a JSON
    // round-trip with the identical digest (the plan's result
    // contract holds over the durable shape).
    const roundTripped = validateCompactResult(JSON.parse(JSON.stringify(result)), digest);
    expect(roundTripped.resultDigest).toBe(result.resultDigest);

    // IDEMPOTENT RE-RUN: the same idempotency key replays the same
    // durable outcome (identical sandbox identity, no re-execution).
    const replay = await runProgrammaticExecution(
      {
        spec,
        input: { items },
        scope: {
          executionId,
          environmentId,
          idempotencyKey: `prog-${executionId}-1`,
          actor: world.actor(),
        },
        surfaceId: surface.surfaceId,
        steps: ir.steps.map((step) => ({
          stepId: step.id,
          stepClass: step.stepClass,
          computationType: step.computationType,
          sideEffectClass: step.sideEffectClass,
        })),
      },
      seam,
      digest,
    );
    expect(replay.resultDigest).toBe(result.resultDigest);
    expect(replay.provenance.sandboxId).toBe(result.provenance.sandboxId);
    expect(
      await world.service.listSandboxesByExecution(world.applicationId, executionId),
    ).toHaveLength(1);
  });

  test("CONCURRENCY: N=8 derivations converge; distinct-key runs produce distinct durable rows; same-key runs converge on ONE row", async () => {
    const world = await seedSandboxWorld(ctx.port);
    world.registerProvider(new ProcessSandboxProvider());
    const executionId = await world.seedExecution("RUNNING");
    const environmentId = await world.registerEnvironment("programmatic-runtime", {
      kind: "process",
      limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 30_000 },
      network: { egress: "none", allowedHosts: [] },
      filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
      secrets: { secretRefs: [] },
      runtime: { capabilityId: "process-sandbox" },
      cost: { estimatedCostMicroUsd: "0" },
    });

    const plan = buildPlan(
      {
        revision: 1,
        strategyClass: "hybrid",
        steps: [
          { id: "fetch", stepClass: "call-tool", capabilityId: "web-retrieval" },
          {
            id: "curate",
            stepClass: "transform",
            config: {
              programmatic: {
                specId: "curate-aggregate",
                stepId: "curate",
                operation: "aggregate",
                params: { metric: "sum", field: "n" },
                bounds: {
                  maxInputItems: 64,
                  maxIterations: 512,
                  maxOutputBytes: 8192,
                  wallClockMs: 5000,
                },
              },
            },
          },
        ],
        edges: [{ from: "fetch", to: "curate" }],
      },
      (value) => digest.sha256Hex(canonicalJson(value)),
    );
    const ir = deriveExecutionIr(planSource.toPlanSnapshot(plan), digest);
    const constraints = [
      {
        constraintId: "capability-satisfaction",
        kind: "capability" as const,
        enforcement: "hard" as const,
        source: { authority: "capability" as const, catalogRevision: "rev-1" },
        payload: { satisfiedIds: ["web-retrieval"], unmetIds: [] },
      },
    ];
    const config: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: false,
      programmaticEnabled: true,
      bindings: [{ toolId: "web-retrieval", representations: { direct: { typed: true } } }],
    };

    // N=8 SIMULTANEOUS pure derivations of the same real IR: every
    // chain computes the identical surface (identity convergence).
    const surfaces = await Promise.all(
      Array.from({ length: 8 }, () => deriveToolSurface({ ir, constraints, config, digest })),
    );
    expect(new Set(surfaces.map((surface) => surface.surfaceId)).size).toBe(1);
    expect(new Set(surfaces.map((surface) => JSON.stringify(surface))).size).toBe(1);
    const surface = surfaces[0] as (typeof surfaces)[number];

    const seam = createToolSurfaceComputeSeam({
      service: world.service,
      catalog: world.catalog,
      options: { environmentId, runnerCommand: process.execPath },
    });
    const spec = validateProgrammaticSpec({
      specId: "curate-aggregate",
      stepId: "curate",
      operation: "aggregate",
      params: { metric: "sum", field: "n" },
      bounds: { maxInputItems: 64, maxIterations: 512, maxOutputBytes: 8192, wallClockMs: 5000 },
    });
    const steps = ir.steps.map((step) => ({
      stepId: step.id,
      stepClass: step.stepClass,
      computationType: step.computationType,
      sideEffectClass: step.sideEffectClass,
    }));
    const items = { items: [{ n: 1 }, { n: 2 }, { n: 3.5 }] };

    // N=8 SIMULTANEOUS programmatic executions with DISTINCT keys:
    // eight distinct durable sandbox rows (all real process runs), the
    // IDENTICAL compact-result digest (the same input produces the
    // same typed value), zero torn rows.
    const distinctResults = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runProgrammaticExecution(
          {
            spec,
            input: items,
            scope: {
              executionId,
              environmentId,
              idempotencyKey: `prog-distinct-${index}`,
              actor: world.actor(),
            },
            surfaceId: surface.surfaceId,
            steps,
          },
          seam,
          digest,
        ),
      ),
    );
    expect(distinctResults).toHaveLength(8);
    expect(distinctResults.every((result) => result.value)).toEqual(true);
    for (const result of distinctResults) {
      expect(result.value).toEqual({ sum: 6.5 });
    }
    expect(new Set(distinctResults.map((result) => result.resultDigest)).size).toBe(1);
    expect(new Set(distinctResults.map((result) => result.provenance.sandboxId)).size).toBe(8);
    const distinctRows = await world.service.listSandboxesByExecution(
      world.applicationId,
      executionId,
    );
    expect(distinctRows).toHaveLength(8);
    expect(distinctRows.every((row) => row.status === "completed")).toBe(true);

    // N=8 SIMULTANEOUS programmatic executions with the SAME key: the
    // store's unique (application, execution, key) index serializes
    // the identity race; the one-shot dispatch discipline completes
    // exactly ONE durable row (the winner's outcome is the durable
    // truth; the losers fail closed or replay — never a torn or
    // duplicated durable effect).
    const actor = world.actor();
    const sameKeyRuns = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        runProgrammaticExecution(
          {
            spec,
            input: items,
            scope: {
              executionId,
              environmentId,
              idempotencyKey: `prog-same-key-${executionId}`,
              actor,
            },
            surfaceId: surface.surfaceId,
            steps,
          },
          seam,
          digest,
        ),
      ),
    );
    const resolved = sameKeyRuns
      .filter((run) => run.status === "fulfilled")
      .map((run) => run.value);
    expect(resolved.length).toBeGreaterThanOrEqual(1);
    // Every resolved run carries the identical outcome (the durable
    // row's truth — replay convergence).
    expect(new Set(resolved.map((result) => result.resultDigest)).size).toBe(1);
    expect(new Set(resolved.map((result) => result.provenance.sandboxId)).size).toBe(1);
    // The rejected runs are honest typed failures (the one-shot
    // dispatch discipline — never a silent success).
    for (const run of sameKeyRuns) {
      if (run.status === "rejected") {
        expect(run.reason).toBeInstanceOf(Error);
      }
    }
    // EXACTLY ONE durable row for the same key (plus the 8 distinct
    // rows from the previous block).
    const finalRows = await world.service.listSandboxesByExecution(
      world.applicationId,
      executionId,
    );
    expect(finalRows).toHaveLength(9);
    const sameKeyRows = finalRows.filter((row) => row.id === resolved[0]?.provenance.sandboxId);
    expect(sameKeyRows).toHaveLength(1);
    expect(sameKeyRows[0]?.status).toBe("completed");
  });
});
