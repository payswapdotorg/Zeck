/**
 * Unit — sandbox domain: the provider-neutral environment contract and the
 * sandbox execution contracts (WORK-012, ENV-001; acceptance criterion 1
 * and the security-model validation surface).
 *
 * Proves: the kind vocabulary and lifecycle tables; resource-limit
 * validation (mandatory explicit bounds for executing kinds, nothing to
 * bound for no-execution); network policy validation ("open" and empty
 * allowlists are rejected); filesystem policy validation (host-shaped
 * artifact refs rejected); secret references; runtime requirements
 * (mandatory for executing kinds); cost expectations; the sandbox task
 * validation (raw secret rejection in publicEnv — names AND values); the
 * canonical request fingerprint; the status transition table.
 */

import { describe, expect, test } from "vitest";
import {
  canonicalEnvironmentJson,
  canTransitionEnvironment,
  kindExecutes,
  refLooksLikeHostPath,
  SANDBOX_ENVIRONMENT_KINDS,
  validateComputeEnvironmentSpec,
  validateEnvironmentRegistration,
} from "../../../src/modules/sandbox/domain/environment";
import {
  canTransitionSandbox,
  containsRawSecretValue,
  isTerminalSandboxStatus,
  SANDBOX_EXECUTION_STATUSES,
  sandboxRequestFingerprint,
  validateSandboxTask,
} from "../../../src/modules/sandbox/domain/sandbox";

const limits = {
  cpuMilliCores: 500,
  memoryMiB: 128,
  executionTimeoutMs: 30_000,
};

const baseSpec = {
  kind: "process" as const,
  limits,
  network: { egress: "none" as const, allowedHosts: [] },
  filesystem: { workspace: "ephemeral-writable" as const, readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

const noExecutionSpec = {
  kind: "no-execution" as const,
  limits: null,
  network: { egress: "none" as const, allowedHosts: [] },
  filesystem: { workspace: "none" as const, readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: null,
  cost: { estimatedCostMicroUsd: "0" },
};

describe("compute environment spec validation", () => {
  test("the kind vocabulary is the isolation ladder with no-execution first class", () => {
    expect(SANDBOX_ENVIRONMENT_KINDS).toEqual([
      "no-execution",
      "process",
      "container",
      "microvm",
      "vm",
      "customer-runner",
    ]);
    expect(kindExecutes("no-execution")).toBe(false);
    expect(kindExecutes("process")).toBe(true);
    expect(kindExecutes("container")).toBe(true);
  });

  test("a valid process spec passes", () => {
    expect(validateComputeEnvironmentSpec(baseSpec).valid).toBe(true);
  });

  test("a valid container spec with allowlist egress and artifact refs passes", () => {
    const spec = {
      ...baseSpec,
      kind: "container" as const,
      runtime: { capabilityId: "container-runtime" },
      network: { egress: "allowlist" as const, allowedHosts: ["api.example.com"] },
      filesystem: {
        workspace: "ephemeral-writable" as const,
        readOnlyArtifactRefs: ["artifact-1", "uploads/report.pdf"],
      },
      secrets: { secretRefs: ["conn-customer-api"] },
    };
    expect(validateComputeEnvironmentSpec(spec).valid).toBe(true);
  });

  test("a valid no-execution spec passes (limits/runtime/workspace absent)", () => {
    expect(validateComputeEnvironmentSpec(noExecutionSpec).valid).toBe(true);
  });

  test("executing kinds MUST declare limits — missing bounds are never defaulted (M4/M18)", () => {
    const check = validateComputeEnvironmentSpec({ ...baseSpec, limits: null });
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.field)).toContain("limits");
  });

  test("missing REQUIRED limit fields fail (no unlimited host fallback)", () => {
    const check = validateComputeEnvironmentSpec({
      ...baseSpec,
      limits: { cpuMilliCores: 100 } as never,
    });
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.field)).toContain("limits.memoryMiB");
    expect(check.issues.map((i) => i.field)).toContain("limits.executionTimeoutMs");
  });

  test("out-of-range and non-integer limits fail", () => {
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        limits: { ...limits, cpuMilliCores: 0 },
      }).valid,
    ).toBe(false);
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        limits: { ...limits, memoryMiB: 1.5 },
      }).valid,
    ).toBe(false);
  });

  test("no-execution must not declare limits/runtime/workspace/egress/secrets", () => {
    const check = validateComputeEnvironmentSpec({
      ...noExecutionSpec,
      limits,
      runtime: { capabilityId: "process-sandbox" },
    });
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.field)).toContain("limits");
    expect(check.issues.map((i) => i.field)).toContain("runtime");
  });

  test('"open" egress is unrepresentable; empty allowlists and none-with-hosts fail', () => {
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        network: { egress: "open" as never, allowedHosts: [] },
      }).valid,
    ).toBe(false);
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        network: { egress: "allowlist" as const, allowedHosts: [] },
      }).valid,
    ).toBe(false);
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        network: { egress: "none" as const, allowedHosts: ["api.example.com"] },
      }).valid,
    ).toBe(false);
  });

  test("host-shaped artifact references are rejected (M5)", () => {
    for (const bad of [
      "/etc/passwd",
      "/var/run/docker.sock",
      "../../host/secret",
      "~/id_rsa",
      "C:\\Windows\\system32",
      "proc/self/mem",
    ]) {
      expect(refLooksLikeHostPath(bad)).toBe(true);
      const check = validateComputeEnvironmentSpec({
        ...baseSpec,
        filesystem: { workspace: "ephemeral-writable", readOnlyArtifactRefs: [bad] },
      });
      expect(check.valid, bad).toBe(false);
    }
  });

  test("executing kinds MUST declare a runtime capability requirement", () => {
    const check = validateComputeEnvironmentSpec({ ...baseSpec, runtime: null });
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.field)).toContain("runtime");
  });

  test("cost must be a non-negative integer micro-USD string", () => {
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        cost: { estimatedCostMicroUsd: "-1" },
      }).valid,
    ).toBe(false);
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        cost: { estimatedCostMicroUsd: "1.5" },
      }).valid,
    ).toBe(false);
    expect(
      validateComputeEnvironmentSpec({
        ...baseSpec,
        cost: { estimatedCostMicroUsd: "1250" },
      }).valid,
    ).toBe(true);
  });

  test("registration validates identity fields", () => {
    const check = validateEnvironmentRegistration({
      applicationId: "app",
      tenantId: "tenant",
      slug: "Bad_Slug",
      name: "",
      spec: baseSpec,
    });
    expect(check.valid).toBe(false);
    expect(check.issues.map((i) => i.field)).toContain("slug");
    expect(check.issues.map((i) => i.field)).toContain("name");
  });

  test("canonical environment JSON is deterministic under key order", () => {
    const a = canonicalEnvironmentJson(baseSpec);
    const b = canonicalEnvironmentJson({
      cost: baseSpec.cost,
      runtime: baseSpec.runtime,
      secrets: baseSpec.secrets,
      filesystem: baseSpec.filesystem,
      network: baseSpec.network,
      limits: baseSpec.limits,
      kind: baseSpec.kind,
    });
    expect(a).toBe(b);
  });
});

describe("environment lifecycle", () => {
  test("the transition table is small and explicit; retired is terminal", () => {
    expect(canTransitionEnvironment("available", "suspended")).toBe(true);
    expect(canTransitionEnvironment("suspended", "available")).toBe(true);
    expect(canTransitionEnvironment("available", "retired")).toBe(true);
    expect(canTransitionEnvironment("suspended", "retired")).toBe(true);
    expect(canTransitionEnvironment("retired", "available")).toBe(false);
    expect(canTransitionEnvironment("available", "available")).toBe(false);
  });
});

describe("sandbox task validation (the admission-time sanitization gate)", () => {
  const validTask = {
    command: "python3",
    args: ["analyze.py", "--verbose"],
    publicEnv: { MODE: "batch", LOG_LEVEL: "info" },
  };

  test("a clean task passes", () => {
    expect(validateSandboxTask(validTask).valid).toBe(true);
  });

  test("raw secret VALUES are rejected before anything durable (M8)", () => {
    for (const value of [
      "sk-abcdefghijklmnopqrst",
      "AKIAIOSFODNN7EXAMPLE",
      "ghp_abcdefghijklmnopqrst",
      "github_pat_abcdefghijklmnopqrst",
      "xoxb-1234567890abcdef",
      "-----BEGIN RSA PRIVATE KEY-----",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123def456ghi",
      "Bearer abcdefghijklmnop",
      "api_key = verysecretvalue123",
    ]) {
      const check = validateSandboxTask({
        ...validTask,
        publicEnv: { CONFIG: value },
      });
      expect(check.valid, value).toBe(false);
      expect(check.reason).toContain("raw secret");
    }
    expect(containsRawSecretValue("sk-abcdefghijklmnopqrst")).toBe(true);
    expect(containsRawSecretValue("hello world")).toBe(false);
  });

  test("secret-shaped env NAMES are rejected outright (publicEnv is non-secret by contract)", () => {
    for (const name of ["API_KEY", "MY_SECRET", "PASSWORD", "ACCESS_TOKEN", "PRIVATE_KEY"]) {
      const check = validateSandboxTask({
        ...validTask,
        publicEnv: { [name]: "perfectly-innocent-value" },
      });
      expect(check.valid, name).toBe(false);
      expect(check.reason).toContain("secret-shaped");
    }
    expect(validateSandboxTask({ ...validTask, publicEnv: { MODE: "batch" } }).valid).toBe(true);
  });

  test("shell metacharacters in command are rejected (argv discipline)", () => {
    expect(validateSandboxTask({ ...validTask, command: "sh -c 'rm -rf /'" }).valid).toBe(false);
    expect(validateSandboxTask({ ...validTask, command: "" }).valid).toBe(false);
  });
});

describe("sandbox status vocabulary", () => {
  test("the lifecycle is subordinate: denied insert-only, one-shot dispatch, terminal-immutable", () => {
    expect(SANDBOX_EXECUTION_STATUSES).toHaveLength(5);
    expect(canTransitionSandbox("admitted", "dispatching")).toBe(true);
    expect(canTransitionSandbox("dispatching", "completed")).toBe(true);
    expect(canTransitionSandbox("dispatching", "failed")).toBe(true);
    // every escape from the subordinate path is illegal:
    expect(canTransitionSandbox("admitted", "completed")).toBe(false);
    expect(canTransitionSandbox("admitted", "failed")).toBe(false);
    expect(canTransitionSandbox("denied", "admitted")).toBe(false);
    expect(canTransitionSandbox("completed", "dispatching")).toBe(false);
    expect(isTerminalSandboxStatus("denied")).toBe(true);
    expect(isTerminalSandboxStatus("completed")).toBe(true);
    expect(isTerminalSandboxStatus("failed")).toBe(true);
    expect(isTerminalSandboxStatus("admitted")).toBe(false);
  });
});

describe("sandbox request fingerprint", () => {
  test("identical logical requests fingerprint identically; differences differ", () => {
    const executionId = "00000000-0000-7000-8000-0000000000e1";
    const input = {
      executionId,
      environmentId: "00000000-0000-7000-8000-0000000000f1",
      task: { command: "python3", args: ["a"], publicEnv: { A: "1", B: "2" } },
    };
    const same = {
      executionId,
      environmentId: "00000000-0000-7000-8000-0000000000f1",
      task: { command: "python3", args: ["a"], publicEnv: { B: "2", A: "1" } },
    };
    expect(sandboxRequestFingerprint("app", executionId, "actor", input)).toBe(
      sandboxRequestFingerprint("app", executionId, "actor", same),
    );
    expect(sandboxRequestFingerprint("app", executionId, "actor", input)).not.toBe(
      sandboxRequestFingerprint("app", executionId, "actor", {
        ...input,
        task: { ...input.task, args: ["b"] },
      }),
    );
  });
});
