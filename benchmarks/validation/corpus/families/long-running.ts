/**
 * Workload family: long-running / resumable executions — checkpoint,
 * resume, lease and progress semantics as durable environment effects.
 */

import { defineScenario, NO_PROVIDER_SELECTION, NO_SECRET_FLOW } from "../scenario";

const longRunningRubric = [
  {
    name: "resumability",
    weight: 0.5,
    measurement: "an interrupted run resumes without redoing committed work",
  },
  {
    name: "progress-durability",
    weight: 0.3,
    measurement: "checkpoints recorded at the mandated boundaries",
  },
  {
    name: "termination",
    weight: 0.2,
    measurement: "reaches a terminal state within the latency target",
  },
];

export const longRunningScenarios = [
  defineScenario({
    family: "long-running",
    scenarioId: "long-running.checkpoint-resume.v1",
    description:
      "Interrupt a long batch at a checkpoint; the resumed run continues from the checkpoint exactly.",
    environment: {
      fixtures: ["batch-jobs-synthetic-v1"],
      description: "synthetic batch job definitions",
    },
    forbidden: ["redoing committed work after resume", "losing progress on interruption"],
    safety: [
      NO_PROVIDER_SELECTION,
      NO_SECRET_FLOW,
      {
        kind: "side-effect",
        constraint: "each batch item's effect applies exactly once (idempotent resume)",
      },
    ],
    rubric: longRunningRubric,
    evaluation: {
      method: "deterministic",
      detail: "checkpoint sequence and per-item effect counts compared exactly",
    },
    determinism: "deterministic",
    latencyTargetMs: 120000,
    rows: [
      {
        description: "interrupt at first checkpoint",
        input: { kind: "long-run", job: "job-001", interrupt: "after-checkpoint-1" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [{ kind: "state-transitioned", assertion: "resume continues from checkpoint-1" }],
      },
      {
        description: "interrupt mid-item",
        input: { kind: "long-run", job: "job-002", interrupt: "mid-item-3" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [
          {
            kind: "side-effect-count",
            assertion: "item 3's effect applied exactly once across the interruption",
          },
        ],
      },
      {
        description: "double interruption",
        input: { kind: "long-run", job: "job-003", interrupt: "twice" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "interrupt at final checkpoint",
        input: { kind: "long-run", job: "job-004", interrupt: "before-final" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: corrupted checkpoint",
        input: { kind: "long-run", job: "job-005", interrupt: "corrupt-checkpoint" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        forbidden: ["trusting a corrupted checkpoint without validation"],
      },
      {
        description: "edge: stale worker takeover",
        input: { kind: "long-run", job: "job-006", interrupt: "stale-worker" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [
          {
            kind: "state-transitioned",
            assertion: "the stale worker's retry fails closed; the successor completes",
          },
        ],
      },
      {
        description: "no-op resume after completion",
        input: { kind: "long-run", job: "job-007", resume: "after-terminal" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["replayed"] },
      },
      {
        description: "lease expiry during interruption",
        input: { kind: "long-run", job: "job-008", interrupt: "lease-expiry" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: concurrent resume attempts",
        input: { kind: "long-run", job: "job-009", resume: "concurrent" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [
          {
            kind: "side-effect-count",
            assertion: "exactly one resumption wins; others typed-conflict",
          },
        ],
      },
      {
        description: "progress reporting",
        input: { kind: "long-run", job: "job-010" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [
          { kind: "artifact-created", assertion: "progress events recorded on the ledger" },
        ],
      },
    ],
  }),
  defineScenario({
    family: "long-running",
    scenarioId: "long-running.overnight-batch.v1",
    description: "Sustained batch execution with bounded failure tolerance.",
    environment: {
      fixtures: ["batch-jobs-synthetic-v1"],
      description: "large synthetic batch sets with seeded failures",
    },
    forbidden: [
      "a single item failure aborting the whole batch without a decision",
      "fabricated success for failed items",
    ],
    safety: [NO_PROVIDER_SELECTION, NO_SECRET_FLOW],
    rubric: longRunningRubric,
    evaluation: {
      method: "deterministic",
      detail: "per-item outcomes compared against the seeded ground truth",
    },
    determinism: "deterministic",
    latencyTargetMs: 600000,
    rows: [
      {
        description: "clean batch",
        input: { kind: "batch", job: "batch-clean-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "one seeded failure",
        input: { kind: "batch", job: "batch-one-fail-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["1"] },
        forbidden: ["retrying a permanently failed item forever"],
      },
      {
        description: "throttled batch",
        input: { kind: "batch", job: "batch-throttled-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "partial checkpoint review",
        input: { kind: "batch", job: "batch-partial-review-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: poison item",
        input: { kind: "batch", job: "batch-poison-100" },
        expected: {
          terminalStatus: "COMPLETED",
          verification: "PASS",
          containsText: ["quarantined"],
        },
        forbidden: ["the poison item blocking the remaining batch"],
      },
      {
        description: "edge: budget exhaustion mid-batch",
        input: { kind: "batch", job: "batch-budget-exhaust-100" },
        expected: { terminalStatus: "FAILED", verification: "FAIL" },
        safety: [{ kind: "side-effect", constraint: "no further spend after budget exhaustion" }],
      },
      {
        description: "ordered batch",
        input: { kind: "batch", job: "batch-ordered-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
        effects: [{ kind: "state-transitioned", assertion: "items apply in the mandated order" }],
      },
      {
        description: "resumed batch",
        input: { kind: "batch", job: "batch-resume-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
      {
        description: "edge: duplicate batch submission",
        input: { kind: "batch", job: "batch-clean-100" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS", containsText: ["replayed"] },
      },
      {
        description: "large batch",
        input: { kind: "batch", job: "batch-large-1000" },
        expected: { terminalStatus: "COMPLETED", verification: "PASS" },
      },
    ],
  }),
];
