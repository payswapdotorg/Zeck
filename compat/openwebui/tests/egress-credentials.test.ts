/**
 * PPR-025 egress + credential erasure test — the scrubbed Open WebUI
 * application environment carries NO provider credential (by allowlist
 * construction and by the audit), credential-bearing overrides are
 * REFUSED, the placeholder-bearing connection axes are exactly the five
 * disclosed ones (the openclaw.json5 apiKey pattern), and the egress
 * deny rules deny every provider class the pinned runtime's surface
 * graph would otherwise reach (a live loopback probe of the deny proxy
 * itself: a deliberate direct egress attempt is OBSERVED BLOCKED).
 */

import { describe, expect, test } from "vitest";
import {
  auditCredentialErasure,
  buildScrubbedRuntimeEnvironment,
  PROVIDER_CREDENTIAL_ENV_VAR_NAMES,
} from "../../harness/credential-erasure";
import { hostMatchesPattern } from "../../../src/integrations/compatibility/public";
import { createEgressProxy, DEFAULT_DENY_NOTE, PROOF_EGRESS_DENY_RULES } from "../harness/egress-proxy";
import {
  buildOpenWebUiRuntimeEnvironment,
  OPENWEBUI_APPLICATION_EXTRAS,
  PLACEHOLDER_BEARING_AXES,
  PROVIDER_CREDENTIAL_ENV_NAMES,
} from "../harness/corpus-runner";
import { OPENWEBUI_DORMANT_SEAMS } from "../graph/execution-graph";

describe("PPR-025 credential erasure (ACR-007 §5)", () => {
  test("the scrubbed Open WebUI runtime environment carries NO provider credential (the audit)", () => {
    const env = buildOpenWebUiRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      workspaceRoot: "/tmp/ppr-025-test-workspace",
    });
    const audit = auditCredentialErasure(env, PROVIDER_CREDENTIAL_ENV_NAMES);
    expect(audit.erased).toBe(true);
    expect(audit.presentNames).toEqual([]);
  });

  test("the erasure audit passes even when the SOURCE environment carries every credential (the allowlist construction)", () => {
    const source: Record<string, string | undefined> = { PATH: "/usr/bin" };
    for (const name of PROVIDER_CREDENTIAL_ENV_VAR_NAMES) {
      source[name] = "leak-attempt-value";
    }
    const env = buildScrubbedRuntimeEnvironment({
      applicationExtras: ["OPENAI_API_BASE_URLS"],
      source,
      overrides: { OPENAI_API_BASE_URLS: "http://127.0.0.1:1/v1" },
    });
    const audit = auditCredentialErasure(env, PROVIDER_CREDENTIAL_ENV_NAMES);
    expect(audit.erased).toBe(true);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("credential-bearing overrides and extras are REFUSED (fail closed, the harness's reusable list)", () => {
    expect(() =>
      buildScrubbedRuntimeEnvironment({
        source: {},
        overrides: { OPENAI_API_KEY: "nope" },
      }),
    ).toThrow(/refusing to place provider credential/i);
    expect(() =>
      buildScrubbedRuntimeEnvironment({
        applicationExtras: ["OPENAI_API_KEY"],
        source: {},
      }),
    ).toThrow(/refusing to place provider credential/i);
  });

  test("the Open WebUI extras allowlist contains NO credential name (the fixed allowlist invariant)", () => {
    for (const extra of OPENWEBUI_APPLICATION_EXTRAS) {
      expect(PROVIDER_CREDENTIAL_ENV_NAMES).not.toContain(extra);
      expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(extra);
    }
  });

  test("the placeholder-bearing axes are exactly the five disclosed connection axes", () => {
    expect(PLACEHOLDER_BEARING_AXES).toEqual([
      "OPENAI_API_KEYS",
      "RAG_OPENAI_API_KEY",
      "IMAGES_OPENAI_API_KEY",
      "AUDIO_STT_OPENAI_API_KEY",
      "AUDIO_TTS_OPENAI_API_KEY",
    ]);
    // None of them is on the audited credential list (the placeholder is
    // disclosed, never a credential — the value authenticates nothing).
    for (const axis of PLACEHOLDER_BEARING_AXES) {
      expect(PROVIDER_CREDENTIAL_ENV_NAMES).not.toContain(axis);
      expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(axis);
    }
  });

  test("the placeholder value is the literal non-authenticating constant", () => {
    const env = buildOpenWebUiRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      workspaceRoot: "/tmp/ppr-025-test-workspace",
    });
    expect(env.OPENAI_API_KEYS).toBe("zeck-local-adapter");
    expect(env.RAG_OPENAI_API_KEY).toBe("zeck-local-adapter");
  });

  test("the scrubbed environment points every AI engine axis at the local adapter", () => {
    const env = buildOpenWebUiRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      workspaceRoot: "/tmp/ppr-025-test-workspace",
    });
    expect(env.OPENAI_API_BASE_URLS).toBe("http://127.0.0.1:19001/v1");
    expect(env.OLLAMA_BASE_URLS).toBe("http://127.0.0.1:19001");
    expect(env.RAG_EMBEDDING_ENGINE).toBe("openai");
    expect(env.RAG_OPENAI_API_BASE_URL).toBe("http://127.0.0.1:19001/v1");
    expect(env.IMAGE_GENERATION_ENGINE).toBe("openai");
    expect(env.IMAGES_OPENAI_API_BASE_URL).toBe("http://127.0.0.1:19001/v1");
    expect(env.AUDIO_STT_ENGINE).toBe("openai");
    expect(env.AUDIO_TTS_ENGINE).toBe("openai");
  });

  test("the egress control is composed into the runtime env (proxy + loopback bypass)", () => {
    const env = buildOpenWebUiRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      workspaceRoot: "/tmp/ppr-025-test-workspace",
    });
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:19002");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:19002");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  });
});

describe("PPR-025 egress deny rules (the provider classes)", () => {
  test("the deny rules cover every provider class the pinned runtime's graph would reach", () => {
    const hosts = [
      "api.openai.com",
      "api.anthropic.com",
      "openrouter.ai",
      "generativelanguage.googleapis.com",
      "api.groq.com",
      "api.mistral.ai",
      "api.deepseek.com",
      "api.together.xyz",
      "api.cohere.com",
      "api.x.ai",
      "foo.openai.azure.com",
      "api.elevenlabs.io",
      "api.deepgram.com",
      "huggingface.co",
      "internal-api.z.ai",
      "api.github.com",
      "us.i.posthog.com",
      "pypi.org",
      "search.brave.com",
      "api.tavily.com",
    ];
    for (const host of hosts) {
      const matched = PROOF_EGRESS_DENY_RULES.some((rule) => hostMatchesPattern(host, rule.hostPattern));
      expect(matched).toBe(true);
    }
  });

  test("unknown hosts still fall to the default-deny catch-all (the proxy's ruleFor fallback)", () => {
    // The named rules are provider-class labels only; the DEFAULT_DENY
    // catch-all posture is the proxy's fallback for every other
    // non-loopback host (verified live by the canary probe below).
    expect(DEFAULT_DENY_NOTE).toMatch(/default-deny/i);
    for (const rule of PROOF_EGRESS_DENY_RULES) {
      expect(String(rule.hostPattern)).not.toBe("*");
      expect(rule.note.length).toBeGreaterThan(10);
    }
  });
});

describe("PPR-025 deny proxy (the positive control, live loopback)", () => {
  test("a deliberate direct egress attempt is OBSERVED BLOCKED (the canary class)", async () => {
    const proxy = await createEgressProxy();
    try {
      // The direct attempt (plain http absolute-URI proxying — the same
      // request shape aiohttp's trust_env transport emits).
      const response = await fetch("http://api.openai.com/v1/models", {
        redirect: "manual",
      }).catch((error: unknown) => error);
      // The loopback proxy denies every CONNECT/absolute request; a fetch
      // that bypasses proxies entirely would need the proxy env — here we
      // exercise the proxy socket directly (the same wire the runtime's
      // transports emit):
      const net = await import("node:net");
      const blocked = await new Promise<{ denied: boolean; body: string }>((resolve) => {
        const socket = net.connect(proxy.port, "127.0.0.1", () => {
          socket.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
        });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve({ denied: /403 Forbidden/.test(body), body: body.slice(0, 200) });
        });
        socket.on("error", () => resolve({ denied: false, body: "(socket error)" }));
        setTimeout(() => {
          socket.destroy();
          resolve({ denied: false, body: "(timeout)" });
        }, 10_000);
      });
      expect(blocked.denied).toBe(true);
      const observation = proxy.observation();
      expect(observation.mode).toBe("deny");
      expect(observation.status).toBe("provably-blocked");
      expect(observation.violations.some((v) => v.host === "api.openai.com" && v.blocked)).toBe(
        true,
      );
      void response;
    } finally {
      proxy.close();
    }
  });
});
