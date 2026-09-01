/**
 * In-memory customer-runner endpoint (runners integration adapter;
 * WORK-019 — the simulated external runner used by tests and local
 * compositions).
 *
 * The external twin of the WORK-012 `RecordingProvider` discipline: a
 * faithful fake of a customer-controlled runner that records every
 * handoff it receives and answers a CONFIGURED observation. It can
 * simulate unreachability (fail-closed throws — the channel surfaces a
 * transport failure; the fleet's lease is the reconciliation bound).
 *
 * The simulated runner is deliberately UNTRUSTED-shaped: it receives only
 * the sanitized handoff and returns only a sandbox-axis observation —
 * there is no field on the fake that could mutate platform authority.
 */

import type { RunnerHandoff, RunnerResultReport } from "../../../modules/sandbox/public";
import type { CustomerRunnerEndpoint } from "../ports/customer-runner-endpoint";

export interface InMemoryCustomerRunnerEndpointOptions {
  readonly endpointRef: string;
  /** The observation answered for every received handoff. */
  readonly observation: RunnerResultReport;
  /** When true, the runner is unreachable: delivery throws (fail-closed). */
  readonly unreachable?: boolean;
}

export class InMemoryCustomerRunnerEndpoint implements CustomerRunnerEndpoint {
  readonly endpointRef: string;
  readonly handoffs: RunnerHandoff[] = [];
  private readonly observation: RunnerResultReport;
  private unreachable: boolean;

  constructor(options: InMemoryCustomerRunnerEndpointOptions) {
    this.endpointRef = options.endpointRef;
    this.observation = options.observation;
    this.unreachable = options.unreachable ?? false;
  }

  /** Test control: simulate the runner dropping off the network. */
  setUnreachable(unreachable: boolean): void {
    this.unreachable = unreachable;
  }

  async receiveHandoff(handoff: RunnerHandoff): Promise<RunnerResultReport> {
    if (this.unreachable) {
      throw new Error(
        `the customer runner at "${this.endpointRef}" is unreachable; handoff delivery for assignment ${handoff.assignmentId} failed closed`,
      );
    }
    this.handoffs.push(handoff);
    return this.observation;
  }
}
