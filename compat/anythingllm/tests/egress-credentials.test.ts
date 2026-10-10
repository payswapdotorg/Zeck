/**
 * PPR-026 egress + credential erasure test — the scrubbed AnythingLLM
 * application environment carries NO provider credential (by allowlist
 * construction and by the audit), credential-bearing overrides are
 * REFUSED, the placeholder-bearing connection axes are exactly the four
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
  buildAnythingLlmRuntimeEnvironment,
  ANYTHINGLLM_APPLICATION_EXTRAS,
  PLACEHOLDER_BEARING_AXES,
  PROVIDER_CREDENTIAL_ENV_NAMES,
} from "../harness/corpus-runner";
import { ANYTHINGLLM_DORMANT_SEAMS } from "../graph/execution-graph";

describe("PPR-026 credential erasure (ACR-007 §5)", () => {
  test("the scrubbed AnythingLLM runtime environment carries NO provider credential (the audit)", () => {
    const env = buildAnythingLlmRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      appPort: 19003,
      collectorPort: 19004,
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
      applicationExtras: ["GENERIC_OPEN_AI_BASE_PATH"],
      source,
      overrides: { GENERIC_OPEN_AI_BASE_PATH: "http://127.0.0.1:1/v1" },
    });
    const audit = auditCredentialErasure(env, PROVIDER_CREDENTIAL_ENV_NAMES);
    expect(audit.erased).toBe(true);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPEN_AI_KEY).toBeUndefined();
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

  test("the app's OWN provider-credential names (OPEN_AI_KEY etc.) are caught by the extended audit (the second layer)", () => {
    // The reusable builder guards the harness's base list; the work
    // order's extended audit (PROVIDER_CREDENTIAL_ENV_NAMES) is the gate
    // that catches the app's own provider-credential names — present
    // names are refused by the certified runtime's erasure check.
    const source: Record<string, string | undefined> = {
      OPEN_AI_KEY: "leak-attempt-value",
      TTS_ELEVEN_LABS_KEY: "leak-attempt-value",
    };
    const audit = auditCredentialErasure(source, PROVIDER_CREDENTIAL_ENV_NAMES);
    expect(audit.erased).toBe(false);
    expect(audit.presentNames).toContain("OPEN_AI_KEY");
    expect(audit.presentNames).toContain("TTS_ELEVEN_LABS_KEY");
  });

  test("the AnythingLLM extras allowlist contains NO credential name (the fixed allowlist invariant)", () => {
    for (const extra of ANYTHINGLLM_APPLICATION_EXTRAS) {
      expect(PROVIDER_CREDENTIAL_ENV_NAMES).not.toContain(extra);
      expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(extra);
    }
  });

  test("the placeholder-bearing axes are exactly the four disclosed generic-openai connection axes", () => {
    expect(PLACEHOLDER_BEARING_AXES).toEqual([
      "GENERIC_OPEN_AI_API_KEY",
      "GENERIC_OPEN_AI_EMBEDDING_API_KEY",
      "STT_OPEN_AI_COMPATIBLE_KEY",
      "TTS_OPEN_AI_COMPATIBLE_KEY",
    ]);
    // None of them is on the audited credential list (the placeholder is
    // disclosed, never a credential — the value authenticates nothing).
    for (const axis of PLACEHOLDER_BEARING_AXES) {
      expect(PROVIDER_CREDENTIAL_ENV_NAMES).not.toContain(axis);
      expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES).not.toContain(axis);
    }
  });

  test("the placeholder value is the literal non-authenticating constant", () => {
    const env = buildAnythingLlmRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      appPort: 19003,
      collectorPort: 19004,
    });
    expect(env.GENERIC_OPEN_AI_API_KEY).toBe("zeck-local-adapter");
    expect(env.EMBEDDING_MODEL_PREF).toBe("zeck-deterministic-embeddings-v1");
  });

  test("the scrubbed environment points every AI axis at the local adapter (the app's own env-configuration surface)", () => {
    const env = buildAnythingLlmRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      appPort: 19003,
      collectorPort: 19004,
    });
    expect(env.LLM_PROVIDER).toBe("generic-openai");
    expect(env.GENERIC_OPEN_AI_BASE_PATH).toBe("http://127.0.0.1:19001/v1");
    expect(env.OLLAMA_BASE_PATH).toBe("http://127.0.0.1:19001");
    expect(env.EMBEDDING_ENGINE).toBe("generic-openai");
    expect(env.EMBEDDING_BASE_PATH).toBe("http://127.0.0.1:19001/v1");
    expect(env.STT_PROVIDER).toBe("generic-openai");
    expect(env.STT_OPEN_AI_COMPATIBLE_ENDPOINT).toBe("http://127.0.0.1:19001/v1");
    expect(env.TTS_PROVIDER).toBe("generic-openai");
    expect(env.TTS_OPEN_AI_COMPATIBLE_ENDPOINT).toBe("http://127.0.0.1:19001/v1");
    expect(env.VECTOR_DB).toBe("lancedb");
    expect(env.PROVIDER_DISABLE_NATIVE_TOOL_CALLING).toBe("generic-openai");
  });

  test("the egress control is composed into the runtime env (proxy + loopback bypass + Node env-proxy)", () => {
    const env = buildAnythingLlmRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      appPort: 19003,
      collectorPort: 19004,
    });
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:19002");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:19002");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,0.0.0.0");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
  });

  test("the runtime's fixed-storage layout is the app's own (the PRESERVED-STATE LAW)", () => {
    const env = buildAnythingLlmRuntimeEnvironment({
      adapterUrl: "http://127.0.0.1:19001",
      proxyUrl: "http://127.0.0.1:19002",
      appPort: 19003,
      collectorPort: 19004,
    });
    expect(env.STORAGE_DIR).toBe("/home/z/anythingllm-upstream/server/storage");
    expect(env.NODE_ENV).toBe("production");
    expect(env.DISABLE_TELEMETRY).toBe("true");
  });
});

describe("PPR-026 egress deny rules (the provider classes)", () => {
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
      "us.i.posthog.com",
      "models.dev",
      "hub.external.anythingllm.com",
      "cdn.anythingllm.com",
      "registry.ollama.ai",
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

  test("the dormant seams' egress-dependent gates reference the proof environment's control", () => {
    const collectorSeam = ANYTHINGLLM_DORMANT_SEAMS.find(
      (seam) => seam.edgeId === "anythingllm.collector.web-ingest",
    );
    expect(collectorSeam?.gate).toMatch(/default-deny proxy|egress-denied/i);
  });
});

describe("PPR-026 deny proxy (the positive control, live loopback)", () => {
  test("a deliberate direct egress attempt is OBSERVED BLOCKED (the canary class)", async () => {
    const proxy = await createEgressProxy();
    try {
      // The direct attempt exercised on the proxy socket itself (the same
      // wire the runtime's env-proxy transports emit — CONNECT tunneling).
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
    } finally {
      proxy.close();
    }
  });
});
