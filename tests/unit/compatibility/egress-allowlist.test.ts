/**
 * PPR-018A — the Zeck-only egress allowlist tests (scope item 3: the
 * "runtime direct-provider egress deny/observation controls with
 * explicit Zeck-only allowlists" + the battery's "a direct provider
 * edge hidden by a proxy" impossibility).
 *
 * Pins:
 *  - the Zeck API endpoint + loopback pass untouched;
 *  - a KNOWN provider host is denied with its provider-class label;
 *  - IMPOSSIBILITY: an UNKNOWN host and a PROXY host are denied too
 *    (the default-deny note) — the deny-pattern list is observation
 *    labels, the ALLOWLIST is the enforcement, so hiding a provider
 *    behind a proxy/unknown host cannot work;
 *  - the observation derivation stays the PPR-017 contract
 *    (provably-blocked in deny mode; violations-detected in observe
 *    mode; observed-clean when nothing was attempted);
 *  - the harness composition refuses to allowlist a provider-class
 *    host (the allowlist may never carry a direct provider).
 */

import { describe, expect, test } from "vitest";
import {
  createZeckOnlyEgressControl,
  providerClassDenyRules,
} from "../../../compat/harness/egress-control";
import {
  createEgressAllowlistHarness,
  EGRESS_DEFAULT_DENY_NOTE,
  type EgressDenyRule,
} from "../../../src/integrations/compatibility/public";

const NOW = "2026-09-27T00:00:00Z";

/** An injected transport that records what reached it. */
function recordingTransport(): {
  readonly transport: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly reached: () => readonly string[];
} {
  const reached: string[] = [];
  const transport = async (input: string | URL | Request): Promise<Response> => {
    reached.push(String(input));
    return new Response("{}", { status: 200 });
  };
  return { transport, reached: () => [...reached] };
}

const ALLOW = [
  { hostPattern: "api.zeck.example", note: "the Zeck API endpoint" },
  { hostPattern: "127.0.0.1", note: "loopback" },
];

const DENY: readonly EgressDenyRule[] = [
  { hostPattern: "api.openai.com", note: "direct OpenAI provider endpoint class" },
  { hostPattern: "*.openai.com", note: "direct OpenAI provider endpoint class" },
];

describe("the Zeck-only egress allowlist control", () => {
  test("the Zeck endpoint and loopback pass untouched", async () => {
    const transport = recordingTransport();
    const harness = createEgressAllowlistHarness({
      mode: "deny",
      allowRules: ALLOW,
      denyRules: DENY,
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    await harness.transport("https://api.zeck.example/executions");
    await harness.transport("http://127.0.0.1:8787/v1/chat/completions");
    expect(transport.reached()).toHaveLength(2);
    expect(harness.observation()).toEqual({
      mode: "deny",
      status: "observed-clean",
      violations: [],
    });
  });

  test("a KNOWN provider host is denied and labeled with its provider class", async () => {
    const transport = recordingTransport();
    const harness = createEgressAllowlistHarness({
      mode: "deny",
      allowRules: ALLOW,
      denyRules: DENY,
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    await expect(harness.transport("https://api.openai.com/v1/chat/completions")).rejects.toThrow(
      /egress denied/,
    );
    expect(transport.reached()).toEqual([]);
    const observation = harness.observation();
    expect(observation.status).toBe("provably-blocked");
    expect(observation.violations[0]?.rule).toContain("OpenAI");
    expect(observation.violations[0]?.blocked).toBe(true);
    // Query strings never enter evidence (the redaction discipline).
    expect(observation.violations[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  test("IMPOSSIBILITY (proxy-hidden edge): a proxy host is denied by the default-deny note", async () => {
    const transport = recordingTransport();
    const harness = createEgressAllowlistHarness({
      mode: "deny",
      allowRules: ALLOW,
      denyRules: DENY,
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    // A proxy the application might route through to hide a provider
    // call: NOT on the allowlist, NOT matching any known pattern.
    await expect(
      harness.transport("http://internal-relay.corp:8080/forward-to-anyone"),
    ).rejects.toThrow(/Zeck-only allowlist/);
    expect(transport.reached()).toEqual([]);
    const observation = harness.observation();
    expect(observation.status).toBe("provably-blocked");
    expect(observation.violations[0]?.rule).toBe(EGRESS_DEFAULT_DENY_NOTE);
    expect(observation.violations[0]?.host).toBe("internal-relay.corp:8080");
  });

  test("port-aware allowing: a loopback port passes, but localhost.<other> does NOT (no substring allowing)", async () => {
    const transport = recordingTransport();
    const harness = createEgressAllowlistHarness({
      mode: "deny",
      allowRules: ALLOW,
      denyRules: DENY,
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    // 127.0.0.1 on ANY port passes (the hostname matches the rule).
    await harness.transport("http://127.0.0.1:9999/health");
    expect(transport.reached()).toHaveLength(1);
    // But a lookalike host is NOT allowed (exact/pattern matching, no
    // substring): localhost.evil.example is denied.
    await expect(harness.transport("http://localhost.evil.example/v1")).rejects.toThrow(
      /Zeck-only allowlist/,
    );
    expect(transport.reached()).toHaveLength(1);
    expect(harness.observation().violations[0]?.host).toBe("localhost.evil.example");
  });

  test("IMPOSSIBILITY (unknown provider): an unknown direct provider host is denied too", async () => {
    const transport = recordingTransport();
    const harness = createEgressAllowlistHarness({
      mode: "deny",
      allowRules: ALLOW,
      denyRules: DENY,
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    await expect(harness.transport("https://api.brand-new-llm.vendor.example/v1")).rejects.toThrow(
      /Zeck-only allowlist/,
    );
    expect(harness.observation().violations[0]?.rule).toBe(EGRESS_DEFAULT_DENY_NOTE);
  });

  test("observe mode records a passing violation as violations-detected (a detected bypass)", async () => {
    const transport = recordingTransport();
    const harness = createEgressAllowlistHarness({
      mode: "observe",
      allowRules: ALLOW,
      denyRules: DENY,
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    const response = await harness.transport("https://api.openai.com/v1/chat/completions");
    expect(response.status).toBe(200); // passed through, but RECORDED
    const observation = harness.observation();
    expect(observation.status).toBe("violations-detected");
    expect(observation.violations[0]?.blocked).toBe(false);
  });

  test("the harness composition refuses to allowlist a provider-class host", () => {
    expect(() =>
      createZeckOnlyEgressControl({
        zeckApiBaseUrl: "https://api.zeck.example",
        mode: "deny",
        fetchImpl: async () => new Response("{}"),
        now: () => NOW,
        extraAllowHosts: [{ hostPattern: "api.openai.com", note: "sneaky" }],
      }),
    ).toThrow(/never carry a direct provider host/);
  });

  test("the harness composition allowlists the Zeck endpoint and denies a provider end-to-end", async () => {
    const transport = recordingTransport();
    const control = createZeckOnlyEgressControl({
      zeckApiBaseUrl: "https://api.zeck.example",
      mode: "deny",
      fetchImpl: transport.transport,
      now: () => NOW,
    });
    await control.transport("https://api.zeck.example/executions");
    await expect(control.transport("https://api.anthropic.com/v1/messages")).rejects.toThrow(
      /Zeck-only allowlist/,
    );
    expect(transport.reached()).toEqual(["https://api.zeck.example/executions"]);
    expect(control.observation().status).toBe("provably-blocked");
    expect(control.violations()[0]?.rule).toContain("Anthropic");
    // The reusable provider-class label set covers the well-known classes.
    expect(providerClassDenyRules().length).toBeGreaterThanOrEqual(13);
  });
});
