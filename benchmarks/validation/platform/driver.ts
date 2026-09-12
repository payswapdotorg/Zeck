/**
 * The platform-side execution driver (VAL-010).
 *
 * Plays Zeck's operators/runtime for a customer-submitted execution:
 * drives the canonical lifecycle (authorize → plan → planning-decision →
 * queue → start → verify → pass/fail) while dispatching the REAL model
 * request through an injected dispatch port (the REAL model gateway in
 * production bindings; a controlled fake in unit tests) and completing
 * the execution with mechanically derived verification criteria.
 *
 * The driver itself is neutral, network-free and Zeck-internal-free:
 * every platform surface (lifecycle transitions, planning-decision
 * recording, dispatch) is an injected PORT. The integration seam binds
 * the REAL executions service, the REAL model gateway and the REAL rail
 * adapter; unit tests bind fakes.
 *
 * Honesty invariants (by construction):
 *   * a provider-failure outcome FAILS the execution (never completes it);
 *   * a pass requires at least one PASS criterion and zero FAIL criteria;
 *   * dispatch timing and usage are measured, never estimated;
 *   * the planning decision is recorded BEFORE the dispatch (durable
 *     intent precedes external effect — the platform's own sequence).
 */

import {
  deriveDispatchPlan,
  deriveVerification,
  type LabDispatchOutcome,
  type LabRoute,
  type LabUsage,
  type LabVerificationCriterion,
  type Val010Task,
} from "./derive";

/** Neutral lifecycle port (bound to the REAL execution service). */
export interface PlatformLifecyclePort {
  /** One canonical transition command (authorize/plan/queue/start/verify). */
  transition(command: {
    readonly executionId: string;
    readonly step: "authorize" | "plan" | "queue" | "start" | "verify";
    readonly reason: string;
  }): Promise<void>;
  /** Durable planning decision (route facts) — before the dispatch. */
  recordPlanningDecision(input: {
    readonly executionId: string;
    readonly route: LabRoute;
  }): Promise<void>;
  /** Terminal completion with the mechanically derived criteria. */
  complete(input: {
    readonly executionId: string;
    readonly verdict: "pass" | "fail";
    readonly criteria: readonly LabVerificationCriterion[];
    readonly reason: string;
  }): Promise<void>;
}

/** Neutral dispatch port (bound to the REAL model gateway). */
export interface PlatformDispatchPort {
  dispatch(input: {
    readonly executionId: string;
    readonly task: Val010Task;
    readonly provider: string;
    readonly model: string;
  }): Promise<LabDispatchOutcome>;
}

export interface PlatformRunPorts {
  readonly lifecycle: PlatformLifecyclePort;
  /** The dispatch FUNCTION (the PlatformDispatchPort binding's method). */
  readonly dispatch: PlatformDispatchPort["dispatch"];
  readonly now: () => Date;
}

export interface PlatformRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  readonly dispatchLatencyMs: number | null;
}

/**
 * Drive one submitted execution to completion through the platform path.
 * The fixture absence and provider failure paths fail honestly (NOT RUN
 * is signaled by the thrown FixtureNotMaterializedError BEFORE any
 * lifecycle mutation; a provider failure completes as FAILED).
 */
export async function driveExecutionToCompletion(options: {
  readonly executionId: string;
  readonly task: Val010Task;
  readonly provider: string;
  readonly model: string;
  /**
   * The corpus row's own expected outcome (containsText terms) — oracle
   * truth from the corpus, passed by the platform binding.
   */
  readonly expectations?: { readonly containsText?: readonly string[] };
  readonly ports: PlatformRunPorts;
}): Promise<PlatformRunResult> {
  const { executionId, task, provider, model, ports } = options;

  // 1. The dispatch plan is derived BEFORE any lifecycle mutation: an
  //    absent fixture aborts here (NOT RUN — nothing was driven).
  const plan = deriveDispatchPlan(task, { provider, model });

  // 2. Canonical lifecycle up to RUNNING.
  await ports.lifecycle.transition({ executionId, step: "authorize", reason: "val-010-authorize" });
  await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-010-plan" });
  // 3. Durable planning decision (route facts) while in the planning
  //    phase — intent before effect.
  await ports.lifecycle.recordPlanningDecision({ executionId, route: plan.route });
  await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-010-queue" });
  await ports.lifecycle.transition({ executionId, step: "start", reason: "val-010-start" });

  // 4. The REAL dispatch through the injected port (measured).
  const dispatchStartedAt = ports.now();
  const outcome = await ports.dispatch({ executionId, task, provider, model });
  const dispatchLatencyMs = ports.now().getTime() - dispatchStartedAt.getTime();

  // 5. Mechanical verification derivation (oracle floor: a provider
  //    failure fails ANY run; a failed oracle fails the execution).
  const criteria = deriveVerification(task, outcome, options.expectations);
  const anyFail = criteria.some((criterion) => criterion.status === "FAIL");
  const verdict: "pass" | "fail" = anyFail ? "fail" : "pass";

  await ports.lifecycle.transition({ executionId, step: "verify", reason: "val-010-verify" });
  await ports.lifecycle.complete({
    executionId,
    verdict,
    criteria,
    reason: anyFail ? "val-010-mechanical-verification-failed" : "val-010-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    usage: outcome.kind === "success" ? (outcome.usage ?? null) : null,
    dispatchLatencyMs,
  };
}
