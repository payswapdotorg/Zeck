/**
 * Unit — the platform sandbox seam (WORK-012, ENV-002; acceptance criterion
 * 5 — the adapter-configuration half).
 *
 * Proves:
 *   - the container escape validator rejects EVERY escape-shaped
 *     configuration: privileged, host network/PID/IPC, devices, added
 *     capabilities, capabilities-not-dropped, seccomp off,
 *     no-new-privileges off, root, writable rootfs, HOST-shaped mounts
 *     (the docker socket, /etc, ..traversal, windows drives), ambient
 *     network, secret-shaped env, missing limits (M5/M6/M7/M18);
 *   - the SAFE configuration produced by the container provider passes;
 *   - the process runtime: EXPLICIT env only (the ambient environment is
 *     never inherited — the child cannot see host env vars), argv
 *     discipline (no shell), ephemeral isolated workspace, and the hard
 *     timeout (M1).
 */

import { describe, expect, test } from "vitest";
import { ContainerSandboxProvider } from "../../../src/modules/sandbox/adapters/container-provider";
import type { SandboxRuntimeSpec } from "../../../src/modules/sandbox/ports/sandbox-provider";
import {
  type ContainerConfiguration,
  containerConfigurationViolations,
  mountSourceIsHostPath,
} from "../../../src/platform/sandbox/container-profile";
import { runIsolatedProcess } from "../../../src/platform/sandbox/process-runtime";

const safeConfig: ContainerConfiguration = {
  image: "zeck-sandbox-base:1",
  command: "python3",
  args: ["analyze.py"],
  env: [{ name: "MODE", value: "batch" }],
  mounts: [{ source: "artifact-1", target: "/inputs/artifact-1", readOnly: true }],
  network: { mode: "allowlist", allowedHosts: ["api.example.com"] },
  resourceLimits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
  readOnlyRootfs: true,
  runAsNonRoot: true,
  privileged: false,
  hostNetwork: false,
  hostPid: false,
  hostIpc: false,
  devices: [],
  addedCapabilities: [],
  droppedCapabilities: ["ALL"],
  seccompProfile: "default",
  noNewPrivileges: true,
};

const escapeMutations: ReadonlyArray<
  readonly [string, (c: ContainerConfiguration) => ContainerConfiguration]
> = [
  ["privileged", (c) => ({ ...c, privileged: true })],
  ["host network", (c) => ({ ...c, hostNetwork: true })],
  ["host pid", (c) => ({ ...c, hostPid: true })],
  ["host ipc", (c) => ({ ...c, hostIpc: true })],
  ["devices", (c) => ({ ...c, devices: ["/dev/sda"] })],
  ["added capabilities", (c) => ({ ...c, addedCapabilities: ["SYS_ADMIN"] })],
  ["capabilities not dropped", (c) => ({ ...c, droppedCapabilities: ["NET_RAW"] })],
  ["seccomp disabled", (c) => ({ ...c, seccompProfile: "unconfined" })],
  ["no-new-privileges disabled", (c) => ({ ...c, noNewPrivileges: false })],
  ["runs as root", (c) => ({ ...c, runAsNonRoot: false })],
  ["writable rootfs", (c) => ({ ...c, readOnlyRootfs: false })],
  [
    "docker socket mount",
    (c) => ({
      ...c,
      mounts: [{ source: "/var/run/docker.sock", target: "/sock", readOnly: true }],
    }),
  ],
  [
    "host path mount",
    (c) => ({ ...c, mounts: [{ source: "/etc/passwd", target: "/etc/passwd", readOnly: true }] }),
  ],
  [
    "parent traversal mount",
    (c) => ({ ...c, mounts: [{ source: "../../etc/shadow", target: "/x", readOnly: true }] }),
  ],
  [
    "windows drive mount",
    (c) => ({ ...c, mounts: [{ source: "C:\\Windows\\system32", target: "/x", readOnly: true }] }),
  ],
  ["ambient network", (c) => ({ ...c, network: { mode: "bridge" as never, allowedHosts: [] } })],
  ["empty allowlist network", (c) => ({ ...c, network: { mode: "allowlist", allowedHosts: [] } })],
  [
    "secret-shaped env",
    (c) => ({ ...c, env: [{ name: "MODE", value: "sk-abcdefghijklmnopqrst" }] }),
  ],
  ["missing limits", (c) => ({ ...c, resourceLimits: null as never })],
  [
    "zero limits",
    (c) => ({ ...c, resourceLimits: { cpuMilliCores: 0, memoryMiB: 0, executionTimeoutMs: 0 } }),
  ],
];

describe("container escape validator (adapter configuration half of criterion 5)", () => {
  test("the safe configuration passes with zero violations", () => {
    expect(containerConfigurationViolations(safeConfig)).toEqual([]);
  });

  test.each(escapeMutations)("escape-shaped configuration %s is REJECTED", (_name, mutate) => {
    const violations = containerConfigurationViolations(mutate(safeConfig));
    expect(violations.length).toBeGreaterThan(0);
  });

  test("host-path mount detection covers the canonical escape vectors (M5/M6/M7)", () => {
    expect(mountSourceIsHostPath("/var/run/docker.sock")).toBe(true);
    expect(mountSourceIsHostPath("/")).toBe(true);
    expect(mountSourceIsHostPath("/etc/passwd")).toBe(true);
    expect(mountSourceIsHostPath("~/ssh")).toBe(true);
    expect(mountSourceIsHostPath("../../../root")).toBe(true);
    expect(mountSourceIsHostPath("C:\\host")).toBe(true);
    expect(mountSourceIsHostPath("proc/sys")).toBe(true);
    expect(mountSourceIsHostPath("workspace")).toBe(false);
    expect(mountSourceIsHostPath("artifact-123")).toBe(false);
    expect(mountSourceIsHostPath("uploads/report.pdf")).toBe(false);
  });
});

describe("container provider (the module-side projection)", () => {
  const spec: SandboxRuntimeSpec = {
    sandboxId: "00000000-0000-7000-8000-000000000001",
    applicationId: "00000000-0000-7000-8000-0000000000b1",
    tenantId: "00000000-0000-7000-8000-0000000000a1",
    executionId: "00000000-0000-7000-8000-0000000000e1",
    kind: "container",
    task: { command: "python3", args: ["analyze.py"], publicEnv: { MODE: "batch" } },
    limits: { cpuMilliCores: 1000, memoryMiB: 256, executionTimeoutMs: 60_000 },
    network: { egress: "allowlist", allowedHosts: ["api.example.com"] },
    filesystem: {
      workspace: "ephemeral-writable",
      readOnlyArtifactRefs: ["artifact-input-1"],
    },
    secretRefs: ["conn-customer-api"],
  };

  test("without a runtime client the provider fails closed (M18)", async () => {
    const provider = new ContainerSandboxProvider();
    const observation = await provider.execute(spec);
    expect(observation.outcomeClass).toBe("sandbox-failure");
    expect(observation.failure?.failureClass).toBe("runtime-unavailable");
    expect(observation.failure?.message).toContain("fails closed");
  });

  test("with a client, the provider builds and validates the SAFE configuration", async () => {
    const configurations: ContainerConfiguration[] = [];
    const provider = new ContainerSandboxProvider({
      client: {
        runtimeId: "test-runtime",
        async run(config) {
          configurations.push(config);
          return {
            exitCode: 0,
            timedOut: false,
            stdout: "done",
            stderr: "",
            stdoutDigest: "d",
            durationMs: 12,
          };
        },
      },
    });
    const observation = await provider.execute(spec);
    expect(observation.outcomeClass).toBe("sandbox-success");
    expect(configurations).toHaveLength(1);
    const config = configurations[0] as ContainerConfiguration;
    // the safe posture is baked in:
    expect(config.privileged).toBe(false);
    expect(config.hostNetwork).toBe(false);
    expect(config.hostPid).toBe(false);
    expect(config.hostIpc).toBe(false);
    expect(config.devices).toEqual([]);
    expect(config.addedCapabilities).toEqual([]);
    expect(config.droppedCapabilities).toEqual(["ALL"]);
    expect(config.seccompProfile).toBe("default");
    expect(config.noNewPrivileges).toBe(true);
    expect(config.runAsNonRoot).toBe(true);
    expect(config.readOnlyRootfs).toBe(true);
    // the mounts are the artifact refs + the ephemeral workspace only:
    expect(config.mounts).toEqual([
      { source: "artifact-input-1", target: "/inputs/artifact-input-1", readOnly: true },
      { source: "workspace", target: "/workspace", readOnly: false },
    ]);
    // the environment is the EXPLICIT publicEnv only:
    expect(config.env).toEqual([{ name: "MODE", value: "batch" }]);
    // secret REFERENCES never become values:
    expect(JSON.stringify(config)).not.toContain("conn-customer-api");
  });
});

describe("process runtime (explicit env, no shell, ephemeral workspace, timeout)", () => {
  test("the child receives EXACTLY the explicit env — never the ambient host environment (M1)", async () => {
    const result = await runIsolatedProcess({
      command: process.execPath,
      args: ["-e", "console.log(JSON.stringify(process.env))"],
      env: { EXPLICIT_ONLY: "yes" },
      timeoutMs: 15_000,
      workspace: "ephemeral-writable",
    });
    expect(result.exitCode).toBe(0);
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.keys(childEnv)).toEqual(["EXPLICIT_ONLY"]);
    // the ambient host PATH/Home are structurally absent:
    expect(childEnv.PATH).toBeUndefined();
    expect(childEnv.HOME).toBeUndefined();
  }, 20_000);

  test("argv discipline: no shell interpretation (metacharacters stay literal)", async () => {
    const result = await runIsolatedProcess({
      command: process.execPath,
      args: ["-e", "console.log(process.argv.slice(1).join(' '))", "a;echo pwned", "$HOME"],
      env: {},
      timeoutMs: 15_000,
      workspace: "none",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("a;echo pwned");
    expect(result.stdout).toContain("$HOME");
    expect(result.stdout).not.toContain(require("node:os").homedir());
  }, 20_000);

  test("non-zero exits are honest failures; the timeout kills long runs", async () => {
    const failed = await runIsolatedProcess({
      command: process.execPath,
      args: ["-e", "process.exit(3)"],
      env: {},
      timeoutMs: 15_000,
      workspace: "none",
    });
    expect(failed.exitCode).toBe(3);
    expect(failed.timedOut).toBe(false);

    const timedOut = await runIsolatedProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 60000)"],
      env: {},
      timeoutMs: 300,
      workspace: "none",
    });
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).not.toBe(0);
  }, 20_000);
});
