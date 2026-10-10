/**
 * The PPR-026 egress-deny proxy — the proof-environment egress control
 * wrapping the ANYTHINGLLM APPLICATION RUNTIME's outbound traffic (the
 * application under proof: the server + collector processes), not the
 * Zeck-side harness (whose model-rail supply egress is platform-side
 * BYOK dispatch, exactly as in production; the identical discipline
 * PPR-018..025 established — HTTP_PROXY/HTTPS_PROXY env vars, honored
 * by the Node 24 global fetch the pinned AnythingLLM runtime's provider
 * connectors use (the openai npm SDK + the ollama npm client + every
 * plain fetch call site, with NODE_USE_ENV_PROXY=1) and by the
 * collector's fetches).
 *
 * POLICY: default-deny at the TCP level. The AnythingLLM application
 * processes are configured with HTTP_PROXY/HTTPS_PROXY pointing here and
 * NO_PROXY=127.0.0.1,localhost,0.0.0.0 (the Zeck adapter endpoint and
 * the server↔collector loopback are never proxied). Every proxied
 * request — CONNECT (https tunneling) or absolute-URI (plain http) — is
 * refused and recorded as an EgressViolation in the compatibility
 * framework's own vocabulary (imported from the PPR-017 public barrel:
 * EgressViolation shapes + the hostMatchesPattern matching rule), so
 * the evidence record's egress observation uses the framework's exact
 * shapes.
 *
 * The deny labels name the provider/service classes the pinned
 * AnythingLLM runtime's surface graph would otherwise reach directly
 * (the exact provider-connector fragmentation the target matrix flags
 * for this application): the OpenAI-compatible provider defaults, the
 * local-model engine download hosts (the native transformers embedder +
 * reranker weights), the alternative audio providers, the model-pricing
 * refresh host, the community hub, the telemetry endpoints, and the
 * collector's web-ingest hosts.
 *
 * The proxy never forwards anything: it is a deny-only observation
 * point (a proof tool, never a production network policy). A blocked
 * request fails closed — the AnythingLLM runtime sees a transport error
 * for every non-loopback egress attempt.
 */

import { createServer, type Socket } from "node:net";
import type {
  EgressObservation,
  EgressViolation,
} from "../../../src/integrations/compatibility/public";
import { hostMatchesPattern } from "../../../src/integrations/compatibility/public";

/** The proxy's named deny rules (opaque patterns + provenance notes). */
export const PROOF_EGRESS_DENY_RULES = [
  { hostPattern: "api.openai.com", note: "direct OpenAI provider endpoint (the generic-openai/openai connector defaults)" },
  { hostPattern: "*.openai.com", note: "direct OpenAI provider endpoint class" },
  { hostPattern: "api.anthropic.com", note: "direct Anthropic provider endpoint" },
  { hostPattern: "*.anthropic.com", note: "direct Anthropic provider endpoint class" },
  { hostPattern: "openrouter.ai", note: "OpenRouter aggregation rail" },
  { hostPattern: "*.openrouter.ai", note: "OpenRouter aggregation rail" },
  { hostPattern: "generativelanguage.googleapis.com", note: "direct Google AI provider endpoint (the Gemini connectors)" },
  { hostPattern: "api.groq.com", note: "direct Groq provider endpoint" },
  { hostPattern: "api.mistral.ai", note: "direct Mistral provider endpoint" },
  { hostPattern: "api.deepseek.com", note: "direct DeepSeek provider endpoint" },
  { hostPattern: "api.together.xyz", note: "direct Together provider endpoint" },
  { hostPattern: "api.cohere.com", note: "direct Cohere provider endpoint" },
  { hostPattern: "api.x.ai", note: "direct xAI provider endpoint" },
  { hostPattern: "*.openai.azure.com", note: "Azure OpenAI provider endpoint" },
  { hostPattern: "api.elevenlabs.io", note: "ElevenLabs TTS provider endpoint" },
  { hostPattern: "*.elevenlabs.io", note: "ElevenLabs TTS provider endpoint class" },
  { hostPattern: "api.deepgram.com", note: "Deepgram STT provider endpoint" },
  { hostPattern: "gateway.ai.cloudflare.com", note: "Cloudflare AI gateway" },
  { hostPattern: "huggingface.co", note: "the local-model engine download host (@xenova/transformers native embedder + reranker weights)" },
  { hostPattern: "*.hf.co", note: "the HuggingFace hub endpoint class" },
  { hostPattern: "cdn-lfs.huggingface.co", note: "the HuggingFace model CDN" },
  { hostPattern: "cdn.anythingllm.com", note: "the app's own model-download fallback CDN (the native embedder's fallback host)" },
  { hostPattern: "internal-api.z.ai", note: "the sandbox's GLM supply endpoint (platform-side BYOK material — must not be reachable from the application runtime)" },
  { hostPattern: "open.bigmodel.cn", note: "direct Zhipu provider endpoint" },
  { hostPattern: "api.z.ai", note: "direct Z.AI provider endpoint" },
  { hostPattern: "us.i.posthog.com", note: "posthog telemetry endpoint (disabled by config, denied regardless)" },
  { hostPattern: "*.posthog.com", note: "posthog telemetry endpoint" },
  { hostPattern: "hub.external.anythingllm.com", note: "the AnythingLLM community-hub endpoint (import actions never exercised)" },
  { hostPattern: "models.dev", note: "the model-pricing cache refresh host (fired once at boot on a fresh storage dir; non-AI, non-fatal, denied)" },
  { hostPattern: "api.github.com", note: "the GitHub release/version probe class" },
  { hostPattern: "github.com", note: "the GitHub release/version host" },
  { hostPattern: "raw.githubusercontent.com", note: "the update-probe artifact host" },
  { hostPattern: "registry.npmjs.org", note: "the npm registry (no runtime package installs in the certified environment)" },
  { hostPattern: "api.litellm.ai", note: "the LiteLLM aggregation endpoint" },
  { hostPattern: "ollama.com", note: "the Ollama registry endpoint (the ollama connector never pulls models in the certified environment)" },
  { hostPattern: "registry.ollama.ai", note: "the Ollama model registry" },
] as const;

/** The catch-all rule every other non-loopback host matches (default-deny). */
export const DEFAULT_DENY_NOTE =
  "proof-environment default-deny: every non-loopback host is denied for the AnythingLLM application runtime (only the local Zeck adapter and the server↔collector loopback are reachable)";

export interface EgressProxy {
  readonly port: number;
  readonly url: string;
  /** Every recorded violation (in order). */
  violations: () => readonly EgressViolation[];
  /** The framework-vocabulary observation (deny mode). */
  observation: () => EgressObservation;
  close(): void;
}

const encoder = new TextEncoder();

/** Create the default-deny egress proxy on a loopback port. */
export async function createEgressProxy(): Promise<EgressProxy> {
  const recorded: EgressViolation[] = [];
  const now = () => new Date().toISOString();

  const ruleFor = (host: string): { hostPattern: string; note: string } => {
    for (const rule of PROOF_EGRESS_DENY_RULES) {
      if (hostMatchesPattern(host, rule.hostPattern)) {
        return rule;
      }
    }
    return { hostPattern: "*", note: DEFAULT_DENY_NOTE };
  };

  const deny = (host: string, urlForEvidence: string): Uint8Array => {
    const rule = ruleFor(host);
    recorded.push({
      host,
      url: redact(urlForEvidence),
      rule: rule.note,
      at: now(),
      blocked: true,
    });
    const body = JSON.stringify({
      error: {
        message: `direct-provider egress denied: ${host} matched deny rule "${rule.note}" (proof-environment egress control)`,
        type: "egress_blocked",
      },
    });
    const head =
      `HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n`;
    return encoder.encode(head + body);
  };

  const listener = createServer((socket: Socket) => {
    socket.on("data", (data: Buffer) => {
      const text = data.toString("utf8").slice(0, 2048);
      const firstLine = text.split("\r\n", 1)[0] ?? "";
      // CONNECT host:port HTTP/1.1 (https tunneling)
      const connectMatch = /^CONNECT\s+(\S+)\s+HTTP\//i.exec(firstLine);
      if (connectMatch !== null) {
        const target = connectMatch[1] ?? "";
        const host = target.replace(/:\d+$/, "");
        socket.write(deny(host, `https://${target}/`));
        socket.end();
        return;
      }
      // GET http://host/path HTTP/1.1 (absolute-URI plain http proxying)
      const absoluteMatch = /^(?:GET|POST|PUT|DELETE|PATCH|HEAD)\s+https?:\/\/(\S+)\s+HTTP\//i.exec(
        firstLine,
      );
      if (absoluteMatch !== null) {
        const target = absoluteMatch[1] ?? "";
        const host = target.replace(/\/.*$/, "").replace(/:\d+$/, "");
        socket.write(deny(host, `http://${target}`));
        socket.end();
        return;
      }
      // Anything else proxied here is still denied (default-deny).
      socket.write(deny("(opaque)", "(opaque request target)"));
      socket.end();
    });
    socket.on("error", () => socket.end());
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve());
  });

  return {
    get port() {
      return (listener.address() as { port: number }).port;
    },
    get url() {
      return `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
    },
    violations: () => [...recorded],
    observation: () => {
      if (recorded.length === 0) {
        return { mode: "deny", status: "observed-clean", violations: [] };
      }
      // Deny mode with every violation blocked (the proxy never passes).
      return { mode: "deny", status: "provably-blocked", violations: [...recorded] };
    },
    close() {
      listener.close();
    },
  };
}

/** Redact to origin + path (queries never enter evidence). */
function redact(target: string): string {
  try {
    const parsed = new URL(target);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparseable request target)";
  }
}
