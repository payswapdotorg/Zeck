/**
 * PPR-017 — the egress kill test (the work order: "egress kill test
 * (the deny harness actually blocks + records)").
 *
 * The proof-environment egress-deny harness must, in DENY mode:
 *  - actually BLOCK a request to a denylisted direct AI-provider host
 *    (the request never reaches the wrapped transport — fail closed)
 *    and RECORD the violation;
 *  - derive `provably-blocked` from the recorded violations (every one
 *    blocked) — the rule-2 admission input;
 * and in OBSERVE mode:
 *  - record a passing violation WITHOUT blocking it (the honest
 *    bypass-detection vocabulary: an observed-passing violation is a
 *    detected bypass, never a silent pass);
 * while:
 *  - requests to hosts NOT on the deny list (the Zeck API endpoint, an
 *    ordinary host) always pass through untouched;
 *  - the harness imports no network runtime module and constructs no
 *    transport of its own (the injected-transport discipline — pinned
 *    by the architecture boundary suite over the whole tree).
 */

import { describe, expect, test } from "vitest";
import {
  createEgressDenyHarness,
  EgressBlockedError,
  hostMatchesPattern,
  type OutboundTransport,
} from "../../../src/integrations/compatibility/public";

const DENY_RULES = [
  {
    hostPattern: "provider.example",
    note: "the direct AI-provider endpoint class of the proof environment",
  },
  {
    hostPattern: "*.embedding-provider.example",
    note: "the embedding provider endpoint class of the proof environment",
  },
];

/** The recording fake transport: counts calls, never performs I/O. */
function recordingTransport(): {
  readonly calls: () => string[];
  readonly transport: OutboundTransport;
} {
  const seen: string[] = [];
  return {
    calls: () => [...seen],
    transport: (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response("passed-through", { status: 200 });
    }) as OutboundTransport,
  };
}

const NOW = () => "2026-09-26T00:00:00Z";

describe("the egress deny harness (deny mode — the kill test)", () => {
  test("a denylisted direct-provider request is BLOCKED (never reaches the transport) and RECORDED", async () => {
    const wrapped = recordingTransport();
    const harness = createEgressDenyHarness({
      mode: "deny",
      denyRules: DENY_RULES,
      fetchImpl: wrapped.transport,
      now: NOW,
    });
    await expect(
      harness.transport("https://provider.example/v1/completions"),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    // THE KILL ASSERTION: the wrapped transport was never called.
    expect(wrapped.calls()).toEqual([]);
    // The violation is recorded with its host, rule and block state.
    expect(harness.violations()).toHaveLength(1);
    const violation = harness.violations()[0];
    expect(violation?.host).toBe("provider.example");
    expect(violation?.blocked).toBe(true);
    expect(violation?.rule).toContain("direct AI-provider");
    expect(violation?.at).toBe("2026-09-26T00:00:00Z");
    // The observation derives provably-blocked (rule 2's proof shape).
    expect(harness.observation()).toEqual({
      mode: "deny",
      status: "provably-blocked",
      violations: [violation],
    });
  });

  test("a subdomain of a wildcard deny pattern is blocked too (the pattern class works)", async () => {
    const wrapped = recordingTransport();
    const harness = createEgressDenyHarness({
      mode: "deny",
      denyRules: DENY_RULES,
      fetchImpl: wrapped.transport,
      now: NOW,
    });
    await expect(
      harness.transport("https://api.embedding-provider.example/v1/embeddings"),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(wrapped.calls()).toEqual([]);
    expect(harness.violations()).toHaveLength(1);
  });

  test("a NON-denylisted request passes through untouched (the Zeck boundary is not the deny list)", async () => {
    const wrapped = recordingTransport();
    const harness = createEgressDenyHarness({
      mode: "deny",
      denyRules: DENY_RULES,
      fetchImpl: wrapped.transport,
      now: NOW,
    });
    const response = await harness.transport("https://api.zeck.example/executions");
    expect(response.status).toBe(200);
    expect(wrapped.calls()).toEqual(["https://api.zeck.example/executions"]);
    expect(harness.violations()).toEqual([]);
    expect(harness.observation().status).toBe("observed-clean");
  });

  test("the blocked violation's URL is redacted to origin+path (query strings never enter evidence)", async () => {
    const wrapped = recordingTransport();
    const harness = createEgressDenyHarness({
      mode: "deny",
      denyRules: DENY_RULES,
      fetchImpl: wrapped.transport,
      now: NOW,
    });
    await expect(
      harness.transport("https://provider.example/v1/completions?api-key=SECRET&x=1"),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(harness.violations()[0]?.url).toBe("https://provider.example/v1/completions");
  });
});

describe("the egress deny harness (observe mode — the honest bypass vocabulary)", () => {
  test("a denylisted request PASSES THROUGH but is recorded as a violation (a detected bypass)", async () => {
    const wrapped = recordingTransport();
    const harness = createEgressDenyHarness({
      mode: "observe",
      denyRules: DENY_RULES,
      fetchImpl: wrapped.transport,
      now: NOW,
    });
    const response = await harness.transport("https://provider.example/v1/completions");
    expect(response.status).toBe(200);
    expect(wrapped.calls()).toEqual(["https://provider.example/v1/completions"]);
    expect(harness.violations()).toHaveLength(1);
    expect(harness.violations()[0]?.blocked).toBe(false);
    expect(harness.observation().status).toBe("violations-detected");
  });

  test("an observe run with no violations derives observed-clean", () => {
    const harness = createEgressDenyHarness({
      mode: "observe",
      denyRules: DENY_RULES,
      fetchImpl: recordingTransport().transport,
      now: NOW,
    });
    expect(harness.observation().status).toBe("observed-clean");
  });
});

describe("the harness pattern matcher (documented, provider-neutral)", () => {
  test("exact hosts, wildcard subdomains and prefix patterns match; everything else does not", () => {
    expect(hostMatchesPattern("provider.example", "provider.example")).toBe(true);
    expect(hostMatchesPattern("Provider.Example", "provider.example")).toBe(true);
    expect(hostMatchesPattern("api.provider.example", "provider.example")).toBe(false);
    expect(
      hostMatchesPattern("api.embedding-provider.example", "*.embedding-provider.example"),
    ).toBe(true);
    expect(hostMatchesPattern("embedding-provider.example", "*.embedding-provider.example")).toBe(
      false,
    );
    expect(hostMatchesPattern("provider.example.evil.test", "provider.example")).toBe(false);
  });
});
