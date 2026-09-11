/**
 * Workload family: audio understanding (event classification,
 * speaker diarization). Requires audio capability (VAL-009 matrix).
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

export const audioUnderstandingScenarios = [
  defineScenario({
    family: "audio-understanding",
    scenarioId: "audio-understanding.classify-event.v1",
    description: "Classify synthetic audio events against a fixed vocabulary.",
    environment: {
      fixtures: ["audio-synthetic-events-v1"],
      description: "synthetic event clips with ground-truth labels",
    },
    forbidden: ["labels outside the event vocabulary"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: [
      { name: "event-accuracy", weight: 0.7, measurement: "ground-truth event matched" },
      {
        name: "onset-detection",
        weight: 0.3,
        measurement: "event boundaries within the stated tolerance",
      },
    ],
    evaluation: {
      method: "tolerance",
      tolerance: "event accuracy >= 0.9; onset within +/- 150ms",
      detail: "predicted events compared against fixture ground truth",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 10000,
    requiresCapabilities: ["model:audio-understanding"],
    rows: [
      {
        description: "doorbell",
        input: {
          kind: "classify-audio",
          clip: "event-001",
          labels: ["doorbell", "alarm", "music"],
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["doorbell"] },
      },
      {
        description: "alarm",
        input: {
          kind: "classify-audio",
          clip: "event-002",
          labels: ["doorbell", "alarm", "music"],
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["alarm"] },
      },
      {
        description: "overlapping events",
        input: {
          kind: "classify-audio",
          clip: "event-003",
          labels: ["doorbell", "alarm", "music"],
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "quiet clip",
        input: {
          kind: "classify-audio",
          clip: "event-004",
          labels: ["doorbell", "alarm", "music"],
        },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
        forbidden: ["confident labels on silence"],
      },
      {
        description: "edge: corrupted clip",
        input: { kind: "classify-audio", clip: "audio-corrupt", labels: ["x"] },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "onset timing",
        input: { kind: "classify-audio", clip: "event-005", onset: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "count events",
        input: { kind: "classify-audio", clip: "event-006", count: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["3"] },
      },
      {
        description: "edge: out-of-vocabulary sound",
        input: {
          kind: "classify-audio",
          clip: "event-007",
          labels: ["doorbell", "alarm", "music"],
        },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
        forbidden: ["forcing an out-of-vocabulary sound into a label"],
      },
      {
        description: "far-field recording",
        input: {
          kind: "classify-audio",
          clip: "event-008",
          labels: ["doorbell", "alarm", "music"],
        },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "music genre",
        input: { kind: "classify-audio", clip: "event-009", labels: ["classical", "jazz", "rock"] },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["jazz"] },
      },
    ],
  }),
  defineScenario({
    family: "audio-understanding",
    scenarioId: "audio-understanding.speaker-diarization.v1",
    description: "Segment a synthetic conversation by speaker with ground truth turns.",
    environment: {
      fixtures: ["audio-synthetic-conversations-v1"],
      description: "synthetic conversations with ground-truth diarization",
    },
    forbidden: ["assigning a ground-truth turn to the wrong speaker"],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: [
      { name: "speaker-accuracy", weight: 0.6, measurement: "turn-to-speaker assignment accuracy" },
      { name: "boundary-accuracy", weight: 0.4, measurement: "turn boundaries within tolerance" },
    ],
    evaluation: {
      method: "tolerance",
      tolerance: "speaker accuracy >= 0.95; boundaries within +/- 250ms",
      detail: "diarization compared against fixture ground truth",
    },
    determinism: "nondeterministic-tolerance",
    latencyTargetMs: 20000,
    requiresCapabilities: ["model:audio-understanding"],
    rows: [
      {
        description: "two speakers",
        input: { kind: "diarize", clip: "dialog-001" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "three speakers",
        input: { kind: "diarize", clip: "dialog-002" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "overlapping speech",
        input: { kind: "diarize", clip: "dialog-003" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "single speaker",
        input: { kind: "diarize", clip: "dialog-004" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "short turns",
        input: { kind: "diarize", clip: "dialog-005" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: silence regions",
        input: { kind: "diarize", clip: "dialog-006" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: corrupted clip",
        input: { kind: "diarize", clip: "dialog-corrupt" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
      },
      {
        description: "speaker count query",
        input: { kind: "diarize", clip: "dialog-007", count: true },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["2"] },
      },
      {
        description: "same-voice disguise",
        input: { kind: "diarize", clip: "dialog-008" },
        expected: { terminalStatus: "COMPLETED", verification: "INCONCLUSIVE" },
      },
      {
        description: "long meeting",
        input: { kind: "diarize", clip: "dialog-009" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
];
