/**
 * The runtime egress-deny harness adapter — the PROOF-ENVIRONMENT
 * egress observation/deny control (work order part C).
 *
 * Design (provider-neutral, I/O-injected, fail-closed):
 *  - the harness wraps an INJECTED outbound transport (`fetchImpl`
 *    shaped — the harness constructs no transport of its own and
 *    imports no network runtime module; a proof run hands it the
 *    application runtime's transport, or the global one via the
 *    composition seam);
 *  - every outbound request's HOST is matched against the proof
 *    environment's deny rules (opaque host patterns — no provider
 *    semantics exist here);
 *  - DENY mode: a matching request is REFUSED (EgressBlockedError,
 *    fail closed) and the violation is recorded — a proof run wrapped
 *    in the deny harness can prove "direct provider egress is
 *    provably blocked" (every violation blocked, none passed);
 *  - OBSERVE mode: a matching request is recorded and passes through —
 *    an observed-passing violation is a detected bypass, surfaced
 *    honestly by the observation derivation below;
 *  - non-matching requests pass through untouched (the Zeck API
 *    endpoint itself is NOT on the deny list — the deny list is the
 *    direct AI-provider boundary, not the platform boundary).
 *
 * This is a proof tool. It is never a production network policy and
 * installs nothing platform-side.
 */

import type { EgressObservation, EgressViolation } from "../domain/evidence";
import type { EgressDenyHarness, EgressDenyRule } from "../ports/egress-harness";
import { EgressBlockedError } from "../ports/egress-harness";

/** The injected outbound transport shape (fetch-shaped; never named). */
export type OutboundTransport = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface EgressDenyHarnessOptions {
  /** The mode: `deny` blocks + records; `observe` records and passes through. */
  readonly mode: "observe" | "deny";
  /** The proof environment's deny rules (opaque host patterns + notes). */
  readonly denyRules: readonly EgressDenyRule[];
  /** The outbound transport to wrap (injected — the harness builds nothing). */
  readonly fetchImpl: OutboundTransport;
  /** The clock for violation timestamps (injected; ISO string). */
  readonly now: () => string;
}

/**
 * Does a request host match a deny rule's pattern? Documented matching
 * rule (opaque to the domain): case-insensitive; the pattern matches
 * the host exactly, or as a `*.`-prefixed suffix pattern (`*.example`
 * matches every subdomain of example), or as a trailing-`*` prefix
 * pattern. No other semantics exist.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) {
    return true;
  }
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example"
    return h.endsWith(suffix) && h.length > suffix.length;
  }
  if (p.endsWith("*")) {
    return h.startsWith(p.slice(0, -1));
  }
  return false;
}

/** Create the proof-environment egress deny/observe harness. */
export function createEgressDenyHarness(options: EgressDenyHarnessOptions): EgressDenyHarness {
  const recorded: EgressViolation[] = [];
  const { mode, denyRules, fetchImpl, now } = options;

  const wrappedTransport = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      host = "";
    }
    const matched = denyRules.find((rule) => hostMatchesPattern(host, rule.hostPattern));
    if (matched === undefined) {
      return fetchImpl(input, init);
    }
    const violation: EgressViolation = {
      host,
      url: redactUrl(url),
      rule: matched.note,
      at: now(),
      blocked: mode === "deny",
    };
    recorded.push(violation);
    if (mode === "deny") {
      // Fail closed: the request never reaches the real transport.
      throw new EgressBlockedError(violation);
    }
    return fetchImpl(input, init);
  };

  return {
    transport: wrappedTransport,
    violations: () => [...recorded],
    observation: (): EgressObservation => {
      if (recorded.length === 0) {
        return { mode, status: "observed-clean", violations: [] };
      }
      if (mode === "deny" && recorded.every((violation) => violation.blocked)) {
        return { mode, status: "provably-blocked", violations: [...recorded] };
      }
      return { mode, status: "violations-detected", violations: [...recorded] };
    },
  };
}

/** Redact a URL to its origin + path (query strings never enter evidence). */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparseable request target)";
  }
}
