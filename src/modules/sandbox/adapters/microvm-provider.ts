/**
 * MicroVM-environment provider adapter (sandbox module; WORK-019, ENV-003).
 *
 * Implements the neutral `SandboxProvider` port for the `microvm`
 * environment kind — a DEDICATED-KERNEL isolation tier (`spec/architecture.md`
 * §15; ADR-0004/0016): stronger isolation than a container for high-risk
 * workloads, expressed provider-neutrally (the isolation CLASS is the
 * contract; no VM vendor, hypervisor or cloud identifier exists anywhere
 * in this file — M14; concrete runtimes implement the
 * `IsolatedImageRuntime` seam behind adapters).
 *
 * The adapter's contract (the container-substrate discipline, restated):
 *
 *   1. it builds the provider-neutral `IsolatedRuntimeRequest` from the
 *      admitted runtime spec — explicit limits, network allowlist or none,
 *      opaque artifact references, explicit env only, secret REFERENCES
 *      only;
 *   2. WITHOUT a configured `IsolatedImageRuntime` client it FAILS CLOSED —
 *      "dedicated-kernel isolation guarantees cannot be established" is an
 *      honest `runtime-unavailable` failure, NEVER a permissive fallback
 *      to a weaker substrate (M18);
 *   3. the tier is pinned: a `microvm`-kind environment can never execute
 *      through a `vm`-tier runtime (and vice versa) — the substrate
 *      matches the declared isolation class exactly.
 */

import type { SandboxEnvironmentKind } from "../domain/environment";
import type {
  IsolatedImageReference,
  IsolatedImageRuntime,
  IsolatedRuntimeRequest,
} from "../ports/isolated-runtime";
import type {
  SandboxExecutionObservation,
  SandboxProvider,
  SandboxRuntimeSpec,
} from "../ports/sandbox-provider";

/** A safe neutral base image for dedicated-kernel sandboxed execution. */
export const DEFAULT_ISOLATED_IMAGE = "zeck-sandbox-isolated-base@1";

export interface MicroVmSandboxProviderOptions {
  /**
   * The configured dedicated-kernel runtime client. ABSENT by design: no
   * concrete microVM runtime ships with this Work Order (vendor runtimes
   * stay behind the neutral seam — M14), and dispatch without a client
   * FAILS CLOSED (M18) rather than executing under weaker isolation.
   */
  readonly client?: IsolatedImageRuntime;
  /** The neutral base image reference (opaque digest-like identifier). */
  readonly image?: string;
}

export class MicroVmSandboxProvider implements SandboxProvider {
  readonly runtimeKind: SandboxEnvironmentKind = "microvm";
  private readonly client: IsolatedImageRuntime | null;
  private readonly image: IsolatedImageReference;

  constructor(options: MicroVmSandboxProviderOptions = {}) {
    this.client = options.client ?? null;
    this.image = { imageRef: options.image ?? DEFAULT_ISOLATED_IMAGE };
  }

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    const limits = spec.limits;
    if (limits === null) {
      return failClosed(
        "microvm environment admitted without resource limits; refusing to execute",
      );
    }
    if (this.client === null) {
      return failClosed(
        "no dedicated-kernel runtime client is configured for the microvm tier; microVM isolation guarantees cannot be established — the sandbox fails closed instead of executing under weaker isolation",
      );
    }
    if (this.client.tier !== "microvm") {
      return failClosed(
        `the configured dedicated-kernel runtime provides the "${this.client.tier}" tier, not "microvm"; the substrate must match the declared isolation class exactly`,
      );
    }
    const request: IsolatedRuntimeRequest = {
      tier: "microvm",
      image: this.image,
      sandboxId: spec.sandboxId,
      applicationId: spec.applicationId,
      tenantId: spec.tenantId,
      executionId: spec.executionId,
      task: spec.task,
      limits,
      network: spec.network,
      filesystem: spec.filesystem,
      secretRefs: [...spec.secretRefs],
    };
    const result = await this.client.execute(request);
    return {
      outcomeClass: result.outcomeClass,
      outputDigest: result.outputDigest,
      output: result.output,
      usageMicroUsd: result.usageMicroUsd,
      failure: result.failure,
    };
  }
}

/** The honest fail-closed observation (never a permissive fallback). */
export function failClosed(message: string): SandboxExecutionObservation {
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
