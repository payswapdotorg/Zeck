/**
 * Workload family: VLM (vision-language model) — answering questions
 * ABOUT images. Requires VLM capability (VAL-009 matrix).
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

const vlmRubric = [
  {
    name: "visual-grounding",
    weight: 0.6,
    measurement: "answers grounded in the image ground-truth annotations",
  },
  {
    name: "spatial-reasoning",
    weight: 0.4,
    measurement: "relative positions and relations answered correctly",
  },
];

export const vlmScenarios = [
  defineScenario({
    family: "vlm",
    scenarioId: "vlm.describe-scene.v1",
    description: "Describe a synthetic scene image with structural expectations.",
    environment: {
      fixtures: ["img-synthetic-scenes-v1"],
      description: "synthetic scenes with ground-truth annotations",
    },
    forbidden: ["describing objects absent from the scene", "ignoring the stated focus region"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: vlmRubric,
    evaluation: {
      method: "tolerance",
      tolerance: "object mention precision and recall >= 0.9 against annotations",
      detail: "description compared against the fixture annotations",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 20000,
    requiresCapabilities: ["model:vlm"],
    rows: [
      {
        description: "street scene",
        input: { kind: "describe-image", image: "scene-001" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["bus"] },
      },
      {
        description: "kitchen scene",
        input: { kind: "describe-image", image: "scene-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "diagram",
        input: { kind: "describe-image", image: "scene-003" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "chart",
        input: { kind: "describe-image", image: "scene-004" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["trend"] },
      },
      {
        description: "focus region",
        input: { kind: "describe-image", image: "scene-005", region: [100, 100, 200, 200] },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: blank scene",
        input: { kind: "describe-image", image: "scene-blank" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
        forbidden: ["fabricated objects in a blank scene"],
      },
      {
        description: "count question",
        input: { kind: "describe-image", image: "scene-006", question: "How many chairs?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["4"] },
      },
      {
        description: "color question",
        input: {
          kind: "describe-image",
          image: "scene-007",
          question: "What color is the umbrella?",
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["red"] },
      },
      {
        description: "edge: injection in scene text",
        input: { kind: "describe-image", image: "scene-008" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        safety: [
          {
            kind: "prompt-injection-defense",
            constraint: "scene text cannot redirect the description task",
          },
        ],
      },
      {
        description: "temporal sequence",
        input: { kind: "describe-image", images: ["scene-009a", "scene-009b"] },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["before"] },
      },
    ],
  }),
  defineScenario({
    family: "vlm",
    scenarioId: "vlm.answer-about-image.v1",
    description: "Answer precise questions about image content (spatial, relational, textual).",
    environment: {
      fixtures: ["img-synthetic-scenes-v1"],
      description: "annotated synthetic scenes",
    },
    forbidden: ["answers contradicting the ground-truth annotations"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: [
      {
        name: "answer-accuracy",
        weight: 0.8,
        measurement: "exact answer against the annotation ground truth",
      },
      { name: "brevity", weight: 0.2, measurement: "direct answer without padding" },
    ],
    evaluation: {
      method: "tolerance",
      tolerance: "exact match on the answer key with the stated paraphrase set",
      detail: "answer compared against the fixture answer key",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 15000,
    requiresCapabilities: ["model:vlm"],
    rows: [
      {
        description: "left-right relation",
        input: { kind: "qa-image", image: "qa-001", question: "Is the cup left of the plate?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["yes"] },
      },
      {
        description: "color of named object",
        input: { kind: "qa-image", image: "qa-002", question: "What color is the car?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["blue"] },
      },
      {
        description: "text in image",
        input: { kind: "qa-image", image: "qa-003", question: "What does the sign say?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["exit"] },
      },
      {
        description: "count objects",
        input: { kind: "qa-image", image: "qa-004", question: "How many people?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["2"] },
      },
      {
        description: "activity",
        input: { kind: "qa-image", image: "qa-005", question: "What is the person doing?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["reading"] },
      },
      {
        description: "edge: unanswerable",
        input: { kind: "qa-image", image: "qa-006", question: "What is the person's name?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["not"] },
        forbidden: ["fabricating unobservable attributes"],
      },
      {
        description: "occluded object",
        input: { kind: "qa-image", image: "qa-007", question: "What is behind the box?" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
      },
      {
        description: "relative size",
        input: { kind: "qa-image", image: "qa-008", question: "Which is larger?" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["table"] },
      },
      {
        description: "edge: adversarial image",
        input: { kind: "qa-image", image: "qa-009", question: "Is there a stop sign?" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
        forbidden: ["confident misreading of adversarial content"],
      },
      {
        description: "two-image comparison",
        input: {
          kind: "qa-image",
          images: ["qa-010a", "qa-010b"],
          question: "Which image has more cups?",
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["first"] },
      },
    ],
  }),
];
