/**
 * Isolated-image runtime port (sandbox module outbound; WORK-019, ENV-003).
 *
 * The provider-neutral seam behind the `microvm` and `vm` environment
 * kinds: one dedicated-kernel execution substrate that boots an immutable
 * image and executes one task inside explicit resource/network/filesystem
 * bounds. The CONTRACT is provider-neutral by construction — no VM
 * vendor, hypervisor or cloud identifier exists anywhere in this file
 * (M14); concrete runtime mechanics (image boot, device models, snapshot
 * restore) live behind replaceable adapters that implement this port.
 *
 * The port receives the SAME sanitized runtime projection as every other
 * substrate (task argv + explicit public env, explicit limits, network
 * allowlist or none, filesystem refs, secret REFERENCES) plus the neutral
 * image reference — never a host path, never a secret value.
 */

import type {
  SandboxFilesystemPolicy,
  SandboxNetworkPolicy,
  SandboxResourceLimits,
} from "../domain/environment";
import type { SandboxFailureClass, SandboxTask } from "../domain/sandbox";

/** The isolation tier a dedicated-kernel substrate provides. */
export const ISOLATED_IMAGE_TIERS = ["microvm", "vm"] as const;

export type IsolatedImageTier = (typeof ISOLATED_IMAGE_TIERS)[number];

/** A neutral image reference (opaque digest-like identifier, never a host path). */
export interface IsolatedImageReference {
  /** Opaque content reference of the boot image (digest-shaped). */
  readonly imageRef: string;
}

/** The sanitized runtime request for one dedicated-kernel execution. */
export interface IsolatedRuntimeRequest {
  readonly tier: IsolatedImageTier;
  readonly image: IsolatedImageReference;
  readonly sandboxId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly task: SandboxTask;
  readonly limits: SandboxResourceLimits;
  readonly network: SandboxNetworkPolicy;
  readonly filesystem: SandboxFilesystemPolicy;
  /** Mediated secret references (opaque — never values). */
  readonly secretRefs: readonly string[];
}

/** What one dedicated-kernel execution observed (the sandbox axis only). */
export interface IsolatedRuntimeResult {
  readonly outcomeClass: "sandbox-success" | "sandbox-failure";
  readonly outputDigest: string | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly usageMicroUsd: string | null;
  readonly failure: {
    readonly failureClass: SandboxFailureClass;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/**
 * One dedicated-kernel runtime adapter (microVM or VM tier). A NULL/absent
 * client is the honest v1 posture: the provider fails closed with
 * `runtime-unavailable` instead of executing without the required
 * isolation substrate (the container-substrate precedent; vendor runtimes
 * arrive with the owning future Work Orders).
 */
export interface IsolatedImageRuntime {
  /** The isolation tier this runtime provides. */
  readonly tier: IsolatedImageTier;
  execute(request: IsolatedRuntimeRequest): Promise<IsolatedRuntimeResult>;
}
