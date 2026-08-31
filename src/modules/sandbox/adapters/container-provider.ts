/**
 * Container-environment provider adapter (sandbox module; WORK-012, ENV-002).
 *
 * Implements the neutral `SandboxProvider` port for the `container`
 * environment kind — the INITIAL UNTRUSTED-CODE PATH (`spec/requirements.md`
 * ENV-002): the container substrate executes untrusted/general-purpose code
 * behind the full default-deny security profile.
 *
 * The adapter's contract (acceptance criterion 5, adapter-configuration
 * half):
 *
 *   1. it builds the provider-neutral `ContainerConfiguration` from the
 *      admitted runtime spec — the configuration ALWAYS carries the safe
 *      posture (no privileges, no host namespaces, no devices, all caps
 *      dropped, seccomp default, no-new-privileges, non-root, read-only
 *      rootfs, opaque artifact mounts only, explicit env only);
 *   2. it VALIDATES the configuration through the platform escape
 *      validator BEFORE dispatch — an escape-shaped configuration
 *      (privileged, host mounts, host network/PID/IPC, devices, added
 *      capabilities, seccomp off, root, writable rootfs, secret-shaped
 *      env, ambient network) is REJECTED, never repaired into execution;
 *   3. WITHOUT a configured `ContainerRuntimeClient` it FAILS CLOSED —
 *      "isolation guarantees cannot be established" is an honest
 *      `runtime-unavailable` failure, NEVER a permissive fallback to an
 *      unisolated execution (discrimination M18).
 *
 * No container-runtime SDK is a declared dependency in this Work Order;
 * concrete runtimes (Docker/containerd/OCI/fleet runners — WORK-019)
 * implement the platform `ContainerRuntimeClient` seam.
 */

import {
  type ContainerConfiguration,
  type ContainerMount,
  containerConfigurationViolations,
  WORKSPACE_MOUNT_SOURCE,
} from "../../../platform/sandbox/container-profile";
import type { ContainerRuntimeClient } from "../../../platform/sandbox/runtime-client";
import type { SandboxEnvironmentKind } from "../domain/environment";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxRuntimeSpec,
} from "../ports/sandbox-provider";

/** A safe base image for sandboxed execution (composition default). */
export const DEFAULT_SANDBOX_IMAGE = "zeck-sandbox-base:1";

export interface ContainerSandboxProviderOptions {
  /**
   * The configured container runtime client. ABSENT by design: no
   * container runtime ships with this Work Order, and dispatch without a
   * client FAILS CLOSED (M18) rather than executing unisolated.
   */
  readonly client?: ContainerRuntimeClient;
  /** The base image the environment executes in (immutable tag required). */
  readonly image?: string;
}

export class ContainerSandboxProvider implements SandboxProvider {
  readonly runtimeKind: SandboxEnvironmentKind = "container";
  private readonly client: ContainerRuntimeClient | null;
  private readonly image: string;

  constructor(options: ContainerSandboxProviderOptions = {}) {
    this.client = options.client ?? null;
    this.image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  }

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    const limits = spec.limits;
    if (limits === null) {
      return this.failClosed(
        "container environment admitted without resource limits; refusing to execute",
      );
    }

    // ---- 3. The fail-closed substrate check: no client, no execution. ----
    if (this.client === null) {
      return this.failClosed(
        "no container runtime client is configured; container isolation guarantees cannot be established — the sandbox fails closed instead of executing unisolated",
      );
    }

    // ---- 1. Build the configuration with the SAFE posture baked in. -------
    const mounts: ContainerMount[] = [
      ...spec.filesystem.readOnlyArtifactRefs.map((ref) => ({
        source: ref,
        target: `/inputs/${ref}`,
        readOnly: true,
      })),
    ];
    if (spec.filesystem.workspace !== "none") {
      mounts.push({
        source: WORKSPACE_MOUNT_SOURCE,
        target: "/workspace",
        readOnly: spec.filesystem.workspace === "ephemeral-read-only",
      });
    }
    const configuration: ContainerConfiguration = {
      image: this.image,
      command: spec.task.command,
      args: [...spec.task.args],
      env: Object.entries(spec.task.publicEnv).map(([name, value]) => ({ name, value })),
      mounts,
      network: {
        mode: spec.network.egress,
        allowedHosts: [...spec.network.allowedHosts],
      },
      resourceLimits: {
        cpuMilliCores: limits.cpuMilliCores,
        memoryMiB: limits.memoryMiB,
        executionTimeoutMs: limits.executionTimeoutMs,
        ...(limits.storageMiB === undefined ? {} : { storageMiB: limits.storageMiB }),
        ...(limits.processCount === undefined ? {} : { processCount: limits.processCount }),
      },
      // THE default-deny security posture — every field at its safe value.
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

    // ---- 2. Validate BEFORE dispatch: escape-shaped configs are rejected. -
    const violations = containerConfigurationViolations(configuration);
    if (violations.length > 0) {
      return this.failClosed(
        `container configuration violates the sandbox security profile: ${violations.join(", ")}`,
      );
    }

    const result = await this.client.run(configuration, {
      timeoutMs: limits.executionTimeoutMs,
    });
    if (result.timedOut) {
      return {
        outcomeClass: "sandbox-failure",
        outputDigest: null,
        output: { exitCode: result.exitCode, stderr: result.stderr },
        usageMicroUsd: null,
        failure: {
          failureClass: "timeout",
          message: `container exceeded its admitted timeout of ${limits.executionTimeoutMs}ms`,
          retryable: true,
        },
      };
    }
    if (result.exitCode !== 0) {
      return {
        outcomeClass: "sandbox-failure",
        outputDigest: result.stdoutDigest,
        output: { exitCode: result.exitCode, stderr: result.stderr },
        usageMicroUsd: null,
        failure: {
          failureClass: "sandbox-execution",
          message: `container process exited with code ${result.exitCode}`,
          retryable: false,
        },
      };
    }
    return {
      outcomeClass: "sandbox-success",
      outputDigest: result.stdoutDigest,
      output: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        runtimeId: this.client.runtimeId,
      },
      usageMicroUsd: "0",
      failure: null,
    };
  }

  /** The honest fail-closed observation (never a permissive fallback). */
  private failClosed(message: string): SandboxExecutionObservation {
    return {
      outcomeClass: "sandbox-failure",
      outputDigest: null,
      output: null,
      usageMicroUsd: null,
      failure: {
        failureClass: "runtime-unavailable",
        message,
        retryable: false,
      },
    };
  }
}
