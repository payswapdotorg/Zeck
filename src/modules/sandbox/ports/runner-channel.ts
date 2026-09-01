/**
 * Runner channel port (sandbox module outbound; WORK-019, ENV-003).
 *
 * The provider-neutral TRANSPORT seam between the sandbox module's runner
 * fleet and an externally controlled runner. The fleet authority decides
 * assignment, authorization, lease and outcome; the channel only DELIVERS
 * the already-admitted handoff and returns the runner's observation — it
 * holds no authority surface:
 *
 *   - the handoff is FULLY SANITIZED before it crosses (the immutable
 *     admitted snapshot: task argv + explicit public env, limits, network
 *     allowlist, filesystem refs, secret REFERENCES — a value field does
 *     not exist anywhere in the contract, M17);
 *   - the report is the RUNNER AXIS observation only (no verification,
 *     provider or tool vocabulary — the mapping onto the sandbox outcome
 *     happens in the fleet, never in the channel);
 *   - disconnect/reconnect mechanics are adapter concerns: the adapter
 *     re-attaches through the fleet's reconnect observation and keeps
 *     delivering the SAME handoff for the SAME assignment — a reconnect
 *     can never mint a second handoff, assignment or execution (M11);
 *   - implementations live behind adapters (the customer-runner
 *     integration owns the external-facing implementations; vendor
 *     transports never enter this module).
 *
 * This port is the sandbox twin of the agents `AgentProvider` discipline:
 * one neutral seam per participant axis, carrying REFERENCES only — no
 * stores, no services, no authorities, no execution status vocabulary
 * (an adapter is structurally never handed an authority surface).
 */

import type { RunnerHandoff, RunnerResultReport } from "../domain/runner";

export interface RunnerChannel {
  /**
   * Deliver one admitted handoff to its assigned runner and observe the
   * result. Must fail closed (throw) rather than fabricate an observation
   * when the runner is unreachable.
   */
  deliverHandoff(handoff: RunnerHandoff): Promise<RunnerResultReport>;
}
