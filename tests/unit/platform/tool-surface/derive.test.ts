/**
 * Tool-surface derivation unit tests (WORK-051): the pure derivation
 * engine over governed IRs — per-representation selection evidence,
 * capability/policy conditioning (read-only, fail-closed), the
 * programmatic-execution decisions, determinism/idempotence
 * (byte-identical re-derivation), total surface validation with
 * identity verification, minimality proofs, and the deterministic
 * provenance audit.
 */

import { describe, expect, test } from "vitest";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import { buildPlan } from "../../../../src/modules/planning/public";
import {
  validateExecutionIrVariant,
  variantFromIr,
} from "../../../../src/platform/execution-compiler/variant";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr } from "../../../../src/platform/execution-ir/ir";
import {
  SELECTION_ORDER,
  TOOL_REPRESENTATIONS,
  type ToolSurfaceConfig,
  ToolSurfaceError,
} from "../../../../src/platform/tool-surface/catalog";
import {
  assertSurfaceMinimal,
  auditToolSurface,
  deriveToolSurface,
  type ToolSurface,
  validateToolSurface,
} from "../../../../src/platform/tool-surface/derive";
import {
  allSevenConfig,
  cliConfig,
  digestValue,
  directConfig,
  governedIr,
  needsOf,
  nodeDigest,
  satisfiedConstraints,
} from "./world";

const planSource = createIrPlanSource();

function deriveExecutionIrOf(plan: ReturnType<typeof buildPlan>) {
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

/**
 * A deep-mutable structural view of a tool surface for tampering tests:
 * the validated type is readonly by construction; the JSON round-trip
 * produces exactly this shape, and mutations are cast onto it so the
 * validator's rejections can be proven (the readonly surface cannot be
 * mutated in-type, which is itself part of the invariant).
 */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer U)[]
    ? Mutable<U>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

function mutableCopy(surface: ToolSurface): Mutable<ToolSurface> {
  return JSON.parse(JSON.stringify(surface)) as Mutable<ToolSurface>;
}

/** The first binding of a mutable copy, guarded (the fixture always carries one). */
function firstBindingOf(copy: Mutable<ToolSurface>): Mutable<ToolSurface>["toolBindings"][number] {
  const binding = copy.toolBindings[0];
  if (binding === undefined) {
    throw new Error("fixture surface must carry a first binding");
  }
  return binding;
}

/** The first programmatic decision of a mutable copy, guarded. */
function firstDecisionOf(copy: Mutable<ToolSurface>): Mutable<ToolSurface>["programmatic"][number] {
  const decision = copy.programmatic[0];
  if (decision === undefined) {
    throw new Error("fixture surface must carry a first programmatic decision");
  }
  return decision;
}

describe("tool-surface derivation (WORK-051)", () => {
  test("the closed representation set is exactly ADR-0019 §5's seven", () => {
    expect([...TOOL_REPRESENTATIONS]).toHaveLength(7);
    expect([...TOOL_REPRESENTATIONS]).toEqual(
      expect.arrayContaining(["direct", "deferred", "cli", "script", "code", "mcp", "competence"]),
    );
    // The canonical selection order is a permutation of the set.
    expect([...SELECTION_ORDER]).toHaveLength(7);
    expect(new Set(SELECTION_ORDER)).toEqual(new Set(TOOL_REPRESENTATIONS));
    // The order is deterministic and starts at the lowest-rank triple.
    expect(SELECTION_ORDER[0]).toBe("direct");
    expect(SELECTION_ORDER[6]).toBe("deferred");
  });

  test("derives the minimal surface: one binding per declared need, direct preferred", () => {
    const ir = governedIr();
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    expect(surface.planId).toBe(ir.planId);
    expect(surface.irId).toBe(ir.irId);
    expect(surface.sourceVariantIrId).toBeNull();
    expect(surface.provenance.derivedFrom).toBe("execution-ir");
    expect(surface.toolBindings).toHaveLength(2);
    const fetch = surface.toolBindings.find((b) => b.toolId === "web-retrieval");
    const parse = surface.toolBindings.find((b) => b.toolId === "parsing");
    expect(fetch?.representation).toBe("direct");
    expect(fetch?.bindingRef).toBeNull();
    expect(fetch?.needId).toBe("fetch");
    expect(fetch?.selectionBasis).toContain("first-admissible-in-canonical-order");
    expect(parse?.representation).toBe("direct");
    // Every non-selected representation carries exactly one closed code.
    expect(fetch?.rejected.map((r) => `${r.representation}:${r.code}`)).toEqual([
      "competence:binding-absent",
      "code:binding-absent",
      "cli:lower-canonical-rank",
      "script:binding-absent",
      "mcp:binding-absent",
      "deferred:binding-absent",
    ]);
    expect(parse?.rejected.map((r) => `${r.representation}:${r.code}`)).toEqual([
      "competence:binding-absent",
      "code:binding-absent",
      "cli:binding-absent",
      "script:binding-absent",
      "mcp:mcp-adapter-disabled",
      "deferred:binding-absent",
    ]);
    // Minimality: the binding set IS the need set.
    expect(
      needsOf(ir)
        .map((n) => n.needId)
        .sort(),
    ).toEqual(surface.toolBindings.map((b) => b.needId).sort());
    assertSurfaceMinimal(surface, needsOf(ir), ir.steps);
  });

  test("per-representation selection: each of the seven wins under its configuration", () => {
    const ir = governedIr();
    const base = satisfiedConstraints();
    // CLI wins when direct is absent but cli is present.
    const cliSurface = deriveToolSurface({
      ir,
      constraints: base,
      config: cliConfig(),
      digest: nodeDigest,
    });
    expect(cliSurface.toolBindings.find((b) => b.toolId === "web-retrieval")?.representation).toBe(
      "cli",
    );
    expect(cliSurface.toolBindings.find((b) => b.toolId === "web-retrieval")?.bindingRef).toBe(
      "fetch-cli",
    );
    // With all seven materializable and MCP enabled, direct still wins
    // (lowest rank triple) — and every other representation records
    // lower-canonical-rank.
    const allSurface = deriveToolSurface({
      ir,
      constraints: base,
      config: allSevenConfig(),
      digest: nodeDigest,
    });
    const fetch = allSurface.toolBindings.find((b) => b.toolId === "web-retrieval");
    expect(fetch?.representation).toBe("direct");
    expect(fetch?.rejected.every((r) => r.code === "lower-canonical-rank")).toBe(true);
    // parsing has no direct binding: competence (next in order) wins.
    const parse = allSurface.toolBindings.find((b) => b.toolId === "parsing");
    expect(parse?.representation).toBe("competence");
    expect(parse?.bindingRef).toBe("parse-competence");

    // Competence wins when direct is absent (the all-seven parsing case
    // above); script/code/mcp/deferred win in isolation:
    const oneOf = (representations: Record<string, unknown>): ToolSurface =>
      deriveToolSurface({
        ir,
        constraints: base,
        config: {
          configSchema: 1,
          mcpEnabled: true,
          programmaticEnabled: true,
          bindings: [
            { toolId: "web-retrieval", representations: representations as never },
            { toolId: "parsing", representations: { script: { scriptRef: "parse-script" } } },
          ],
        },
        digest: nodeDigest,
      });
    expect(oneOf({ script: { scriptRef: "fetch-script" } }).toolBindings[0]?.representation).toBe(
      "script",
    );
    expect(oneOf({ code: { api: "fetch-api" } }).toolBindings[0]?.representation).toBe("code");
    expect(oneOf({ mcp: { server: "tools-mcp" } }).toolBindings[0]?.representation).toBe("mcp");
    expect(oneOf({ deferred: { discoverable: true } }).toolBindings[0]?.representation).toBe(
      "deferred",
    );
  });

  test("MCP is one representation among the closed set — never required (disabled adapter falls through)", () => {
    const ir = governedIr();
    // web-retrieval: mcp + cli; parsing: mcp + cli. With the adapter
    // DISABLED, mcp records its typed rejection and cli is selected —
    // the honest fall-through, never a silent MCP requirement.
    const config: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: false,
      programmaticEnabled: true,
      bindings: [
        {
          toolId: "web-retrieval",
          representations: { mcp: { server: "tools-mcp" }, cli: { command: "fetch-cli" } },
        },
        {
          toolId: "parsing",
          representations: { mcp: { server: "tools-mcp" }, cli: { command: "parse-cli" } },
        },
      ],
    };
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config,
      digest: nodeDigest,
    });
    expect(surface.toolBindings[0]?.representation).toBe("cli");
    expect(surface.toolBindings[0]?.rejected.find((r) => r.representation === "mcp")?.code).toBe(
      "mcp-adapter-disabled",
    );
    // parsing with ONLY an mcp binding and the adapter disabled → no
    // admissible representation → fail closed.
    const onlyMcp: ToolSurfaceConfig = {
      configSchema: 1,
      mcpEnabled: false,
      programmaticEnabled: true,
      bindings: [
        {
          toolId: "web-retrieval",
          representations: { cli: { command: "fetch-cli" } },
        },
        { toolId: "parsing", representations: { mcp: { server: "tools-mcp" } } },
      ],
    };
    try {
      deriveToolSurface({
        ir,
        constraints: satisfiedConstraints(),
        config: onlyMcp,
        digest: nodeDigest,
      });
      expect.unreachable("must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSurfaceError);
      expect((error as ToolSurfaceError).invariant).toBe("no-admissible-representation");
      expect((error as ToolSurfaceError).details.toolId).toBe("parsing");
    }
  });

  test("capability conditioning is read-only and fail-closed", () => {
    const ir = governedIr();
    // The capability facts say parsing is UNMET: the derivation fails
    // closed (never a silently dropped tool, never a widening).
    const unmet: OptimizationConstraint[] = [
      {
        constraintId: "capability-satisfaction",
        kind: "capability",
        enforcement: "hard",
        source: { authority: "capability", catalogRevision: "rev-1" },
        payload: {
          satisfiedIds: ["web-retrieval", "text-generation"],
          unmetIds: ["parsing"],
        },
      },
    ];
    try {
      deriveToolSurface({ ir, constraints: unmet, config: directConfig(), digest: nodeDigest });
      expect.unreachable("must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSurfaceError);
      expect((error as ToolSurfaceError).invariant).toBe("capability-condition");
      expect((error as ToolSurfaceError).details.toolId).toBe("parsing");
    }
    // No capability facts at all + existing needs: unprovenanced
    // conditioning → fail closed.
    expect(() =>
      deriveToolSurface({
        ir,
        constraints: [
          {
            constraintId: "policy-eligibility",
            kind: "policy",
            enforcement: "hard",
            source: { authority: "policy" },
            payload: { providerModel: { allowedProviders: ["rail-a"] } },
          },
        ],
        config: directConfig(),
        digest: nodeDigest,
      }),
    ).toThrow(ToolSurfaceError);
    // The constraint input is never mutated (read-only consultation).
    const before = JSON.stringify(satisfiedConstraints());
    deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    expect(JSON.stringify(satisfiedConstraints())).toBe(before);
  });

  test("policy conditioning denies restricted tools fail-closed (planner semantics)", () => {
    const ir = governedIr();
    const denied: OptimizationConstraint[] = [
      ...satisfiedConstraints().slice(0, 1),
      {
        constraintId: "policy-eligibility",
        kind: "policy",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: { tool: { deniedTools: ["parsing"] } },
      },
    ];
    try {
      deriveToolSurface({ ir, constraints: denied, config: directConfig(), digest: nodeDigest });
      expect.unreachable("must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolSurfaceError);
      expect((error as ToolSurfaceError).invariant).toBe("policy-condition");
    }
    // A non-empty allowlist excludes unlisted tools (the planner's own
    // composition semantics).
    const allowlist: OptimizationConstraint[] = [
      ...satisfiedConstraints().slice(0, 1),
      {
        constraintId: "policy-eligibility",
        kind: "policy",
        enforcement: "hard",
        source: { authority: "policy", policySetId: "ps-1" },
        payload: { tool: { allowedTools: ["web-retrieval"] } },
      },
    ];
    try {
      deriveToolSurface({ ir, constraints: allowlist, config: directConfig(), digest: nodeDigest });
      expect.unreachable("must fail closed");
    } catch (error) {
      expect((error as ToolSurfaceError).invariant).toBe("policy-condition");
      expect((error as ToolSurfaceError).details.toolId).toBe("parsing");
    }
  });

  test("derivation over a WORK-050 compiled variant preserves the source chain", () => {
    const ir = governedIr();
    const variant = validateExecutionIrVariant(variantFromIr(ir, nodeDigest), nodeDigest);
    const surface = deriveToolSurface({
      ir,
      variant,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    expect(surface.sourceVariantIrId).toBe(variant.variantIrId);
    expect(surface.provenance.derivedFrom).toBe("execution-compiler-variant");
    expect(surface.planId).toBe(ir.planId);
    // A variant whose source chain does NOT match the IR is rejected.
    const other = (() => {
      const plan = buildPlan(
        {
          revision: 1,
          strategyClass: "deterministic-only",
          steps: [{ id: "solo", stepClass: "transform" }],
          edges: [],
        },
        digestValue,
      );
      return deriveExecutionIrOf(plan);
    })();
    const otherVariant = validateExecutionIrVariant(variantFromIr(other, nodeDigest), nodeDigest);
    expect(() =>
      deriveToolSurface({
        ir,
        variant: otherVariant,
        constraints: satisfiedConstraints(),
        config: directConfig(),
        digest: nodeDigest,
      }),
    ).toThrow(ToolSurfaceError);
  });

  test("the programmatic-execution decisions are derived honestly", () => {
    const ir = governedIr();
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    // The plan declared filter work on `curate` (a transform step).
    expect(surface.programmatic).toHaveLength(1);
    const decision = surface.programmatic[0];
    expect(decision?.stepId).toBe("curate");
    expect(decision?.programmatic).toBe(true);
    expect(decision?.reason).toBe("declared");
    expect(decision?.spec?.operation).toBe("filter");
    expect(decision?.spec?.specId).toBe("curate-filter");
    // Disabled programmatic execution records the honest decision.
    const disabled = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: { ...directConfig(), programmaticEnabled: false },
      digest: nodeDigest,
    });
    expect(disabled.programmatic[0]?.reason).toBe("disabled");
    expect(disabled.programmatic[0]?.programmatic).toBe(false);
    expect(disabled.programmatic[0]?.spec).not.toBeNull();
  });

  test("determinism and idempotence: identical inputs → byte-identical surface", () => {
    const ir = governedIr();
    const first = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: allSevenConfig(),
      digest: nodeDigest,
    });
    const second = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: allSevenConfig(),
      digest: nodeDigest,
    });
    expect(second.surfaceId).toBe(first.surfaceId);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("validateToolSurface verifies shape and identity (tampering is unrepresentable)", () => {
    const ir = governedIr();
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    // Round-trip validation succeeds.
    const roundTripped = validateToolSurface(JSON.parse(JSON.stringify(surface)), nodeDigest);
    expect(roundTripped.surfaceId).toBe(surface.surfaceId);
    // Content tampering under a claimed identity fails.
    const tampered = mutableCopy(surface);
    firstBindingOf(tampered).representation = "mcp";
    expect(() => validateToolSurface(tampered, nodeDigest)).toThrow(ToolSurfaceError);
    const tamperedDigest = mutableCopy(surface);
    tamperedDigest.toolBindings.push({
      ...firstBindingOf(tamperedDigest),
      needId: "ghost",
      stepId: "ghost",
    });
    expect(() => validateToolSurface(tamperedDigest, nodeDigest)).toThrow(ToolSurfaceError);
    // The selected representation must not appear in its own rejected
    // list.
    const selfRejected = mutableCopy(surface);
    firstBindingOf(selfRejected).rejected = [{ representation: "direct", code: "binding-absent" }];
    expect(() => validateToolSurface(selfRejected, nodeDigest)).toThrow(ToolSurfaceError);
  });

  test("assertSurfaceMinimal rejects superset and subset surfaces", () => {
    const ir = governedIr();
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    const needs = needsOf(ir);
    // Superset: an extra binding beyond the declared needs.
    const superset = mutableCopy(surface);
    superset.toolBindings.push({
      ...firstBindingOf(superset),
      needId: "ghost",
      stepId: "ghost",
    });
    expect(() => assertSurfaceMinimal(superset, needs, ir.steps)).toThrow(ToolSurfaceError);
    // Subset: a dropped binding.
    const subset = mutableCopy(surface);
    subset.toolBindings = subset.toolBindings.slice(0, 1);
    expect(() => assertSurfaceMinimal(subset, needs, ir.steps)).toThrow(ToolSurfaceError);
    // A programmatic decision referencing an unknown step.
    const ghostStep = mutableCopy(surface);
    ghostStep.programmatic = [
      { ...firstDecisionOf(ghostStep), stepId: "ghost", stepClass: "transform" },
    ];
    expect(() => assertSurfaceMinimal(ghostStep, needs, ir.steps)).toThrow(ToolSurfaceError);
  });

  test("the deterministic audit: zero violations on a clean chain, typed violations on drift", () => {
    const ir = governedIr();
    const surface = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    });
    const input = {
      ir,
      constraints: satisfiedConstraints(),
      config: directConfig(),
      digest: nodeDigest,
    };
    expect(auditToolSurface(surface, input)).toEqual([]);
    // A drifted surface (re-derivation mismatch) is detected.
    const drifted = deriveToolSurface({
      ir,
      constraints: satisfiedConstraints(),
      config: cliConfig(),
      digest: nodeDigest,
    });
    const violations = auditToolSurface(drifted, input);
    expect(violations.map((v) => v.code)).toContain("derivation-mismatch");
    // An invalid surface value is reported, not thrown.
    expect(auditToolSurface({ nonsense: true }, input)[0]?.code).toBe("surface-invalid");
  });
});
