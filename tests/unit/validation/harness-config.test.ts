/**
 * VAL-002 acceptance criterion 3: app configurations are isolated from
 * secrets and reproducible from repository files plus environment
 * secrets — enforced mechanically (discrimination: secret-shaped
 * values and inline tokens are rejected).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type AppHarnessConfig,
  resolveTransportToken,
  validateAppConfig,
} from "../../../benchmarks/validation/harness";

const REPO_ROOT = join(process.cwd());

const validConfig: AppHarnessConfig = {
  applicationId: "app-123",
  baseUrl: "http://127.0.0.1:8787",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "1111111111111111111111111111111111111111",
  corpusRevision: "2222222222222222222222222222222222222222",
  integrationSurface: "sdk",
  pollIntervalMs: 25,
  completionTimeoutMs: 30000,
};

describe("validation: app harness configuration (VAL-002 AC3)", () => {
  test("a well-formed configuration passes", () => {
    expect(validateAppConfig(validConfig)).toEqual([]);
  });

  test("the repository sample config parses and validates (secret-free)", () => {
    const config = JSON.parse(
      readFileSync(join(REPO_ROOT, "benchmarks/validation/apps/sample/config.json"), "utf8"),
    ) as AppHarnessConfig;
    expect(validateAppConfig(config)).toEqual([]);
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
  });

  test("an inline secret in the token field is rejected (discrimination)", () => {
    const leaked: AppHarnessConfig = {
      ...validConfig,
      tokenEnvVar: "sk-or-v1-892d3157e3474c17aa16a0665453c86a3650c9178554fa9f9d7d05",
    };
    const violations = validateAppConfig(leaked);
    expect(violations.some((v) => v.path === "tokenEnvVar")).toBe(true);
    expect(violations.some((v) => v.reason.includes("secret"))).toBe(true);
  });

  test("a secret-shaped value anywhere in the config is rejected (discrimination)", () => {
    for (const secret of [
      "ghp_4TcbSopE1vxbsOSsAlL1Jpl6rFPLHj4L",
      "sk-proj-OYGAISHz4yTHlYxfAZy1LD",
      "Bearer abcdefghijklmnopqrstuvwxyz123",
    ]) {
      const leaked: Record<string, unknown> = {
        ...validConfig,
        integrationSurface: secret,
      };
      const violations = validateAppConfig(leaked as unknown as AppHarnessConfig);
      expect(violations.some((v) => v.reason.includes("secret-shaped"))).toBe(true);
    }
  });

  test("a malformed base URL is rejected (discrimination)", () => {
    const broken: AppHarnessConfig = { ...validConfig, baseUrl: "not a url" };
    expect(validateAppConfig(broken).some((v) => v.path === "baseUrl")).toBe(true);
  });

  test("the token resolves from the environment at run time (name, never value)", () => {
    expect(resolveTransportToken(validConfig, { ZECK_VALIDATION_TOKEN: "the-secret" })).toBe(
      "the-secret",
    );
    expect(() => resolveTransportToken(validConfig, {})).toThrow(/ZECK_VALIDATION_TOKEN/);
  });
});
