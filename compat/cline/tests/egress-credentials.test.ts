/**
 * PPR-019 proof-environment control tests — the egress policy (named
 * rules, catch-all, loopback), the credential scrub (the env the Cline
 * child runs with), and the seeded runtime configuration (the
 * openai-compatible provider entry pointing at the Zeck adapter with
 * the literal placeholder credential).
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { hostMatchesPattern } from "../../../src/integrations/compatibility/public";
import {
  DEFAULT_DENY_NOTE,
  denyRuleFor,
  isLoopbackHost,
  PROOF_EGRESS_DENY_RULES,
  SCRUBBED_CREDENTIAL_ENV_VARS,
} from "../harness/egress-policy";
import { scrubbedChildEnv } from "../harness/runtime-spawn";
import {
  CLINE_PROVIDER_ID,
  readSeededProviderSettings,
  seedClineRuntimeConfig,
  ZECK_ADAPTER_API_KEY_PLACEHOLDER,
} from "../harness/cline-config";

describe("PPR-019 egress policy", () => {
  test("the named deny rules match the direct AI-provider egress class", () => {
    for (const host of [
      "api.openai.com",
      "api.anthropic.com",
      "openrouter.ai",
      "api.groq.com",
      "internal-api.z.ai",
      "models.dev",
      "us.i.posthog.com",
    ]) {
      const rule = denyRuleFor(host, hostMatchesPattern);
      expect(rule.note).not.toBe(DEFAULT_DENY_NOTE);
    }
  });

  test("an unknown host falls to the default-deny catch-all", () => {
    const rule = denyRuleFor("some-random-llm-vendor.example", hostMatchesPattern);
    expect(rule.note).toBe(DEFAULT_DENY_NOTE);
    expect(rule.hostPattern).toBe("*");
  });

  test("the loopback exception covers the adapter endpoint hosts (with and without IPv6)", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("api.openai.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });

  test("the deny rules use the PPR-017 framework's own matching semantics", () => {
    // exact
    expect(hostMatchesPattern("api.openai.com", "api.openai.com")).toBe(true);
    // wildcard subdomain
    expect(hostMatchesPattern("api.openrouter.ai", "*.openrouter.ai")).toBe(true);
    expect(hostMatchesPattern("openrouter.ai", "*.openrouter.ai")).toBe(false);
    // not matched
    expect(hostMatchesPattern("api.openai.com.evil.example", "api.openai.com")).toBe(false);
  });

  test("the supply endpoint itself is denied for the application runtime (platform-side BYOK material)", () => {
    const rule = denyRuleFor("internal-api.z.ai", hostMatchesPattern);
    expect(rule.note).toContain("platform-side BYOK");
  });

  test("the named rules and scrub list are non-empty and shape-valid", () => {
    expect(PROOF_EGRESS_DENY_RULES.length).toBeGreaterThanOrEqual(20);
    for (const rule of PROOF_EGRESS_DENY_RULES) {
      expect(rule.hostPattern.length).toBeGreaterThan(3);
      expect(rule.note.length).toBeGreaterThan(10);
    }
    expect(SCRUBBED_CREDENTIAL_ENV_VARS).toContain("OPENAI_API_KEY");
    expect(SCRUBBED_CREDENTIAL_ENV_VARS).toContain("ANTHROPIC_API_KEY");
    expect(SCRUBBED_CREDENTIAL_ENV_VARS).toContain("CLINE_API_KEY");
  });
});

describe("PPR-019 credential scrub (the child environment)", () => {
  test("every scrubbed credential variable is removed and the proof env is set", () => {
    const previous: Record<string, string | undefined> = {};
    for (const name of SCRUBBED_CREDENTIAL_ENV_VARS) {
      previous[name] = process.env[name];
      process.env[name] = "must-not-survive";
    }
    try {
      const env = scrubbedChildEnv(
        { configDir: "/tmp/ppr-019-cfg", dataDir: "/tmp/ppr-019-data", adapterBaseUrl: "http://127.0.0.1:9/v1", modelId: "glm-4-plus" },
        "/tmp/ppr-019-egress.jsonl",
      );
      for (const name of SCRUBBED_CREDENTIAL_ENV_VARS) {
        expect(env[name]).toBeUndefined();
      }
      expect(env.CLINE_DIR).toBe("/tmp/ppr-019-cfg");
      expect(env.PPR_019_EGRESS_LOG).toBe("/tmp/ppr-019-egress.jsonl");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  test("extra env passes through (the direct baseline arm's allowance)", () => {
    const env = scrubbedChildEnv(
      { configDir: "/c", dataDir: "/d", adapterBaseUrl: "http://127.0.0.1:9/v1", modelId: "m" },
      "/e",
      { PPR_019_EGRESS_ALLOW: "internal-api.z.ai" },
    );
    expect(env.PPR_019_EGRESS_ALLOW).toBe("internal-api.z.ai");
  });
});

describe("PPR-019 seeded runtime configuration", () => {
  test("the seeded provider entry points at the Zeck adapter with the literal placeholder credential", () => {
    const root = join(tmpdir(), `ppr-019-seed-${Date.now()}`);
    const config = {
      configDir: join(root, "cfg"),
      dataDir: join(root, "data"),
      adapterBaseUrl: "http://127.0.0.1:42421/v1",
      modelId: "glm-4-plus",
    };
    try {
      seedClineRuntimeConfig(config);
      const stored = readSeededProviderSettings(config);
      expect(stored?.version).toBe(1);
      expect(stored?.lastUsedProvider).toBe(CLINE_PROVIDER_ID);
      const entry = stored?.providers[CLINE_PROVIDER_ID];
      expect(entry?.settings.provider).toBe(CLINE_PROVIDER_ID);
      expect(entry?.settings.baseUrl).toBe("http://127.0.0.1:42421/v1");
      expect(entry?.settings.model).toBe("glm-4-plus");
      // The literal placeholder the client-side shape check requires —
      // NOT a credential of any provider (the adapter ignores it).
      expect(entry?.settings.apiKey).toBe(ZECK_ADAPTER_API_KEY_PLACEHOLDER);
      // The global settings disable telemetry and auto-update.
      const global = JSON.parse(
        readFileSync(join(root, "data", "settings", "global-settings.json"), "utf8"),
      ) as { telemetryOptOut?: boolean; autoUpdateEnabled?: boolean };
      expect(global.telemetryOptOut).toBe(true);
      expect(global.autoUpdateEnabled).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a small context window rides the provider settings (the compaction task's seam)", () => {
    const root = join(tmpdir(), `ppr-019-seed-cw-${Date.now()}`);
    const config = {
      configDir: join(root, "cfg"),
      dataDir: join(root, "data"),
      adapterBaseUrl: "http://127.0.0.1:9/v1",
      modelId: "m",
      contextWindow: 9000,
    };
    try {
      seedClineRuntimeConfig(config);
      const stored = readSeededProviderSettings(config);
      expect(stored?.providers[CLINE_PROVIDER_ID]?.settings.contextWindow).toBe(9000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
