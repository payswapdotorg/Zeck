/**
 * PPR-020 egress + credential-erasure tests — the default-deny proof
 * proxy (the OpenHands runtime's egress control) and the scrubbed
 * allowlist environment (the credential-removal mechanism), pinned as
 * unit behavior (the live runs are exercised by the battery).
 */

import { connect } from "node:net";
import { describe, expect, test } from "vitest";
import { hostMatchesPattern } from "../../../src/integrations/compatibility/public";
import {
  createEgressProxy,
  DEFAULT_DENY_NOTE,
  PROOF_EGRESS_DENY_RULES,
} from "../harness/egress-proxy";
import {
  OPENHANDS_VENV,
  PROVIDER_CREDENTIAL_ENV_NAMES,
  scrubbedOpenHandsEnv,
} from "../harness/corpus-runner";
import { CORPUS_API_KEY_PLACEHOLDER } from "../corpus/tasks";

describe("PPR-020 default-deny egress proxy", () => {
  test("the proxy refuses an https CONNECT to a direct provider endpoint and records the violation", async () => {
    const proxy = await createEgressProxy();
    const violation = await new Promise((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
      });
      let data = "";
      socket.on("data", (chunk: Buffer) => {
        data += chunk.toString("utf8");
        socket.end();
      });
      socket.on("close", () => resolve(data));
      socket.on("error", () => resolve(data));
    });
    expect(String(violation)).toContain("403");
    expect(String(violation)).toContain("egress_blocked");
    const recorded = proxy.violations();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.host).toBe("api.openai.com");
    expect(recorded[0]?.blocked).toBe(true);
    expect(proxy.observation().status).toBe("provably-blocked");
    expect(proxy.observation().mode).toBe("deny");
    proxy.close();
  });

  test("the proxy refuses an absolute-URI plain-http request (default-deny for unknown hosts)", async () => {
    const proxy = await createEgressProxy();
    await new Promise((resolve) => {
      const socket = connect(proxy.port, "127.0.0.1", () => {
        socket.write("GET http://some-unknown-host.example.com/path HTTP/1.1\r\nHost: x\r\n\r\n");
      });
      socket.on("data", () => socket.end());
      socket.on("close", () => resolve(null));
      socket.on("error", () => resolve(null));
    });
    const recorded = proxy.violations();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.host).toBe("some-unknown-host.example.com");
    expect(recorded[0]?.rule).toBe(DEFAULT_DENY_NOTE);
    proxy.close();
  });

  test("the OpenHands-hosted endpoints are named deny rules (the critic default + observability)", () => {
    const hosts = PROOF_EGRESS_DENY_RULES.map((rule) => rule.hostPattern);
    expect(hosts).toContain("llm-proxy.app.all-hands.dev");
    expect(hosts).toContain("api.lmnr.ai");
    expect(hosts).toContain("internal-api.z.ai");
    expect(hosts).toContain("auth.openai.com");
    for (const rule of PROOF_EGRESS_DENY_RULES) {
      expect(rule.note.length).toBeGreaterThan(0);
    }
  });

  test("the named rules match through the framework's own hostMatchesPattern", () => {
    expect(hostMatchesPattern("api.openai.com", "api.openai.com")).toBe(true);
    expect(hostMatchesPattern("api.anthropic.com", "api.anthropic.com")).toBe(true);
    expect(hostMatchesPattern("internal-api.z.ai", "internal-api.z.ai")).toBe(true);
    expect(hostMatchesPattern("api.openai.com", "openrouter.ai")).toBe(false);
  });
});

describe("PPR-020 scrubbed runtime environment (credential erasure)", () => {
  test("the scrubbed environment is built from an allowlist and carries no provider credentials", () => {
    const env = scrubbedOpenHandsEnv({
      adapterUrl: "http://127.0.0.1:41234/v1",
      proxyUrl: "http://127.0.0.1:41235",
      home: "/tmp/ppr-020-scrub-test",
      venvPath: OPENHANDS_VENV,
    });
    const names = Object.keys(env);
    for (const credentialName of PROVIDER_CREDENTIAL_ENV_NAMES) {
      expect(names).not.toContain(credentialName);
    }
    // The allowlist carries only proof-environment plumbing.
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:41235");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:41235");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    // LiteLLM's local cost map keeps the runtime from any metadata fetch.
    expect(env.LITELLM_LOCAL_MODEL_COST_MAP).toBe("True");
    // The LMNR/OTEL observability gate stays closed (no such env vars).
    expect(names).not.toContain("LMNR_PROJECT_API_KEY");
    expect(names).not.toContain("OTEL_ENDPOINT");
  });

  test("the credential fact list covers the provider seams the inventory identified", () => {
    const names = [...PROVIDER_CREDENTIAL_ENV_NAMES];
    for (const expected of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LMNR_PROJECT_API_KEY", "GRAYSWAN_API_KEY", "CODEX_API_KEY"]) {
      expect(names).toContain(expected);
    }
  });

  test("the corpus api key is the literal placeholder, never a credential", () => {
    expect(CORPUS_API_KEY_PLACEHOLDER).toBe("zeck-local-adapter");
  });
});
