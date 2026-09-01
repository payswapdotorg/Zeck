/**
 * Customer-runner channel adapter (runners integration; WORK-019, ENV-003).
 *
 * Implements the sandbox module's REQUIRED `RunnerChannel` port against a
 * registry of `CustomerRunnerEndpoint`s — the composition wiring that
 * carries an ADMITTED handoff to the externally controlled runner that
 * owns it. The channel holds NO authority: it resolves the endpoint for
 * the handoff's runner and delegates; every lifecycle decision (assignment,
 * lease, authorization, outcome) stays in the sandbox fleet authority.
 */

import type {
  RunnerChannel,
  RunnerHandoff,
  RunnerResultReport,
} from "../../../modules/sandbox/public";
import type { CustomerRunnerEndpoint } from "../ports/customer-runner-endpoint";

export interface CustomerRunnerChannelOptions {
  /**
   * The endpoints this channel can reach, keyed by the runner's durable
   * identity (runnerId → endpoint). A handoff for an UNKNOWN runner fails
   * closed — the channel never guesses a transport.
   */
  readonly endpoints?: ReadonlyMap<string, CustomerRunnerEndpoint>;
}

export class CustomerRunnerChannel implements RunnerChannel {
  private readonly endpoints = new Map<string, CustomerRunnerEndpoint>();

  constructor(options: CustomerRunnerChannelOptions = {}) {
    for (const [runnerId, endpoint] of options.endpoints ?? []) {
      this.endpoints.set(runnerId, endpoint);
    }
  }

  /** Composition wiring: attach the endpoint that owns one runner. */
  attachEndpoint(runnerId: string, endpoint: CustomerRunnerEndpoint): void {
    this.endpoints.set(runnerId, endpoint);
  }

  async deliverHandoff(handoff: RunnerHandoff): Promise<RunnerResultReport> {
    const endpoint = this.endpoints.get(handoff.runnerId);
    if (endpoint === undefined) {
      throw new Error(
        `no customer-runner endpoint is attached for runner ${handoff.runnerId}; the channel fails closed instead of guessing a transport`,
      );
    }
    return endpoint.receiveHandoff(handoff);
  }
}
