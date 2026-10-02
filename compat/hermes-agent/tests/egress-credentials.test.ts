/**
 * PPR-022 egress + credential-erasure tests — the scrubbed Hermes runtime
 * environment carries no provider credential BY CONSTRUCTION, the
 * certified config's only credential-shaped values are the disclosed
 * placeholders, and the proof proxy denies every provider-class host the
 * pinned runtime's fragmented surface graph could reach.
 */

import { describe, expect, test } from "vitest";
import {
  checkProviderCredentialErasure,
} from "../../../src/integrations/compatibility/public";
import { createZeckOnlyEgressControl } from "../../../compat/harness/egress-control";
import {
  PROVIDER_CREDENTIAL_ENV_NAMES,
  scrubbedHermesEnv,
  writeHermesConfig,
} from "../harness/corpus-runner";
import { createEgressProxy, PROOF_EGRESS_DENY_RULES } from "../harness/egress-proxy";
import { hostMatchesPattern } from "../../../src/integrations/compatibility/public";
import { CORPUS_TASKS, CORPUS_API_KEY_PLACEHOLDER } from "../corpus/tasks";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SAMPLE_TASK: (typeof CORPUS_TASKS)[number] = CORPUS_TASKS[0]!;

describe("PPR-022 scrubbed runtime environment (ACR-007 §5 erasure)", () => {
  const env = scrubbedHermesEnv({
    proxyUrl: "http://127.0.0.1:39999",
    home: "/tmp/ppr-022-test-home",
    venvPath: "/home/z/my-project/.venv-hermes",
  });

  test("carries NO provider credential name (the allowlist construction)", () => {
    for (const name of PROVIDER_CREDENTIAL_ENV_NAMES) {
      expect(env[name]).toBeUndefined();
    }
  });

  test("passes the harness's own erasure audit (names + presence, never values)", () => {
    const audit = checkProviderCredentialErasure(PROVIDER_CREDENTIAL_ENV_NAMES, {
      has: (name) => env[name] !== undefined,
    });
    expect(audit.erased).toBe(true);
    expect(audit.presentNames).toEqual([]);
  });

  test("routes every non-loopback egress through the deny proxy", () => {
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:39999");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:39999");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
  });

  test("the image-gen key_env placeholder is the literal disclosed value (never a credential)", () => {
    expect(env.HERMES_IMAGE_KEY).toBe(CORPUS_API_KEY_PLACEHOLDER);
    expect(env.HERMES_IMAGE_KEY).toBe("zeck-local-adapter");
  });
});

describe("PPR-022 certified config (the app's own surface)", () => {
  const home = join(tmpdir(), "ppr-022-config-test");
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeHermesConfig(home, "http://127.0.0.1:39998/v1", SAMPLE_TASK);

  test("writes the app's documented config keys only", () => {
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    expect(config).toContain('provider: "custom"');
    expect(config).toContain("base_url: \"http://127.0.0.1:39998/v1\"");
    expect(config).toContain("provider: main");
    expect(config).toContain("provider: openai");
  });

  test("every auxiliary task is pinned to the main (delegated) chain", () => {
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    // Count the auxiliary provider pins.
    const pins = config.match(/provider: main/g) ?? [];
    expect(pins.length).toBeGreaterThanOrEqual(6);
    expect(config).toContain("background_review:");
    expect(config).toContain("enabled: false");
  });

  test("the only credential-shaped values are the disclosed placeholders", () => {
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    const keyLines = config.match(/api_key:.*$/gm) ?? [];
    // Two disclosed placeholder lines: tts.openai.api_key and
    // stt.openai.api_key (the STT surface needs its own sub-block —
    // live-verified; the shared resolution refuses to construct a
    // client without it).
    expect(keyLines.length).toBe(2);
    for (const line of keyLines) {
      expect(line).toContain(CORPUS_API_KEY_PLACEHOLDER);
    }
  });
});

describe("PPR-022 proof egress proxy (default-deny)", () => {
  test("the deny labels cover the pinned runtime's fragmented provider classes", () => {
    const patterns = PROOF_EGRESS_DENY_RULES.map((rule) => rule.hostPattern);
    for (const expected of [
      "api.openai.com",
      "openrouter.ai",
      "portal.nousresearch.com",
      "queue.fal.run",
      "speech.platform.bing.com",
      "api.elevenlabs.io",
      "api.minimax.io",
      "internal-api.z.ai",
      "api.deepinfra.com",
      "api.exa.ai",
    ]) {
      expect(patterns).toContain(expected);
    }
  });

  test("a direct CONNECT to a provider host is denied and recorded as a blocked violation", async () => {
    const proxy = await createEgressProxy();
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const net = require("node:net") as typeof import("node:net");
        const socket = net.connect(proxy.port, "127.0.0.1");
        socket.on("error", reject);
        let seen = "";
        socket.on("data", (chunk: Buffer) => {
          seen += chunk.toString("utf8");
          if (seen.includes("403 Forbidden")) {
            socket.end();
            resolve(seen);
          }
        });
        socket.write("CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n");
        setTimeout(() => reject(new Error("no proxy response")), 5000);
      });
      expect(response).toContain("403 Forbidden");
      const violation = proxy.violations().find((v) => v.host === "api.openai.com");
      expect(violation).toBeDefined();
      expect(violation?.blocked).toBe(true);
      expect(proxy.observation().mode).toBe("deny");
      expect(proxy.observation().status).toBe("provably-blocked");
    } finally {
      proxy.close();
    }
  });

  test("an absolute-URI http request to the supply host is denied (the platform-side BYOK endpoint must not be reachable)", async () => {
    const proxy = await createEgressProxy();
    try {
      const response = await new Promise<string>((resolve, reject) => {
        const net = require("node:net") as typeof import("node:net");
        const socket = net.connect(proxy.port, "127.0.0.1");
        socket.on("error", reject);
        let seen = "";
        socket.on("data", (chunk: Buffer) => {
          seen += chunk.toString("utf8");
          if (seen.includes("403 Forbidden")) {
            socket.end();
            resolve(seen);
          }
        });
        socket.write("GET http://internal-api.z.ai/v1/models HTTP/1.1\r\nHost: internal-api.z.ai\r\n\r\n");
        setTimeout(() => reject(new Error("no proxy response")), 5000);
      });
      expect(response).toContain("403 Forbidden");
      const violation = proxy.violations().find((v) => v.host === "internal-api.z.ai");
      expect(violation).toBeDefined();
      expect(violation?.blocked).toBe(true);
    } finally {
      proxy.close();
    }
  });

  test("the harness's Zeck-only egress control refuses to allowlist a provider-class host", () => {
    expect(() =>
      createZeckOnlyEgressControl({
        zeckApiBaseUrl: "http://127.0.0.1:9",
        mode: "deny",
        fetchImpl: fetch,
        now: () => new Date().toISOString(),
        extraAllowHosts: [{ hostPattern: "api.openai.com", note: "must be refused" }],
      }),
    ).toThrowError(/never carry a direct provider host/);
  });

  test("the host pattern matcher covers the wildcard classes", () => {
    expect(hostMatchesPattern("api.openai.com", "api.openai.com")).toBe(true);
    expect(hostMatchesPattern("v2.api.openai.com", "*.openai.com")).toBe(true);
    expect(hostMatchesPattern("other.example", "*.openai.com")).toBe(false);
  });
});

describe("PPR-022 corpus fixtures", () => {
  test("the corpus's declared assets exist", () => {
    const root = process.cwd();
    expect(existsSync(join(root, "compat/hermes-agent/corpus/assets/orange-swatch.png"))).toBe(true);
    expect(existsSync(join(root, "compat/hermes-agent/corpus/assets/known-phrase.wav"))).toBe(true);
  });

  test("the corpus is the six-task multi-surface set", () => {
    expect(CORPUS_TASKS.map((task) => task.taskId)).toEqual([
      "implement-edit",
      "vision-qa",
      "context-compaction",
      "speak-text",
      "transcribe-memo",
      "generate-image",
    ]);
  });
});
