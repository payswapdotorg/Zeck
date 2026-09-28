/**
 * The pinned-application runtime ports (PPR-018A scope item 1; the
 * ACR-007 §3 thin-integration invariant, applied to the runtime).
 *
 * THE DIVISION OF AUTHORITY (binding):
 *  - the APPLICATION WORK ORDER (PPR-018..027) implements
 *    `PinnedRuntimeDriver`: it owns starting ONE exact application
 *    revision plus ONE exact Zeck integration revision, composing the
 *    application runtime, its Zeck-boundary adapter and its certified
 *    proof environment (the scrubbed env + the egress control are the
 *    harness's reusable pieces — compat/harness — composed BY the
 *    driver, never imposed on its internals);
 *  - the HARNESS owns the contract, the exact-pin enforcement, the
 *    correlation reads and the recording: `RuntimeStartContext` hands
 *    the driver the binding the BOUND RECORD expects, and every task
 *    run's `TaskRunOutcome` reports per-edge execution observations
 *    the harness correlates through `ZeckTraceSource` (read-only).
 *
 * The driver is a TRANSLATION boundary (ACR-007 §1): it translates
 * application task/context → Zeck task + constraints + references →
 * Zeck execution → result/evidence → application result. It must NOT
 * add provider selection, retry routing, budget accounting,
 * verification or optimization logic — those stay with Zeck.
 */

import type { EgressObservation, ProviderCredentialFact } from "../domain/evidence";
import type { ApplicationIdentity, RevisionPin } from "../domain/revisions";
import type { RuntimeSessionDescriptor, TaskRunOutcome } from "../domain/runtime";

/** The context a certified start receives (the binding comes from the record). */
export interface RuntimeStartContext {
  /** The exact binding the bound evidence record expects (fail-closed). */
  readonly expectedApplicationId: string;
  readonly expectedPin: RevisionPin;
  /** A stable run correlation id (the harness assigns; the driver threads it into its executions' metadata). */
  readonly runCorrelationId: string;
  /** The injected clock (ISO strings — the driver timestamps its own observations). */
  readonly now: () => string;
}

/** One representative task of a certified run (the corpus's own declaration). */
export interface PinnedRuntimeTask {
  readonly taskId: string;
  readonly title: string;
  /** The verbatim task instruction (what the application executes). */
  readonly instruction: string;
}

/** A started pinned runtime session (ONE exact application + integration revision pair). */
export interface PinnedRuntimeSession {
  /** The session's own descriptor — the harness verifies it against the record's binding. */
  readonly descriptor: RuntimeSessionDescriptor;
  /**
   * The runtime's provider-credential presence facts (env-var NAMES +
   * booleans, never values) — the erasure-check input the certified
   * environment must satisfy (ACR-007 §5).
   */
  readonly environmentFacts: readonly ProviderCredentialFact[];
  /**
   * Execute ONE representative task through the pinned runtime. The
   * outcome carries the application result, the per-edge execution
   * observations and the run's egress observation.
   */
  executeTask(task: PinnedRuntimeTask): Promise<TaskRunOutcome>;
  /** Stop the session (the harness always stops what it started). */
  stop(): Promise<void>;
}

/** The driver contract an application work order implements (the plug-in surface). */
export interface PinnedRuntimeDriver {
  /** The registry id (the Demo Mirror entry's runBinding.runtime names THIS). */
  readonly runtimeId: string;
  /** The pinned application's identity (must equal the bound record's). */
  readonly identity: ApplicationIdentity;
  /** The exact pins this driver starts (must equal the bound record's). */
  readonly pin: RevisionPin;
  /** Start ONE exact session (the harness verifies the binding before and after). */
  start(context: RuntimeStartContext): Promise<PinnedRuntimeSession>;
}

/** A named runtime-registry defect (fail-closed; never a silent miss). */
export interface RuntimeRegistryIssue {
  readonly runtimeId?: string;
  readonly issue: string;
}

/**
 * The run-report shape the harness derives per run: the task outcome
 * (as the session reported), the correlated Zeck trace facts (as the
 * trace source read them back) and the run-level egress observation
 * (verbatim from the task outcome).
 */
export interface CorrelatedRunReport {
  readonly task: PinnedRuntimeTask;
  readonly outcome: TaskRunOutcome;
  readonly traces: readonly import("../domain/evidence").ZeckTraceFact[];
  readonly egressObservation: EgressObservation | null;
}
