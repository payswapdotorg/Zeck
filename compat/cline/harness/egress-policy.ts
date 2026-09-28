/**
 * The PPR-019 egress policy — the shared, side-effect-free library both
 * the egress PRELOAD (which runs inside the Cline runtime) and the
 * harness-side spawner/tests import. The named deny rules, the
 * default-deny catch-all, the loopback exception and the credential
 * scrub list live here (the preload script itself stays a pure script —
 * importing THIS module never patches anything).
 */

/** The named deny rules (opaque patterns + provenance notes). */
export const PROOF_EGRESS_DENY_RULES = [
  { hostPattern: "api.openai.com", note: "direct OpenAI provider endpoint (AI-provider egress class)" },
  { hostPattern: "api.anthropic.com", note: "direct Anthropic provider endpoint (AI-provider egress class)" },
  { hostPattern: "openrouter.ai", note: "OpenRouter aggregation rail endpoint" },
  { hostPattern: "*.openrouter.ai", note: "OpenRouter aggregation rail endpoint" },
  { hostPattern: "api.groq.com", note: "direct Groq provider endpoint" },
  { hostPattern: "generativelanguage.googleapis.com", note: "direct Gemini provider endpoint" },
  { hostPattern: "api.mistral.ai", note: "direct Mistral provider endpoint" },
  { hostPattern: "api.deepseek.com", note: "direct DeepSeek provider endpoint" },
  { hostPattern: "api.cohere.com", note: "direct Cohere provider endpoint" },
  { hostPattern: "api.together.xyz", note: "direct Together provider endpoint" },
  { hostPattern: "api.x.ai", note: "direct xAI provider endpoint" },
  { hostPattern: "open.bigmodel.cn", note: "direct Zhipu provider endpoint" },
  { hostPattern: "api.deepinfra.com", note: "direct DeepInfra provider endpoint" },
  { hostPattern: "api.fireworks.ai", note: "direct Fireworks provider endpoint" },
  { hostPattern: "inference.cerebras.ai", note: "direct Cerebras provider endpoint" },
  { hostPattern: "*.meta.com", note: "direct Meta Llama provider endpoint" },
  { hostPattern: "gateway.ai.cloudflare.com", note: "Cloudflare AI gateway endpoint" },
  { hostPattern: "internal-api.z.ai", note: "the sandbox's GLM supply endpoint (platform-side BYOK material — must not be reachable from the application runtime)" },
  { hostPattern: "models.dev", note: "model-catalog phone-home (live catalog fetch)" },
  { hostPattern: "us.i.posthog.com", note: "PostHog telemetry endpoint" },
  { hostPattern: "us-assets.i.posthog.com", note: "PostHog telemetry assets endpoint" },
  { hostPattern: "*.cline.bot", note: "Cline first-party endpoints (auth/telemetry/update)" },
  { hostPattern: "registry.npmjs.org", note: "npm registry (auto-update/dependency fetch)" },
  { hostPattern: "*.github.com", note: "GitHub (version-check telemetry)" },
  { hostPattern: "api.github.com", note: "GitHub API (version-check telemetry)" },
  { hostPattern: "objects.githubusercontent.com", note: "GitHub release assets (auto-update)" },
] as const;

/** The catch-all rule every other non-loopback host matches (default-deny). */
export const DEFAULT_DENY_NOTE =
  "proof-environment default-deny: every non-loopback host is denied for the Cline runtime (only the local Zeck adapter is reachable)";

/** The AI-provider credential env-var names the proof scrubs (names only). */
export const SCRUBBED_CREDENTIAL_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "DEEPINFRA_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "COHERE_API_KEY",
  "CLINE_API_KEY",
  "BEDROCK_ACCESS_KEY_ID",
  "BEDROCK_SECRET_ACCESS_KEY",
  "VERTEX_PROJECT_ID",
  "AZURE_API_KEY",
] as const;

/** Is a host loopback (the local Zeck adapter)? */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** One recorded violation (the framework's EgressViolation field vocabulary). */
export interface EgressViolationRecord {
  readonly host: string;
  readonly url: string;
  readonly rule: string;
  readonly at: string;
  readonly blocked: boolean;
}

/** Which named rule matches a host (the catch-all when none does)? */
export function denyRuleFor(
  host: string,
  hostMatchesPattern: (host: string, pattern: string) => boolean,
): { hostPattern: string; note: string } {
  for (const rule of PROOF_EGRESS_DENY_RULES) {
    if (hostMatchesPattern(host, rule.hostPattern)) {
      return rule;
    }
  }
  return { hostPattern: "*", note: DEFAULT_DENY_NOTE };
}
