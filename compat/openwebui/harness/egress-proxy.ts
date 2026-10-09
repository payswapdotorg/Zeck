/**
 * The PPR-025 egress-deny proxy — the proof-environment egress control
 * wrapping the OPEN WEBUI APPLICATION RUNTIME's outbound traffic (the
 * application under proof), not the Zeck-side harness (whose model-rail
 * supply egress is platform-side BYOK dispatch, exactly as in
 * production; the identical discipline PPR-018..024 established —
 * HTTP_PROXY/HTTPS_PROXY env vars, honored by the aiohttp transports the
 * pinned Open WebUI runtime uses (aiohttp ClientSession(trust_env=True)
 * across routers/openai.py, routers/ollama.py's send_request,
 * retrieval/utils.py, routers/audio.py, routers/images.py).
 *
 * POLICY: default-deny at the TCP level. The Open WebUI application
 * process is configured with HTTP_PROXY/HTTPS_PROXY pointing here and
 * NO_PROXY=127.0.0.1,localhost (the Zeck adapter endpoint is loopback
 * and never proxied). Every proxied request — CONNECT (https tunneling)
 * or absolute-URI (plain http) — is refused and recorded as an
 * EgressViolation in the compatibility framework's own vocabulary
 * (imported from the PPR-017 public barrel: EgressViolation shapes +
 * the hostMatchesPattern matching rule), so the evidence record's
 * egress observation uses the framework's exact shapes.
 *
 * The deny labels name the provider/service classes the pinned Open
 * WebUI runtime's surface graph would otherwise reach directly (the
 * exact multi-surface fragmentation the target matrix flags for this
 * application): the OpenAI-compatible provider defaults, the
 * local-model engine download hosts, the alternative audio/image
 * providers, the search providers, the pipelines service, and the
 * telemetry/version probes.
 *
 * The proxy never forwards anything: it is a deny-only observation
 * point (a proof tool, never a production network policy). A blocked
 * request fails closed — the Open WebUI runtime sees a transport error
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
  { hostPattern: "api.openai.com", note: "direct OpenAI provider endpoint (the OpenAI connection default)" },
  { hostPattern: "*.openai.com", note: "direct OpenAI provider endpoint class" },
  { hostPattern: "api.anthropic.com", note: "direct Anthropic provider endpoint" },
  { hostPattern: "*.anthropic.com", note: "direct Anthropic provider endpoint class" },
  { hostPattern: "openrouter.ai", note: "OpenRouter aggregation rail" },
  { hostPattern: "*.openrouter.ai", note: "OpenRouter aggregation rail" },
  { hostPattern: "generativelanguage.googleapis.com", note: "direct Google AI provider endpoint (Gemini engines)" },
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
  { hostPattern: "huggingface.co", note: "the local-model engine download host (SentenceTransformers/faster-whisper model hub)" },
  { hostPattern: "*.hf.co", note: "the HuggingFace hub endpoint class" },
  { hostPattern: "cdn-lfs.huggingface.co", note: "the HuggingFace model CDN" },
  { hostPattern: "internal-api.z.ai", note: "the sandbox's GLM supply endpoint (platform-side BYOK material — must not be reachable from the application runtime)" },
  { hostPattern: "open.bigmodel.cn", note: "direct Zhipu provider endpoint" },
  { hostPattern: "api.z.ai", note: "direct Z.AI provider endpoint" },
  { hostPattern: "o1137433.ingest.us.sentry.io", note: "the app's sentry telemetry endpoint (disabled by config, denied regardless)" },
  { hostPattern: "*.sentry.io", note: "the sentry telemetry endpoint class" },
  { hostPattern: "us.i.posthog.com", note: "posthog telemetry endpoint (disabled by config, denied regardless)" },
  { hostPattern: "*.posthog.com", note: "posthog telemetry endpoint" },
  { hostPattern: "api.github.com", note: "the release version-check probe (disabled by config, denied regardless)" },
  { hostPattern: "github.com", note: "the release version-check host" },
  { hostPattern: "raw.githubusercontent.com", note: "the update-probe artifact host" },
  { hostPattern: "pypi.org", note: "the tool/function requirements install host (install_frontmatter_requirements — egress-denied in the certified environment)" },
  { hostPattern: "*.pypi.org", note: "PyPI endpoint class" },
  { hostPattern: "files.pythonhosted.org", note: "PyPI package CDN" },
  // The search-provider class (the web-search RAG feature — no provider
  // configured; every known engine's endpoint is named and denied):
  { hostPattern: "search.brave.com", note: "Brave search provider endpoint" },
  { hostPattern: "googlesearch.pythonanywhere.com", note: "the app's default Google-PSE proxy endpoint" },
  { hostPattern: "serpapi.com", note: "SerpAPI search provider endpoint" },
  { hostPattern: "api.serper.dev", note: "Serper search provider endpoint" },
  { hostPattern: "api.tavily.com", note: "Tavily search provider endpoint" },
  { hostPattern: "api.searchapi.io", note: "SearchAPI search provider endpoint" },
  { hostPattern: "api.exa.ai", note: "Exa search provider endpoint" },
  { hostPattern: "api.firecrawl.dev", note: "Firecrawl web-loader endpoint" },
  { hostPattern: "s.jina.ai", note: "Jina reader/search endpoint" },
  { hostPattern: "api.bing.microsoft.com", note: "Bing search provider endpoint" },
  { hostPattern: "duckduckgo.com", note: "DuckDuckGo search endpoint" },
  { hostPattern: "api.perplexity.ai", note: "Perplexity search provider endpoint" },
] as const;

/** The catch-all rule every other non-loopback host matches (default-deny). */
export const DEFAULT_DENY_NOTE =
  "proof-environment default-deny: every non-loopback host is denied for the Open WebUI application runtime (only the local Zeck adapter is reachable)";

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
