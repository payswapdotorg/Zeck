/**
 * The PPR-022 egress-deny proxy — the proof-environment egress control
 * wrapping the HERMES RUNTIME's outbound traffic (the application under
 * proof), not the Zeck-side harness (whose model-rail supply egress is
 * platform-side BYOK dispatch, exactly as in production; the identical
 * discipline PPR-018/019/020 established — HTTP_PROXY/HTTPS_PROXY env
 * vars, honored by the httpx transports the openai SDK and Hermes use).
 *
 * POLICY: default-deny at the TCP level. The Hermes subprocess is
 * configured with HTTP_PROXY/HTTPS_PROXY pointing here and
 * NO_PROXY=127.0.0.1,localhost (the Zeck adapter endpoint is loopback
 * and never proxied). Every proxied request — CONNECT (https tunneling)
 * or absolute-URI (plain http) — is refused and recorded as an
 * EgressViolation in the compatibility framework's own vocabulary
 * (imported from the PPR-017 public barrel: EgressViolation shapes +
 * the hostMatchesPattern matching rule), so the evidence record's
 * egress observation uses the framework's exact shapes.
 *
 * The deny labels name the provider/service classes the pinned Hermes
 * runtime's fragmented surface graph would otherwise reach directly
 * (the exact fragmentation the target matrix flags for this
 * application): the aggregator rails, the portal, every specialized
 * media service, and the sandbox's own supply endpoint (which must NOT
 * be reachable from the application runtime — that is the property the
 * proof establishes).
 *
 * The proxy never forwards anything: it is a deny-only observation
 * point (a proof tool, never a production network policy). A blocked
 * request fails closed — the Hermes runtime sees a transport error for
 * every non-loopback egress attempt.
 */

import { createServer, type Socket } from "node:net";
import type {
  EgressObservation,
  EgressViolation,
} from "../../../src/integrations/compatibility/public";
import { hostMatchesPattern } from "../../../src/integrations/compatibility/public";

/** The proxy's named deny rules (opaque patterns + provenance notes). */
export const PROOF_EGRESS_DENY_RULES = [
  {
    hostPattern: "api.openai.com",
    note: "direct OpenAI provider endpoint (AI-provider egress class — chat, audio, images)",
  },
  { hostPattern: "*.openai.com", note: "direct OpenAI provider endpoint class" },
  { hostPattern: "api.anthropic.com", note: "direct Anthropic provider endpoint class" },
  { hostPattern: "openrouter.ai", note: "OpenRouter aggregation rail (the aux auto-chain rung)" },
  { hostPattern: "*.openrouter.ai", note: "OpenRouter aggregation rail" },
  { hostPattern: "api.groq.com", note: "direct Groq provider endpoint (aux chain + STT rung)" },
  { hostPattern: "generativelanguage.googleapis.com", note: "direct Gemini provider endpoint (aux chain + TTS rung)" },
  { hostPattern: "api.mistral.ai", note: "direct Mistral provider endpoint (aux chain + TTS/STT rung)" },
  { hostPattern: "api.deepseek.com", note: "direct DeepSeek provider endpoint" },
  { hostPattern: "api.together.xyz", note: "direct Together provider endpoint" },
  { hostPattern: "api.cohere.com", note: "direct Cohere provider endpoint" },
  { hostPattern: "api.x.ai", note: "direct xAI provider endpoint (TTS/STT/video rungs)" },
  { hostPattern: "api.minimax.io", note: "MiniMax TTS provider endpoint" },
  { hostPattern: "api.minimaxi.com", note: "MiniMax CN TTS provider endpoint" },
  { hostPattern: "api.elevenlabs.io", note: "ElevenLabs speech provider endpoint" },
  { hostPattern: "*.fal.run", note: "FAL.ai media generation endpoint (image/video default)" },
  { hostPattern: "fal.run", note: "FAL.ai media generation endpoint" },
  { hostPattern: "fal.ai", note: "FAL.ai media generation endpoint" },
  { hostPattern: "*.fal.ai", note: "FAL.ai media generation endpoint" },
  { hostPattern: "queue.fal.run", note: "FAL.ai queue API (the in-tree image-gen default path)" },
  { hostPattern: "api.deepinfra.com", note: "DeepInfra media/model endpoint (image/video/STT rung)" },
  { hostPattern: "portal.nousresearch.com", note: "Nous Portal (the aux auto-chain rung + managed gateways)" },
  { hostPattern: "*.nousresearch.com", note: "Nous Research services (portal + managed tool gateways)" },
  { hostPattern: "api.krea.ai", note: "Krea image generation gateway" },
  { hostPattern: "open.bigmodel.cn", note: "direct Zhipu provider endpoint" },
  { hostPattern: "api.meta.ai", note: "Meta AI image generation endpoint" },
  { hostPattern: "speech.platform.bing.com", note: "Edge TTS (Microsoft) — the default TTS provider's endpoint" },
  { hostPattern: "*.api.siliconflow.cn", note: "SiliconFlow provider endpoint" },
  { hostPattern: "internal-api.z.ai", note: "the sandbox's GLM supply endpoint (platform-side BYOK material — must not be reachable from the application runtime)" },
  { hostPattern: "*.github.com", note: "GitHub (skills hub, plugin fetches, version checks)" },
  { hostPattern: "github.com", note: "GitHub (skills hub, plugin fetches)" },
  { hostPattern: "api.exa.ai", note: "Exa web-search provider endpoint" },
  { hostPattern: "api.firecrawl.dev", note: "Firecrawl web-extraction provider endpoint" },
  { hostPattern: "duckduckgo.com", note: "DuckDuckGo search endpoint" },
  { hostPattern: "*.duckduckgo.com", note: "DuckDuckGo search endpoint" },
] as const;

/** The catch-all rule every other non-loopback host matches (default-deny). */
export const DEFAULT_DENY_NOTE =
  "proof-environment default-deny: every non-loopback host is denied for the Hermes runtime (only the local Zeck adapter is reachable)";

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
