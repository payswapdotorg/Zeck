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
  /**
   * The durable execution-scoped identity of THIS logical run — the
   * provider composes it from the sanitized runtime spec's binding
   * (application/execution/sandbox ids). REQUIRED (never optional, no
   * default): a runtime that derives an EXTERNAL run identifier MUST
   * bind this identity into the derivation, because the container
   * configuration alone does not identify the work —
   *
   *   - two DIFFERENT executions (or two different sandboxes) doing
   *     identical work MUST NOT collapse into one external run: they
   *     carry different run identities and therefore different
   *     external run ids (cross-execution identity separation);
   *   - a REPLAY of the same logical run (same execution, same
   *     sandbox row, same admitted configuration) carries the SAME
   *     run identity and MUST converge to the SAME external run id
   *     (idempotent re-submission / observation convergence).
   *
   * The identity is provider-neutral and opaque to the runtime: no
   * runner-protocol vocabulary crosses this seam.
   */
  readonly runIdentity: string;
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
  /**
   * Execute exactly the validated configuration (fail closed on
   * errors). The options carry the execution-scoped `runIdentity`
   * (see `ContainerRunOptions`): implementations that derive external
   * run identifiers MUST bind it into the derivation — distinct
   * logical runs never collapse into one external run, and a replay
   * of the same logical run converges to the same external id.
   */
  run(config: ContainerConfiguration, options: ContainerRunOptions): Promise<ContainerRunResult>;
}
