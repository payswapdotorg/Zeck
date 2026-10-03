/**
 * PPR-023 egress/credentials test — the scrubbed OpenClaw runtime
 * environment is allowlist-only (no provider credential can leak in by
 * construction), the credential env-var NAME list covers OpenClaw's own
 * provider surface, and the deny proxy blocks a direct-provider CONNECT
 * attempt and records the violation in the framework's vocabulary.
 */

import { afterAll, describe, expect, test } from "vitest";
import { connect } from "node:net";
import { scrubbedOpenClawEnv, PROVIDER_CREDENTIAL_ENV_NAMES } from "../harness/corpus-runner";
import { createEgressProxy, PROOF_EGRESS_DENY_RULES, type EgressProxy } from "../harness/egress-proxy";

const proxies: EgressProxy[] = [];

afterAll(() => {
  for (const proxy of proxies) {
    proxy.close();
  }
});

describe("PPR-023 scrubbed runtime environment (credential removal)", () => {
  test("the environment is built from an allowlist (no inherited vars leak in)", () => {
    const env = scrubbedOpenClawEnv({
      proxyUrl: "http://127.0.0.1:8/",
      home: "/tmp/x-home",
      stateDir: "/tmp/x-state",
      configPath: "/tmp/x-config.json",
    });
    const keys = Object.keys(env);
    expect(keys).toContain("PATH");
    expect(keys).toContain("HOME");
    expect(keys).toContain("OPENCLAW_CONFIG_PATH");
    expect(keys).toContain("HTTP_PROXY");
    expect(keys).toContain("NO_PROXY");
    // The inherited environment's stray keys never leak in.
    expect(keys).not.toContain("OPENAI_API_KEY");
    expect(keys).not.toContain("ANTHROPIC_API_KEY");
    expect(keys).not.toContain("ZAI_API_KEY");
  });

  test("the OpenAI-compatible placeholder key is never a real credential value", () => {
    // The scrubbed env carries NO key material at all: the placeholder the
    // config carries authenticates nothing (it lives in the config file,
    // and the adapter ignores it — the value is a literal constant).
    const env = scrubbedOpenClawEnv({
      proxyUrl: "http://127.0.0.1:8/",
      home: "/tmp/x-home",
      stateDir: "/tmp/x-state",
      configPath: "/tmp/x-config.json",
    });
    for (const [name, value] of Object.entries(env)) {
      expect(`${name}=${value}`).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    }
  });

  test("the credential env-var NAME list covers OpenClaw's provider surface (names only, never values)", () => {
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("OPENAI_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("ANTHROPIC_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("ZAI_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("Z_AI_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("FAL_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("ELEVENLABS_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("TAVILY_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("FIRECRAWL_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES).toContain("DASHSCOPE_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_NAMES.length).toBeGreaterThanOrEqual(60);
  });
});

describe("PPR-023 egress deny proxy (default-deny)", () => {
  test("a direct-provider CONNECT attempt is denied and recorded as a blocked violation", async () => {
    const proxy = await createEgressProxy();
    proxies.push(proxy);
    const denied = await new Promise<boolean>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1");
      socket.on("connect", () => {
        socket.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
      });
      socket.on("data", (data: Buffer) => {
        const text = data.toString("utf8");
        resolve(text.startsWith("HTTP/1.1 403"));
        socket.end();
      });
      socket.on("error", () => resolve(false));
    });
    expect(denied).toBe(true);
    const violations = proxy.violations();
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const openai = violations.find((violation) => violation.host === "api.openai.com");
    expect(openai).toBeDefined();
    expect(openai?.blocked).toBe(true);
    expect(openai?.rule).toContain("direct OpenAI provider endpoint");
    // The observation vocabulary: deny mode, provably-blocked.
    const observation = proxy.observation();
    expect(observation.mode).toBe("deny");
    expect(observation.status).toBe("provably-blocked");
  });

  test("an absolute-URI plain-http provider request is denied too", async () => {
    const proxy = await createEgressProxy();
    proxies.push(proxy);
    const denied = await new Promise<boolean>((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1");
      socket.on("connect", () => {
        socket.write("GET http://api.anthropic.com/v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n");
      });
      socket.on("data", (data: Buffer) => {
        const text = data.toString("utf8");
        resolve(text.startsWith("HTTP/1.1 403"));
        socket.end();
      });
      socket.on("error", () => resolve(false));
    });
    expect(denied).toBe(true);
    const anthropic = proxy.violations().find((v) => v.host === "api.anthropic.com");
    expect(anthropic?.blocked).toBe(true);
  });

  test("the supply endpoint is on the deny list (the app runtime must never reach the platform supply)", () => {
    const supplyRule = PROOF_EGRESS_DENY_RULES.find((rule) => rule.hostPattern === "internal-api.z.ai");
    expect(supplyRule).toBeDefined();
    expect(supplyRule?.note).toContain("must not be reachable from the application runtime");
    // The web-search provider class is denied too.
    expect(PROOF_EGRESS_DENY_RULES.some((rule) => rule.hostPattern === "api.tavily.com")).toBe(true);
    expect(PROOF_EGRESS_DENY_RULES.some((rule) => rule.hostPattern === "html.duckduckgo.com")).toBe(true);
  });

  test("a clean proxy that observed nothing reports observed-clean", async () => {
    const proxy = await createEgressProxy();
    proxies.push(proxy);
    const observation = proxy.observation();
    expect(observation.mode).toBe("deny");
    expect(observation.status).toBe("observed-clean");
    expect(observation.violations).toEqual([]);
  });
});
