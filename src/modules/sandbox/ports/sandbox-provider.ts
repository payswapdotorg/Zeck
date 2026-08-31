/**
 * Sandbox provider port (sandbox module outbound; WORK-012, ENV-001/002).
 *
 * The provider-neutral RUNTIME contract — the single seam every compute
 * substrate implements. This is the sandbox twin of the agents
 * `AgentProvider` and the models `ModelProvider` discipline: one neutral
 * runtime seam per participant axis, never a collapse into another
 * module's contract. A provider receives a FULLY SANITIZED runtime
 * specification — the immutable admitted snapshot projected onto the
 * execution surface:
 *
 *   - identity: sandbox/application/tenant/execution ids (durable binding);
 *   - the task (argv + EXPLICIT public env — never the ambient host
 *     environment; the runtimes construct the child environment from
 *     these entries ONLY);
 *   - the admitted resource limits (the runtime enforces the time bound;
 *     the service enforces it defensively too);
 *   - the network/filesystem policies (egress allowlist or none; opaque
 *     artifact references — never host paths);
 *   - secret REFERENCES only — there is no field in any runtime shape
 *     that can carry a secret VALUE (materialization stays behind the
 *     connections vault at adapter-dispatch time, per WORK-003 BYOK).
 *
 * The shapes carry no stores, no services, no authorities, and no
 * execution status/transition vocabulary (an adapter is structurally
 * never handed an authority surface or the execution state machine —
 * discrimination M14-class). Provider-specific configuration mechanics
 * live in `src/platform/sandbox/` behind this port.
 */

import type {
  SandboxEnvironmentKind,
  SandboxFilesystemPolicy,
  SandboxNetworkPolicy,
  SandboxResourceLimits,
} from "../domain/environment";
import type { SandboxFailureClass, SandboxOutcomeClass, SandboxTask } from "../domain/sandbox";

/** The sanitized runtime specification a substrate executes. */
export interface SandboxRuntimeSpec {
  readonly sandboxId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly kind: SandboxEnvironmentKind;
  readonly task: SandboxTask;
  readonly limits: SandboxResourceLimits | null;
  readonly network: SandboxNetworkPolicy;
  readonly filesystem: SandboxFilesystemPolicy;
  /** Mediated secret references (opaque — never values). */
  readonly secretRefs: readonly string[];
}

/** What one runtime execution observed (the sandbox axis only). */
export interface SandboxExecutionObservation {
  readonly outcomeClass: SandboxOutcomeClass;
  /** Digest of the primary output (null when nothing was produced). */
  readonly outputDigest: string | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  /** Runtime-reported actual usage (integer micro-USD; null when unmetered). */
  readonly usageMicroUsd: string | null;
  readonly failure: {
    readonly failureClass: SandboxFailureClass;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/** One compute-substrate runtime adapter (process, container, microVM, …). */
export interface SandboxProvider {
  /** The environment kind this runtime executes (the registry key). */
  readonly runtimeKind: SandboxEnvironmentKind;
  execute(spec: SandboxRuntimeSpec): Promise<SandboxExecutionObservation>;
}

/**
 * The substrate registry (composition wiring): kind → provider. Selection
 * of a provider happens ONLY after admission (the capability gate resolved
 * the declared runtime capability first — capability before provider).
 */
export interface SandboxProviderRegistry {
  register(provider: SandboxProvider): void;
  providerFor(kind: SandboxEnvironmentKind): SandboxProvider | null;
}

/** A simple in-memory registry implementation (composition convenience). */
export function createSandboxProviderRegistry(): SandboxProviderRegistry {
  const providers = new Map<SandboxEnvironmentKind, SandboxProvider>();
  return {
    register(provider) {
      providers.set(provider.runtimeKind, provider);
    },
    providerFor(kind) {
      return providers.get(kind) ?? null;
    },
  };
}
