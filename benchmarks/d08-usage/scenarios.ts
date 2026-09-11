/**
 * benchmarks/d08-usage/scenarios.ts — the D-08 campaign's scenario classes.
 *
 * Every class is exercised through the REAL governed lifecycle: HTTP create
 * (SDK) → authorize → plan (+ planning-decision record where the class
 * exercises an economics plane) → queue → durable dispatch → REAL worker
 * claim → REAL process-sandbox execution → governed verify+pass/fail.
 *
 * HONEST MAPPINGS (recorded in the evidence document — the campaign never
 * claims a plane the composition does not actually exercise):
 *  - "model-routed" executes on the process substrate (no model credentials
 *    exist); the model-economics plane is exercised through the DURABLE
 *    planning-decision record (strategy class, route rationale, cost
 *    envelope) and the execution's cost/usage result reads.
 *  - "tool-surface" is programmatic execution through the process substrate
 *    (the E1.1 tool-surface compiler is a planner-internal surface).
 *  - "context-heavy" carries a 256 KiB payload through the real HTTP +
 *    durable-state path (the context-cache/reuse adapters are not wired
 *    into this composition root).
 *  - "verification-heavy" produces a 64 KiB digest-verified output (the
 *    multi-verifier orchestration surface is not wired here).
 *  - "competence-reuse" runs the same outcome twice; the second run records
 *    a competence-reuse planning decision citing the first run (the
 *    competence optimizer is a planner-internal surface).
 */

import type { CampaignWorld } from "../../deploy/usage-world";

export type ScenarioId =
  | "simple-deterministic"
  | "model-routed-decision"
  | "tool-surface-programmatic"
  | "context-heavy"
  | "failure-retry"
  | "failure-escalation"
  | "competence-reuse"
  | "budget-funded"
  | "budget-exhausted"
  | "policy-denied"
  | "verification-heavy"
  | "burst-load";

export type Plane =
  | "deterministic-execution"
  | "model-economics"
  | "tool-surface"
  | "context-economics"
  | "failure-recovery"
  | "failure-recovery+escalation"
  | "competence-economics"
  | "spend-ledger"
  | "spend-ledger+policy"
  | "policy-enforcement"
  | "verification"
  | "throughput";

export interface ScenarioTask {
  readonly kind: string;
  readonly sandbox: {
    readonly environmentId: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly publicEnv: Readonly<Record<string, string>>;
  };
  readonly input?: string;
  readonly constraints?: { readonly maxCostMicroUsd?: string };
}

export interface PlanningDecisionPayload {
  readonly strategyClass: string;
  readonly routeRationale: string;
  readonly selected: Readonly<Record<string, unknown>>;
  readonly consulted: Readonly<Record<string, unknown>>;
}

export interface ScenarioSpec {
  readonly id: ScenarioId;
  readonly plane: Plane;
  readonly description: string;
  /** The compute environment the task executes on. */
  readonly environment: "standard" | "retry" | "costed";
  buildTask(world: CampaignWorld, variant: number): ScenarioTask;
  /** The planning-decision record content (the economics-plane exercise). */
  decision?(world: CampaignWorld, variant: number): PlanningDecisionPayload;
  /** Expected terminal outcome of the primary execution. */
  readonly expect: "COMPLETED" | "FAILED" | "DENIED";
  /** Wall-clock bound for reaching the terminal state. */
  readonly timeoutMs: number;
}

const STANDARD_TASK = (
  world: CampaignWorld,
  kind: string,
  command: string,
  variant: number,
): ScenarioTask => ({
  kind,
  sandbox: {
    environmentId: world.standardEnvironmentId,
    command: "/bin/sh",
    args: ["-c", command],
    publicEnv: { SCENARIO: kind, VARIANT: String(variant) },
  },
});

export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    id: "simple-deterministic",
    plane: "deterministic-execution",
    description:
      "first-successful-execution journey: create → authorize → plan → queue → dispatch → worker claim → execute → verify → pass",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 60_000,
    buildTask: (world, variant) =>
      STANDARD_TASK(world, "d08-simple-deterministic", `echo deterministic-ok-${variant}`, variant),
  },
  {
    id: "model-routed-decision",
    plane: "model-economics",
    description:
      "probabilistic/model-routed selection recorded as a durable planning decision (strategy class, route rationale, cost envelope) before the governed execution",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 60_000,
    buildTask: (world, variant) =>
      STANDARD_TASK(world, "d08-model-routed", `echo model-route-${variant}`, variant),
    decision: (_world, variant) => ({
      strategyClass: "model-route",
      routeRationale: "cost-envelope-preference",
      selected: {
        routeId: `neutral-model-${(variant % 3) + 1}`,
        strategy: "sufficient-low-cost-model",
        estimatedCostMicroUsd: "120",
        effort: "low",
      },
      consulted: {
        candidates: [
          { routeId: "neutral-model-1", estimatedCostMicroUsd: "120" },
          { routeId: "neutral-model-2", estimatedCostMicroUsd: "340" },
          { routeId: "neutral-model-3", estimatedCostMicroUsd: "890" },
        ],
        sufficiency: "sufficient-low-cost-model",
      },
    }),
  },
  {
    id: "tool-surface-programmatic",
    plane: "tool-surface",
    description:
      "programmatic/tool-surface execution: deterministic compute resolved on the process substrate instead of a model call",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 60_000,
    buildTask: (world, variant) =>
      STANDARD_TASK(world, "d08-tool-surface", `expr ${variant + 6} \\* 7`, variant),
  },
  {
    id: "context-heavy",
    plane: "context-economics",
    description:
      "context-heavy execution: a 256 KiB context payload carried through the real HTTP create, durable state and ledger path",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 90_000,
    buildTask: (world, variant) => ({
      ...STANDARD_TASK(world, "d08-context-heavy", "wc -c", variant),
      input: `ctx-${variant}-`.repeat(23_860).slice(0, 262_144),
    }),
  },
  {
    id: "failure-retry",
    plane: "failure-recovery",
    description:
      "retryable failure (admitted-timeout class) on a short-bound compute environment: queue redelivery + bounded delivery attempts → terminal governed failure",
    environment: "retry",
    expect: "FAILED",
    timeoutMs: 120_000,
    buildTask: (world, variant) => ({
      kind: "d08-failure-retry",
      sandbox: {
        environmentId: world.retryEnvironmentId,
        command: "/bin/sh",
        args: ["-c", `sleep 2 && echo never-${variant}`],
        publicEnv: { SCENARIO: "failure-retry" },
      },
    }),
  },
  {
    id: "failure-escalation",
    plane: "failure-recovery+escalation",
    description:
      "permanent failure (exit≠0) then a FRESH escalated execution for the same outcome with an escalated-route planning decision that succeeds",
    environment: "standard",
    expect: "COMPLETED" as const,
    timeoutMs: 90_000,
    buildTask: (world, variant) => ({
      kind: "d08-failure-escalation",
      sandbox: {
        environmentId: world.standardEnvironmentId,
        command: "/bin/sh",
        args: ["-c", variant === 0 ? "exit 7" : "echo escalated-recovery"],
        publicEnv: { SCENARIO: "failure-escalation", ATTEMPT: String(variant) },
      },
    }),
    decision: (_world, variant) =>
      variant === 0
        ? {
            strategyClass: "model-route",
            routeRationale: "initial-route",
            selected: { routeId: "neutral-model-1", estimatedCostMicroUsd: "120" },
            consulted: {},
          }
        : {
            strategyClass: "escalated-route",
            routeRationale: "failure-escalation-fresh-execution",
            selected: {
              routeId: "neutral-model-3",
              strategy: "stronger-model",
              estimatedCostMicroUsd: "890",
              escalationOf: "prior-permanent-failure",
            },
            consulted: { failureClass: "sandbox-execution", exitCode: 7 },
          },
  },
  {
    id: "competence-reuse",
    plane: "competence-economics",
    description:
      "the same deterministic outcome executed twice: the second run records a competence-reuse planning decision citing the first run",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 60_000,
    buildTask: (world, variant) =>
      STANDARD_TASK(world, "d08-competence-reuse", `echo competence-${variant}`, variant),
    decision: (_world, variant) =>
      variant === 0
        ? {
            strategyClass: "programmatic-competence-acquisition",
            routeRationale: "first-execution-establishes-competence",
            selected: { strategy: "verified-competence", routeId: "process-substrate" },
            consulted: {},
          }
        : {
            strategyClass: "competence-reuse",
            routeRationale: "second-execution-reuses-established-competence",
            selected: {
              strategy: "reused-competence",
              routeId: "process-substrate",
              reuseOf: "run-1",
            },
            consulted: { reuse: true },
          },
  },
  {
    id: "budget-funded",
    plane: "spend-ledger",
    description:
      "costed compute environment with a funded developer wallet: real reserve → settle → release chain through the worker's sandbox admission seam",
    environment: "costed",
    expect: "COMPLETED",
    timeoutMs: 60_000,
    buildTask: (world, variant) => ({
      kind: "d08-budget-funded",
      sandbox: {
        environmentId: world.costedEnvironmentId,
        command: "/bin/sh",
        args: ["-c", `echo costed-ok-${variant}`],
        publicEnv: { SCENARIO: "budget-funded" },
      },
    }),
  },
  {
    id: "budget-exhausted",
    plane: "spend-ledger+policy",
    description:
      "concurrent costed executions against a bounded wallet: live reservations exceed the balance → governed BUDGET_EXCEEDED denials",
    environment: "costed",
    expect: "FAILED",
    timeoutMs: 90_000,
    buildTask: (world, variant) => ({
      kind: "d08-budget-exhausted",
      sandbox: {
        environmentId: world.costedEnvironmentId,
        command: "/bin/sh",
        args: ["-c", `sleep 2 && echo costed-${variant}`],
        publicEnv: { SCENARIO: "budget-exhausted" },
      },
    }),
  },
  {
    id: "policy-denied",
    plane: "policy-enforcement",
    description:
      "restrictive cost policy published (version 2); an execution declaring a higher cost ceiling is DENIED at the authorize seam (POLICY_DENIED)",
    environment: "standard",
    expect: "DENIED",
    timeoutMs: 30_000,
    buildTask: (world, _variant) => ({
      kind: "d08-policy-denied",
      sandbox: {
        environmentId: world.standardEnvironmentId,
        command: "/bin/sh",
        args: ["-c", "echo never-executed"],
        publicEnv: { SCENARIO: "policy-denied" },
      },
      constraints: { maxCostMicroUsd: "1000" },
    }),
  },
  {
    id: "verification-heavy",
    plane: "verification",
    description:
      "verification-heavy execution: a 64 KiB digest-verified output through the governed verify+pass completion binding",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 60_000,
    buildTask: (world, variant) =>
      STANDARD_TASK(world, "d08-verification-heavy", `head -c 65536 /dev/zero | base64`, variant),
  },
  {
    id: "burst-load",
    plane: "throughput",
    description:
      "concurrent burst load (the simple-deterministic task shape) at the campaign's target concurrency levels",
    environment: "standard",
    expect: "COMPLETED",
    timeoutMs: 90_000,
    buildTask: (world, variant) =>
      STANDARD_TASK(world, "d08-burst-load", `echo burst-${variant}`, variant),
  },
];
