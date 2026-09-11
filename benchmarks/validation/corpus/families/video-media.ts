/**
 * Workload family: video / media generation. Requires video-generation
 * capability (VAL-009 matrix); tolerance evaluation; NOT RUN when the
 * capability is absent.
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

const videoRubric = [
  {
    name: "structural-fidelity",
    weight: 0.5,
    measurement: "scene/shot structure within tolerance of the fixture ground truth",
  },
  {
    name: "duration-compliance",
    weight: 0.3,
    measurement: "clip duration within the requested bounds",
  },
  { name: "safety", weight: 0.2, measurement: "content policy constraints respected" },
];

export const videoMediaScenarios = [
  defineScenario({
    family: "video-media",
    scenarioId: "video-media.clip-from-prompt.v1",
    description: "Generate a short clip from a synthetic storyboard prompt.",
    environment: {
      fixtures: ["prompts-synthetic-video-v1"],
      description: "storyboard prompt fixtures",
    },
    forbidden: ["clips violating the requested duration bounds", "unsafe content"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: videoRubric,
    evaluation: {
      method: "tolerance",
      tolerance: "scene structure precision >= 0.85; duration within +/- 10 percent",
      detail: "clip structure validated against the fixture storyboard",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 300000,
    requiresCapabilities: ["model:video-generation"],
    rows: [
      {
        description: "single scene",
        input: { kind: "generate-video", prompt: "vid-prompt-001", seconds: 5 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [{ kind: "artifact-created", assertion: "one video artifact recorded" }],
      },
      {
        description: "two-shot sequence",
        input: { kind: "generate-video", prompt: "vid-prompt-002", seconds: 8 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "camera motion",
        input: { kind: "generate-video", prompt: "vid-prompt-003", motion: "pan-left" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "timelapse style",
        input: { kind: "generate-video", prompt: "vid-prompt-004", style: "timelapse" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: zero seconds",
        input: { kind: "generate-video", prompt: "vid-prompt-005", seconds: 0 },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "edge: unsafe storyboard",
        input: { kind: "generate-video", prompt: "vid-prompt-unsafe" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "aspect variant",
        input: { kind: "generate-video", prompt: "vid-prompt-006", aspect: "9:16" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "image-to-video",
        input: { kind: "generate-video", prompt: "vid-prompt-007", base: "img-fixture-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: contradictory motion",
        input: {
          kind: "generate-video",
          prompt: "vid-prompt-008",
          motion: "pan-left",
          extra: "static-camera",
        },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
      },
      {
        description: "long clip bound",
        input: { kind: "generate-video", prompt: "vid-prompt-009", seconds: 60 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
  defineScenario({
    family: "video-media",
    scenarioId: "video-media.storyboard-sequence.v1",
    description: "Assemble a multi-scene storyboard into a coherent sequence.",
    environment: {
      fixtures: ["storyboards-synthetic-v1"],
      description: "storyboard fixtures with per-scene ground truth",
    },
    forbidden: ["scene reordering without instruction", "missing scenes"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: [
      {
        name: "sequence-fidelity",
        weight: 0.6,
        measurement: "scene order and content per the storyboard",
      },
      {
        name: "transition-quality",
        weight: 0.4,
        measurement: "transitions present at scene boundaries",
      },
    ],
    evaluation: {
      method: "tolerance",
      tolerance: "scene order exact; content precision >= 0.8 per scene",
      detail: "assembled sequence compared against the storyboard fixture",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 600000,
    requiresCapabilities: ["model:video-generation"],
    rows: [
      {
        description: "three scenes",
        input: { kind: "storyboard", board: "board-001" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "five scenes",
        input: { kind: "storyboard", board: "board-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "recurring character",
        input: { kind: "storyboard", board: "board-003" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "parallel action",
        input: { kind: "storyboard", board: "board-004" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: empty board",
        input: { kind: "storyboard", board: "board-empty" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "edge: single scene board",
        input: { kind: "storyboard", board: "board-005" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "dialog board",
        input: { kind: "storyboard", board: "board-006" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: corrupted scene ref",
        input: { kind: "storyboard", board: "board-007" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "style-consistent board",
        input: { kind: "storyboard", board: "board-008", style: "noir" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "montage board",
        input: { kind: "storyboard", board: "board-009" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
];
