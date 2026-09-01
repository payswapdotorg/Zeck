/**
 * Customer-runner endpoint port (runners integration outbound; WORK-019).
 *
 * The transport-neutral representation of ONE externally controlled
 * customer runner: the seam through which a channel adapter reaches the
 * runner it owns. The endpoint receives the SANITIZED handoff (already
 * admitted, already assigned, secret REFERENCES only) and returns the
 * runner's sandbox-axis observation.
 *
 * This integration port is the external twin of the sandbox module's
 * `RunnerChannel`: the CHANNEL implements the sandbox port; the ENDPOINT
 * is what the channel talks to (a real transport adapter, or the in-memory
 * simulated runner used by the tests/composition). Disconnect/reconnect
 * mechanics are endpoint concerns: the platform-side observation of a
 * disconnect is recorded by the fleet (connection status + events); a
 * reconnected endpoint continues the SAME delivery — it can never mint a
 * second handoff, assignment or execution.
 *
 * No vendor transport vocabulary exists here: concrete transports (agent
 * protocols, streaming channels, future VM control planes) live behind
 * the adapters that implement this port.
 */

import type { RunnerHandoff, RunnerResultReport } from "../../../modules/sandbox/public";

export interface CustomerRunnerEndpoint {
  /** The opaque endpoint reference this endpoint is registered under. */
  readonly endpointRef: string;
  /**
   * Receive one admitted handoff and observe the result. Must fail closed
   * (throw) when the runner cannot execute the handoff — never fabricate
   * an observation.
   */
  receiveHandoff(handoff: RunnerHandoff): Promise<RunnerResultReport>;
}
