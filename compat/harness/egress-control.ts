/**
 * The Zeck-only egress control (PPR-018A scope item 3) — the
 * proof-environment composition over the compatibility layer's
 * allowlist harness.
 *
 * THE POSTURE: for a certified application runtime, NOTHING outbound
 * passes except the explicitly allowed hosts — the Zeck API endpoint
 * (the delegated edge's destination) and the proof environment's
 * loopback infrastructure. Every provider-class host pattern below is
 * an OBSERVATION LABEL (naming which provider class a denied request
 * targeted); a denied request matching NO known pattern is still
 * denied (the default-deny note) — which is exactly what makes a
 * direct provider edge hidden behind an unknown host or a proxy
 * structurally impossible in the certified environment.
 *
 * Provider neutrality: host patterns are opaque proof-environment
 * strings (the domain knows none of them; this file is the reusable
 * proof configuration, exactly like the credential name list).
 */

import {
  createEgressAllowlistHarness,
  type EgressDenyHarness,
  type EgressDenyRule,
} from "../../src/integrations/compatibility/public";

/** The loopback allow rules (the proof environment's own infrastructure). */
export function loopbackAllowRules(): readonly { hostPattern: string; note: string }[] {
  return [
    { hostPattern: "127.0.0.1", note: "loopback (the proof environment's local services)" },
    { hostPattern: "localhost", note: "loopback (the proof environment's local services)" },
  ];
}

/**
 * The provider-class egress deny patterns (observation labels for
 * denied requests — the well-known direct AI-provider endpoint
 * classes; extensible by the work order for its application's own
 * providers).
 */
export function providerClassDenyRules(
  extra: readonly EgressDenyRule[] = [],
): readonly EgressDenyRule[] {
  return [
    { hostPattern: "api.openai.com", note: "direct OpenAI provider endpoint class" },
    { hostPattern: "*.openai.com", note: "direct OpenAI provider endpoint class" },
    { hostPattern: "api.anthropic.com", note: "direct Anthropic provider endpoint class" },
    { hostPattern: "*.anthropic.com", note: "direct Anthropic provider endpoint class" },
    { hostPattern: "openrouter.ai", note: "direct OpenRouter provider endpoint class" },
    { hostPattern: "*.openrouter.ai", note: "direct OpenRouter provider endpoint class" },
    { hostPattern: "generativelanguage.googleapis.com", note: "direct Google AI provider endpoint class" },
    { hostPattern: "api.groq.com", note: "direct Groq provider endpoint class" },
    { hostPattern: "api.mistral.ai", note: "direct Mistral provider endpoint class" },
    { hostPattern: "api.deepseek.com", note: "direct DeepSeek provider endpoint class" },
    { hostPattern: "api.together.xyz", note: "direct Together provider endpoint class" },
    { hostPattern: "api.cohere.com", note: "direct Cohere provider endpoint class" },
    { hostPattern: "api.x.ai", note: "direct xAI provider endpoint class" },
    ...extra,
  ];
}

export interface ZeckOnlyEgressControlOptions {
  /**
   * The Zeck API base URL — the ONE delegated destination the
   * certified runtime may reach (its host is allowlisted).
   */
  readonly zeckApiBaseUrl: string;
  readonly mode: "observe" | "deny";
  /** The outbound transport to wrap (injected). */
  readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The injected clock (ISO strings). */
  readonly now: () => string;
  /** Additional explicitly allowed hosts (proof infrastructure only — never a provider). */
  readonly extraAllowHosts?: readonly { hostPattern: string; note: string }[];
  /** Additional provider-class deny patterns (observation labels). */
  readonly extraDenyRules?: readonly EgressDenyRule[];
}

/** Derive the allow rule for the Zeck API endpoint (host only, from the base URL). */
export function zeckEndpointAllowRule(zeckApiBaseUrl: string): {
  hostPattern: string;
  note: string;
} {
  const parsed = new URL(zeckApiBaseUrl);
  return {
    hostPattern: parsed.host,
    note: "the Zeck API endpoint (the delegated execution boundary — the certified runtime's one destination)",
  };
}

/**
 * Compose the Zeck-only egress control: the allowlist harness with the
 * Zeck endpoint + loopback allowed, provider-class patterns as deny
 * labels, everything else default-denied.
 */
export function createZeckOnlyEgressControl(
  options: ZeckOnlyEgressControlOptions,
): EgressDenyHarness {
  const allowRules = [
    zeckEndpointAllowRule(options.zeckApiBaseUrl),
    ...loopbackAllowRules(),
    ...(options.extraAllowHosts ?? []),
  ];
  for (const extra of options.extraAllowHosts ?? []) {
    const deniedByLabel = providerClassDenyRules().some((rule) =>
      rule.hostPattern.toLowerCase() === extra.hostPattern.toLowerCase(),
    );
    if (deniedByLabel) {
      throw new Error(
        `refusing to allowlist host pattern "${extra.hostPattern}" — it names a known provider-class endpoint (the Zeck-only allowlist may never carry a direct provider host)`,
      );
    }
  }
  return createEgressAllowlistHarness({
    mode: options.mode,
    allowRules,
    denyRules: providerClassDenyRules(options.extraDenyRules ?? []),
    fetchImpl: options.fetchImpl,
    now: options.now,
  });
}
