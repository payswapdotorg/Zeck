/**
 * The Zeck-only egress allowlist control (PPR-018A scope item 3) —
 * the runtime direct-provider egress deny/observation control with
 * EXPLICIT ALLOWLISTS FOR ZECK ONLY.
 *
 * WHY AN ALLOWLIST (building on the PPR-017 deny harness): the deny
 * harness matches provider host PATTERNS — it names what it knows.
 * A direct provider edge hidden behind a proxy (an internal relay, a
 * renamed gateway, an unexpected provider) does not match any known
 * pattern and passes a deny list UNSEEN. The allowlist inverts the
 * posture for the certified runtime: NOTHING passes except the
 * explicitly allowed hosts (the Zeck API endpoint and the proof
 * environment's loopback infrastructure). A proxy forwarding to a
 * provider is itself not on the allowlist — the request is denied and
 * recorded, whatever it forwards to. This is the control that makes
 * "a direct provider edge hidden by a proxy" structurally impossible
 * in the certified environment.
 *
 * The deny RULES stay as OBSERVATION LABELS: when a denied request
 * matches a known provider-class pattern, the violation records which
 * class it was; when it matches none, the violation records the
 * default-deny note. Both are honest `EgressViolation` facts and the
 * `observation()` derivation (the PPR-017 port contract, unchanged)
 * turns them into `provably-blocked` / `violations-detected`.
 *
 * A proof tool, not a production network policy: injected transport,
 * no network module, installs nothing platform-side. Provider
 * neutral: host patterns and allow rules are opaque strings from the
 * proof environment.
 */

import type { EgressObservation, EgressViolation } from "../domain/evidence";
import type { EgressDenyHarness, EgressDenyRule } from "../ports/egress-harness";
import { hostMatchesPattern, type OutboundTransport } from "./egress-deny-harness";

/** One allow rule: an explicitly allowed host pattern + its provenance note. */
export interface EgressAllowRule {
  readonly hostPattern: string;
  readonly note: string;
}

export interface EgressAllowlistHarnessOptions {
  /** The mode: `deny` blocks + records; `observe` records and passes through. */
  readonly mode: "observe" | "deny";
  /**
   * The EXPLICIT allowlist — the only hosts the certified runtime may
   * reach (the Zeck API endpoint + the proof environment's loopback
   * infrastructure). Everything else is a violation.
   */
  readonly allowRules: readonly EgressAllowRule[];
  /**
   * The provider-class deny patterns (observation labels for denied
   * requests — a denied request that matches none records the
   * default-deny note instead).
   */
  readonly denyRules: readonly EgressDenyRule[];
  /** The outbound transport to wrap (injected — the harness builds nothing). */
  readonly fetchImpl: OutboundTransport;
  /** The clock for violation timestamps (injected; ISO string). */
  readonly now: () => string;
}

/** The default-deny note (the allowlist's own provenance statement). */
export const EGRESS_DEFAULT_DENY_NOTE =
  "default-deny: the host is not on the certified runtime's Zeck-only egress allowlist";

/**
 * Create the Zeck-only egress allowlist harness. Returns the PPR-017
 * `EgressDenyHarness` port (same contract, same observation
 * derivation): allowlisted hosts pass untouched; everything else is a
 * recorded violation (blocked in deny mode, observed in observe mode).
 */
export function createEgressAllowlistHarness(
  options: EgressAllowlistHarnessOptions,
): EgressDenyHarness {
  const recorded: EgressViolation[] = [];
  const { mode, allowRules, denyRules, fetchImpl, now } = options;

  const wrappedTransport = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host: string;
    let hostname: string;
    try {
      const parsed = new URL(url);
      host = parsed.host; // hostname[:port]
      hostname = parsed.hostname; // port-stripped (loopback ports vary)
    } catch {
      host = "";
      hostname = "";
    }
    // An allow rule matches the FULL host or the port-stripped
    // hostname — so "127.0.0.1" allows "127.0.0.1:8787" (the proof
    // environment's loopback services ride arbitrary ports) while
    // "localhost" never allows "localhost.evil.example" (the hostname
    // comparison is exact/patterned, not a substring).
    const allowed = allowRules.find(
      (rule) =>
        hostMatchesPattern(host, rule.hostPattern) ||
        hostMatchesPattern(hostname, rule.hostPattern),
    );
    if (allowed !== undefined) {
      return fetchImpl(input, init);
    }
    // Not allowlisted: a violation. A matching deny rule names the
    // provider class; otherwise the default-deny note stands (a
    // proxy or unknown host is denied exactly like a known provider).
    const matched = denyRules.find((rule) => hostMatchesPattern(host, rule.hostPattern));
    const violation: EgressViolation = {
      host,
      url: redactUrl(url),
      rule: matched?.note ?? EGRESS_DEFAULT_DENY_NOTE,
      at: now(),
      blocked: mode === "deny",
    };
    recorded.push(violation);
    if (mode === "deny") {
      // Fail closed: the request never reaches the real transport.
      const error = new Error(
        `egress denied by the Zeck-only allowlist: ${violation.host} matched no allow rule ("${violation.rule}")`,
      );
      error.name = "EgressBlockedError";
      throw error;
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
