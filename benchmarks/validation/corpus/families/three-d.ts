/**
 * Workload family: 3D generation / rendering. Requires 3D capability
 * (VAL-009 matrix); geometric tolerances.
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

export const threeDScenarios = [
  defineScenario({
    family: "three-d",
    scenarioId: "three-d.render-scene.v1",
    description: "Render a synthetic scene description into a 3D artifact with geometric checks.",
    environment: {
      fixtures: ["scenes-synthetic-3d-v1"],
      description: "scene specs with geometric ground truth",
    },
    forbidden: [
      "artifacts violating the scene's geometric constraints",
      "missing declared objects",
    ],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: [
      {
        name: "geometric-fidelity",
        weight: 0.6,
        measurement: "declared geometry present within tolerance",
      },
      { name: "material-compliance", weight: 0.4, measurement: "materials match the scene spec" },
    ],
    evaluation: {
      method: "tolerance",
      tolerance: "object presence exact; dimension error <= 5 percent",
      detail: "rendered artifact parsed and compared against the scene spec",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 120000,
    requiresCapabilities: ["model:three-d"],
    rows: [
      {
        description: "single primitive",
        input: { kind: "render-3d", scene: "scene3d-001" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [{ kind: "artifact-created", assertion: "one 3d artifact recorded" }],
      },
      {
        description: "two primitives with relation",
        input: { kind: "render-3d", scene: "scene3d-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "textured object",
        input: { kind: "render-3d", scene: "scene3d-003" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "lit scene",
        input: { kind: "render-3d", scene: "scene3d-004" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "camera viewpoint",
        input: { kind: "render-3d", scene: "scene3d-005", camera: "top" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: empty scene",
        input: { kind: "render-3d", scene: "scene3d-empty" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "edge: impossible geometry",
        input: { kind: "render-3d", scene: "scene3d-006" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
      },
      {
        description: "edge: corrupted spec",
        input: { kind: "render-3d", scene: "scene3d-corrupt" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "animation frames",
        input: { kind: "render-3d", scene: "scene3d-007", frames: 24 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: injection in scene text",
        input: { kind: "render-3d", scene: "scene3d-008" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        safety: [
          {
            kind: "prompt-injection-defense",
            constraint: "scene description text cannot override the renderer policy",
          },
        ],
      },
    ],
  }),
  defineScenario({
    family: "three-d",
    scenarioId: "three-d.mesh-from-spec.v1",
    description: "Generate a valid mesh from a parametric spec (deterministic topology checks).",
    environment: {
      fixtures: ["specs-synthetic-mesh-v1"],
      description: "parametric mesh specifications",
    },
    forbidden: ["non-manifold output meshes", "vertex count drift beyond tolerance"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: [
      { name: "topology-validity", weight: 0.6, measurement: "manifold, watertight mesh" },
      { name: "spec-fidelity", weight: 0.4, measurement: "dimensions and counts match the spec" },
    ],
    evaluation: {
      method: "tolerance",
      tolerance: "topology exact; vertex count within +/- 2 percent",
      detail: "mesh parsed and validated against the spec",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 120000,
    requiresCapabilities: ["model:three-d"],
    rows: [
      {
        description: "box spec",
        input: { kind: "mesh-from-spec", spec: "mesh-001" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "sphere spec",
        input: { kind: "mesh-from-spec", spec: "mesh-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "cylinder spec",
        input: { kind: "mesh-from-spec", spec: "mesh-003" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "composite spec",
        input: { kind: "mesh-from-spec", spec: "mesh-004" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: negative dimension",
        input: { kind: "mesh-from-spec", spec: "mesh-005" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "edge: zero resolution",
        input: { kind: "mesh-from-spec", spec: "mesh-006" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "high resolution",
        input: { kind: "mesh-from-spec", spec: "mesh-007" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: unknown primitive",
        input: { kind: "mesh-from-spec", spec: "mesh-008" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        forbidden: ["silently substituting a different primitive"],
      },
      {
        description: "unit-normalized",
        input: { kind: "mesh-from-spec", spec: "mesh-009" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: corrupted spec",
        input: { kind: "mesh-from-spec", spec: "mesh-corrupt" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
    ],
  }),
];
