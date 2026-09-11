/**
 * Workload family: realtime voice conversations — streaming turns,
 * barge-in and latency tolerances. Requires realtime-voice capability
 * (VAL-009 matrix; absent access = NOT RUN, never a silent pass).
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

const rtRubric = [
  {
    name: "turn-accuracy",
    weight: 0.5,
    measurement: "response addresses the spoken turn within tolerance",
  },
  {
    name: "stream-latency",
    weight: 0.3,
    measurement: "first audio token within the stated latency band",
  },
  { name: "barge-in-respect", weight: 0.2, measurement: "the stream yields when interrupted" },
];

export const realtimeVoiceScenarios = [
  defineScenario({
    family: "realtime-voice",
    scenarioId: "realtime-voice.dialog-turn.v1",
    description: "Respond to a streamed spoken turn with a streamed spoken answer.",
    environment: {
      fixtures: ["audio-synthetic-dialog-v1"],
      description: "synthetic dialog turn streams with ground truth",
    },
    forbidden: ["responding to a turn that was not spoken", "dropping the conversation context"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: rtRubric,
    evaluation: {
      method: "tolerance",
      tolerance: "turn-level WER <= 0.08; first-token latency <= 700ms",
      detail: "streamed turn compared against ground truth",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 5000,
    requiresCapabilities: ["model:realtime-voice"],
    rows: [
      {
        description: "greeting turn",
        input: { kind: "rt-dialog", session: "rt-001", turn: 1 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "question turn",
        input: { kind: "rt-dialog", session: "rt-001", turn: 2 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "correction turn",
        input: { kind: "rt-dialog", session: "rt-002", turn: 1 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "context recall turn",
        input: { kind: "rt-dialog", session: "rt-002", turn: 4 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: silent turn",
        input: { kind: "rt-dialog", session: "rt-003", turn: 1 },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        forbidden: ["fabricating a response to silence"],
      },
      {
        description: "edge: injected turn instruction",
        input: { kind: "rt-dialog", session: "rt-004", turn: 2 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        safety: [
          {
            kind: "prompt-injection-defense",
            constraint: "spoken content cannot change the session policy",
          },
        ],
      },
      {
        description: "long turn",
        input: { kind: "rt-dialog", session: "rt-005", turn: 1 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "numeric answer turn",
        input: { kind: "rt-dialog", session: "rt-005", turn: 3 },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["42"] },
      },
      {
        description: "multi-language session",
        input: { kind: "rt-dialog", session: "rt-006", turn: 2 },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
      },
      {
        description: "session termination",
        input: { kind: "rt-dialog", session: "rt-006", end: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
  defineScenario({
    family: "realtime-voice",
    scenarioId: "realtime-voice.barge-in.v1",
    description: "The assistant yields when the user interrupts mid-response.",
    environment: {
      fixtures: ["audio-synthetic-dialog-v1"],
      description: "dialog streams with scripted interruptions",
    },
    forbidden: [
      "continuing to speak over the user after barge-in",
      "losing pre-interruption context",
    ],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: rtRubric,
    evaluation: {
      method: "tolerance",
      tolerance: "yield within 300ms of the interruption marker",
      detail: "interruption timeline compared against the script",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 5000,
    requiresCapabilities: ["model:realtime-voice"],
    rows: [
      {
        description: "early interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-001", at: "25%" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "mid interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-001", at: "50%" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "late interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-002", at: "90%" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "double interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-003", at: "30%,70%" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "context after interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-003", recall: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: false interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-004", at: "cough" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        forbidden: ["yielding to non-speech interruptions"],
      },
      {
        description: "interruption during question",
        input: { kind: "rt-barge-in", session: "rt-bi-005", at: "40%" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "restart after interruption",
        input: { kind: "rt-barge-in", session: "rt-bi-006", at: "50%", restart: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: interruption storm",
        input: { kind: "rt-barge-in", session: "rt-bi-007", at: "10%,30%,60%,80%" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
      },
      {
        description: "turn handover final",
        input: { kind: "rt-barge-in", session: "rt-bi-007", final: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
];
