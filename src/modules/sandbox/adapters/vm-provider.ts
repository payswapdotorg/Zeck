/**
 * VM-environment provider adapter (sandbox module; WORK-019, ENV-003).
 *
 * Implements the neutral `SandboxProvider` port for the `vm` environment
 * kind — the FULL virtual-machine isolation tier (`spec/architecture.md`
 * §15; ADR-0004/0016): the strongest hosted isolation class for
 * desktop-class or high-risk workloads, expressed provider-neutrally (the
 * isolation CLASS is the contract; no VM vendor, hypervisor or cloud
 * identifier exists anywhere in this file — M14; concrete runtimes
 * implement the `IsolatedImageRuntime` seam behind adapters).
 *
 * Same discipline as the microvm tier (see `microvm-provider.ts`):
 *   1. the neutral `IsolatedRuntimeRequest` is built from the admitted
 *      runtime spec (explicit limits, network allowlist or none, opaque
 *      artifact references, explicit env only, secret REFERENCES only);
 *   2. WITHOUT a configured client it FAILS CLOSED (honest
 *      `runtime-unavailable`, never a weaker-substrate fallback — M18);
 *   3. the tier is pinned: a `vm`-kind environment never executes through
 *      a `microvm`-tier runtime — the substrate matches the declared
 *      isolation class exactly.
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
import { failClosed } from "./microvm-provider";

export interface VmSandboxProviderOptions {
  /**
   * The configured dedicated-kernel runtime client. ABSENT by design: no
   * concrete VM runtime ships with this Work Order (vendor runtimes stay
   * behind the neutral seam — M14), and dispatch without a client FAILS
   * CLOSED (M18) rather than executing under weaker isolation.
   */
  readonly client?: IsolatedImageRuntime;
  /** The neutral base image reference (opaque digest-like identifier). */
  readonly image?: string;
}

export class VmSandboxProvider implements SandboxProvider {
  readonly runtimeKind: SandboxEnvironmentKind = "vm";
  private readonly client: IsolatedImageRuntime | null;
  private readonly image: IsolatedImageReference;

  constructor(options: VmSandboxProviderOptions = {}) {
    this.client = options.client ?? null;
    this.image = { imageRef: options.image ?? DEFAULT_VM_IMAGE };
  }

  async execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation> {
    const limits = spec.limits;
    if (limits === null) {
      return failClosed("vm environment admitted without resource limits; refusing to execute");
    }
    if (this.client === null) {
      return failClosed(
        "no dedicated-kernel runtime client is configured for the vm tier; VM isolation guarantees cannot be established — the sandbox fails closed instead of executing under weaker isolation",
      );
    }
    if (this.client.tier !== "vm") {
      return failClosed(
        `the configured dedicated-kernel runtime provides the "${this.client.tier}" tier, not "vm"; the substrate must match the declared isolation class exactly`,
      );
    }
    const request: IsolatedRuntimeRequest = {
      tier: "vm",
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

/** A safe neutral base image for full-VM sandboxed execution. */
export const DEFAULT_VM_IMAGE = "zeck-sandbox-vm-base@1";
