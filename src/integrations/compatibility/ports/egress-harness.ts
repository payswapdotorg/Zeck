/**
 * The runtime direct-provider egress observation/deny port (ACR-006
 * proof battery steps 5/6; work order part C).
 *
 * THIS IS A PROOF TOOL, NOT A PRODUCTION NETWORK POLICY: the harness
 * wraps the PROOF RUNTIME's outbound transport so a proof can observe
 * (and, in deny mode, block) direct AI-provider egress from the
 * application under proof. It installs nothing platform-side, owns no
 * route decision and never runs in the serving path of any deployment.
 *
 * PROVIDER NEUTRALITY: the harness knows host PATTERNS, not providers —
 * the deny rules are opaque `hostPattern` strings supplied by the proof
 * environment (which endpoint classes count as direct AI-provider
 * egress is proof configuration, expressed as patterns; no provider
 * name, SDK or semantic ever enters the domain). The wrapped transport
 * is INJECTED (`fetchImpl`-shaped) — the harness performs no I/O of its
 * own construction and imports no network runtime module.
 */

import type { EgressObservation, EgressViolation } from "../domain/evidence";

/** One deny rule: an opaque host pattern + its provenance note. */
export interface EgressDenyRule {
  /**
   * The host pattern to match (an exact host, or a `.suffix`/`prefix*`
   * style pattern — matched case-insensitively by the adapter's own
   * documented rule; opaque to the domain).
   */
  readonly hostPattern: string;
  /** Why this pattern is on the deny list (provenance, rendered verbatim). */
  readonly note: string;
}

/** The thrown blocked-egress error (fail closed; never a silent pass). */
export class EgressBlockedError extends Error {
  readonly violation: EgressViolation;
  constructor(violation: EgressViolation) {
    super(
      `direct-provider egress denied: ${violation.host} matched deny rule "${violation.rule}" (proof-environment egress control)`,
    );
    this.name = "EgressBlockedError";
    this.violation = violation;
  }
}

/** The harness instance (a wrapped transport + the recorded evidence). */
export interface EgressDenyHarness {
  /**
   * The wrapped outbound transport: same shape as the injected
   * `fetchImpl`. Every request is checked against the deny rules BEFORE
   * reaching the real transport; deny-mode violations THROW
   * EgressBlockedError (fail closed) and are recorded; observe-mode
   * violations are recorded and pass through (an observed-passing
   * violation is a detected bypass — the evidence record's honest
   * vocabulary names it).
   */
  readonly transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Every recorded violation (blocked and observed-passing), in order. */
  readonly violations: () => readonly EgressViolation[];
  /**
   * The egress observation for the evidence record, derived from the
   * recorded violations and the mode: `provably-blocked` only in deny
   * mode with every violation blocked; `violations-detected` when any
   * violation passed; `observed-clean` when no violations occurred.
   */
  readonly observation: () => EgressObservation;
}
