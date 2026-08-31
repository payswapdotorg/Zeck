/**
 * Container runtime client port (platform sandbox seam; WORK-012).
 *
 * The infrastructure seam a CONCRETE container runtime implements:
 * Docker/containerd/Podman/OCI adapters (or a fleet runner — WORK-019)
 * receive a fully-validated provider-neutral `ContainerConfiguration` and
 * execute exactly it. NO implementation ships in this Work Order:
 *
 *   - no container-runtime SDK is a declared dependency
 *     (`IMPLEMENTATION.md` §1 — an SDK may only arrive with its owning
 *     adapter Work Order and the SDK boundary table);
 *   - the sandbox module's container provider therefore fails CLOSED when
 *     no client is configured: "isolation guarantees cannot be
 *     established" is an honest `SANDBOX_ERROR`, never a permissive
 *     fallback to an unisolated execution (discrimination M18 — the
 *     missing guarantee must not translate into a default).
 *
 * The port is provider-neutral by construction: `ContainerConfiguration`
 * (from `container-profile.ts`) carries OCI-shaped CONTROL vocabulary
 * only — no vendor SDK types cross this seam.
 */

import type { ContainerConfiguration } from "./container-profile";

export interface ContainerRunOptions {
  /** The admitted wall-clock bound (the client enforces it too). */
  readonly timeoutMs: number;
}

export interface ContainerRunResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutDigest: string;
  readonly durationMs: number;
}

/**
 * ONE container runtime. `runtimeId` is a provider-neutral identifier of
 * the configured runtime (evidence surface; never a vendor SDK type).
 */
export interface ContainerRuntimeClient {
  readonly runtimeId: string;
  /** Execute exactly the validated configuration (fail closed on errors). */
  run(config: ContainerConfiguration, options: ContainerRunOptions): Promise<ContainerRunResult>;
}
