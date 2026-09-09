/**
 * Shared fixtures for the tool-surface unit suites (WORK-051): governed
 * plan IRs with declared tool needs and mechanical declarations, the
 * governing constraint sets (capability + policy mirrors), and
 * tool-surface configurations covering all seven representations.
 */

import { canonicalJson } from "../../../../src/platform/execution-ir/canonical";
import type { OptimizationConstraint } from "../../../../src/platform/execution-ir/constraints";
import { deriveExecutionIr, type ExecutionIr } from "../../../../src/platform/execution-ir/ir";
import { buildPlan, createNodeDigest } from "../../../../src/modules/planning/public";
import { createIrPlanSource } from "../../../../src/modules/planning/adapters/ir-plan-source";
import type { ToolSurfaceConfig } from "../../../../src/platform/tool-surface/catalog";
import { extractToolNeeds, type ToolNeed } from "../../../../src/platform/tool-surface/needs";

export const nodeDigest = createNodeDigest();
export const digestValue = (value: unknown): string => nodeDigest.sha256Hex(canonicalJson(value));
const planSource = createIrPlanSource();

/** A governed plan with two tool needs and one mechanical declaration. */
export function governedIr(): ExecutionIr {
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
        {
          id: "gen",
          stepClass: "call-model",
          capabilityId: "text-generation",
          routeRef: { provider: "rail-a", model: "model-x" },
        },
        { id: "check", stepClass: "verify", verificationStrategy: "schema-check" },
      ],
      edges: [
        { from: "fetch", to: "curate" },
        { from: "curate", to: "parse" },
        { from: "parse", to: "gen" },
        { from: "gen", to: "check" },
      ],
    },
    digestValue,
  );
  return deriveExecutionIr(planSource.toPlanSnapshot(plan), nodeDigest);
}

/** The capability conditioning facts: both tool capabilities satisfied. */
export function satisfiedConstraints(): OptimizationConstraint[] {
  return [
    {
      constraintId: "capability-satisfaction",
      kind: "capability",
      enforcement: "hard",
      source: { authority: "capability", catalogRevision: "rev-1" },
      payload: {
        satisfiedIds: ["web-retrieval", "parsing", "text-generation"],
        unmetIds: [],
      },
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

/** A config where every need's tool has a direct + cli binding. */
export function directConfig(): ToolSurfaceConfig {
  return {
    configSchema: 1,
    mcpEnabled: false,
    programmaticEnabled: true,
    bindings: [
      {
        toolId: "web-retrieval",
        representations: { direct: { typed: true }, cli: { command: "fetch-cli" } },
      },
      {
        toolId: "parsing",
        representations: { direct: { typed: true }, mcp: { server: "tools-mcp" } },
      },
    ],
  };
}

/** A config where only CLI/deferred are materializable for one tool. */
export function cliConfig(): ToolSurfaceConfig {
  return {
    configSchema: 1,
    mcpEnabled: false,
    programmaticEnabled: true,
    bindings: [
      {
        toolId: "web-retrieval",
        representations: { cli: { command: "fetch-cli" }, deferred: { discoverable: true } },
      },
      {
        toolId: "parsing",
        representations: { cli: { command: "parse-cli" } },
      },
    ],
  };
}

/** A config covering ALL SEVEN representations across the two tools. */
export function allSevenConfig(): ToolSurfaceConfig {
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
          script: { scriptRef: "parse-script" },
          code: { api: "parse-api" },
          mcp: { server: "tools-mcp" },
          competence: { competenceRef: "parse-competence" },
          deferred: { discoverable: true },
        },
      },
    ],
  };
}

/** Extract needs from an IR (the pure extraction under test). */
export function needsOf(ir: ExecutionIr): readonly ToolNeed[] {
  return extractToolNeeds(ir.steps);
}
