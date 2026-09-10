/**
 * The substrate runtime adapter seam (platform substrate-economics
 * plane; WORK-054 / E1.1 charter wave member 4 — ADR-0019, ADR-0020).
 *
 * THE ADAPTER SEAM: every runtime provider adapter (the researched
 * E1.1 provider set plus self-hosted) implements the DECLARED
 * compute/sandbox seam —
 * the frozen `ContainerRuntimeClient` contract of
 * `src/platform/sandbox/runtime-client.ts` (execute exactly a
 * validated, provider-neutral `ContainerConfiguration` under the
 * execution-scoped `runIdentity`) — EXTENDED with the substrate-facts
 * reporting the substrate-economics plane decides on:
 * `observeReadiness`, the neutral readiness probe.
 *
 * Adapters are MECHANISMS, never authorities (architecture invariant
 * 2): an adapter receives ONLY the already-validated neutral
 * configuration and the opaque run identity. There is no field in any
 * adapter shape that can carry a store, a service, a capability, a
 * budget, an authorization, an execution status or a secret VALUE —
 * an adapter is structurally never handed an authority surface
 * (discrimination-proven). Provider specifics live INSIDE the adapter
 * files (the typed provider transport contracts each adapter file
 * declares — the documented provider-API surface it translates); the
 * neutral shapes that cross OUT of an adapter (the run result, the
 * readiness observation, the runtime identity) are vendor-free by
 * construction (discrimination-proven by the vocabulary battery).
 *
 * Warm/snapshot-awareness is decision INPUT, not hidden state
 * (invariant 6): the execution layer selects the substrate from the
 * DECLARED facts; the adapter then uses whatever provider mechanism
 * its composition-time configuration enables (cold create, warm-pool
 * attach, snapshot restore) and REPORTS readiness through the neutral
 * ladder. The provisioning preference is a constructor configuration
 * (the composition root binds descriptor modes to adapter mechanics),
 * never a per-run authority input.
 *
 * Cross-execution identity separation (the WORK-046 container-runner
 * discipline): an adapter that derives EXTERNAL environment identifiers
 * MUST bind the `runIdentity` into the derivation — two different Zeck
 * executions doing identical work carry different run identities and
 * therefore different external environment ids (they can never
 * collapse into one provider environment); a REPLAY of the same
 * logical run re-derives the SAME id and converges idempotently.
 *
 * Failure classification is fail closed everywhere: malformed
 * configurations and unknown/unmappable provider states are PERMANENT
 * typed rejections; transport unreachability and provider busy states
 * are TRANSIENT (the caller's bounded retry budget decides). A
 * missing capability (e.g. no readiness probe configured) is a typed
 * rejection, never a fabricated observation and never a permissive
 * fallback.
 */

import { createHash } from "node:crypto";
import type { IsolationLevel } from "../../execution-ir/constraints";
import type { ContainerConfiguration } from "../../sandbox/container-profile";
import type { ContainerRunOptions, ContainerRuntimeClient } from "../../sandbox/runtime-client";
import { rejectSubstrate, SUBSTRATE_ADAPTER_REF_PATTERN } from "../catalog";
import type { ReadinessObservation } from "../lifecycle";

// ---------------------------------------------------------------------------
// Typed adapter errors (fail closed)
// ---------------------------------------------------------------------------

/** The neutral failure classification (the container-runner discipline). */
export type SubstrateAdapterFailureKind = "transient" | "permanent";

/** The typed, bounded substrate adapter error. */
export class SubstrateAdapterError extends Error {
  readonly failureKind: SubstrateAdapterFailureKind;
  readonly adapterRef: string;

  constructor(adapterRef: string, message: string, failureKind: SubstrateAdapterFailureKind) {
    super(message);
    this.name = "SubstrateAdapterError";
    this.adapterRef = adapterRef;
    this.failureKind = failureKind;
  }
}

// ---------------------------------------------------------------------------
// The adapter seam contract
// ---------------------------------------------------------------------------

/** The readiness probe request (the neutral shape crossing INTO the adapter). */
export interface ReadinessProbeRequest {
  /** The substrate identity being probed (the neutral descriptor id). */
  readonly substrateId: string;
}

/**
 * THE substrate runtime adapter: the declared `ContainerRuntimeClient`
 * seam (run exactly the validated configuration under the run
 * identity) plus the neutral readiness reporting the plane's decision
 * inputs consume.
 */
export interface SubstrateRuntimeAdapter extends ContainerRuntimeClient {
  /**
   * The OPAQUE neutral adapter reference — the composition-root binding
   * key (matches `SubstrateDescriptor.adapterRef`). NEVER a vendor
   * name (CSX-004 discipline).
   */
  readonly adapterRef: string;
  /**
   * The isolation classes this adapter's mechanism can serve (the
   * platform-side isolation ladder — the binding validation refuses a
   * descriptor whose isolation class the adapter cannot serve).
   */
  readonly servesIsolation: readonly IsolationLevel[];
  /**
   * Report the CURRENT readiness of the probed substrate as a NEUTRAL
   * observation (created/scheduled/started/ready at the probe
   * instant). Adapters REPORT; the execution layer decides. A probe
   * capability the adapter does not have is a TYPED failure (never a
   * fabricated observation).
   */
  observeReadiness(request: ReadinessProbeRequest): Promise<ReadinessObservation>;
}

// ---------------------------------------------------------------------------
// Adapter configuration validation (fail closed before any provider call)
// ---------------------------------------------------------------------------

/** The neutral adapter identity validation (the composition-root binding key). */
export function validateAdapterRef(adapterRef: string): string {
  if (typeof adapterRef !== "string" || !SUBSTRATE_ADAPTER_REF_PATTERN.test(adapterRef)) {
    rejectSubstrate("adapter-shape", "adapterRef must be an opaque neutral adapter reference", {
      got: adapterRef,
    });
  }
  return adapterRef;
}

/** Run-option validation (fail closed BEFORE any provider call). */
export function validateAdapterRunOptions(options: ContainerRunOptions, adapterRef: string): void {
  if (typeof options?.runIdentity !== "string" || options.runIdentity.length === 0) {
    throw new SubstrateAdapterError(
      adapterRef,
      "substrate run options require a non-empty runIdentity (the durable execution/sandbox binding)",
      "permanent",
    );
  }
  if (options.runIdentity.length > 256) {
    throw new SubstrateAdapterError(
      adapterRef,
      "runIdentity must be bounded (max 256 characters)",
      "permanent",
    );
  }
  if (
    typeof options?.timeoutMs !== "number" ||
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  ) {
    throw new SubstrateAdapterError(
      adapterRef,
      "substrate run options require a positive integer timeoutMs",
      "permanent",
    );
  }
}

/**
 * Derive the EXTERNAL environment identity from the execution-scoped
 * run identity together with the validated configuration and the
 * admitted timeout — the cross-execution separation discipline:
 * distinct logical runs never collapse into one provider environment;
 * a replay of the same logical run re-derives the same identity.
 */
export function deriveEnvironmentIdentity(
  runIdentity: string,
  configuration: ContainerConfiguration,
  timeoutMs: number,
): string {
  // Deterministic digest over the binding — the exact derivation is an
  // adapter-internal mechanism detail, but the BINDING contract (the
  // identity derivation input set) is the shared container-runner
  // discipline: sha256 over [runIdentity, config, timeoutMs].
  const material = JSON.stringify([runIdentity, configuration, timeoutMs]);
  const digest = createHash("sha256").update(material, "utf8").digest("hex");
  return `zeck-env-${digest.slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// The composition-root binding validation
// ---------------------------------------------------------------------------

/** A declared substrate descriptor's binding requirements (the neutral subset). */
export interface AdapterBindingExpectation {
  readonly adapterRef: string;
  readonly isolation: IsolationLevel;
}

/**
 * Validate the composition-root binding: the adapter's neutral
 * reference must match the descriptor's `adapterRef` AND the adapter's
 * mechanism must serve the descriptor's declared isolation class. A
 * mismatched binding is a typed PERMANENT rejection — never a silent
 * weaker-substitution (an adapter cannot serve a class it does not
 * implement).
 */
export function assertAdapterBinding(
  adapter: SubstrateRuntimeAdapter,
  expectation: AdapterBindingExpectation,
): void {
  if (adapter.adapterRef !== expectation.adapterRef) {
    throw new SubstrateAdapterError(
      adapter.adapterRef,
      `adapter binding mismatch: the descriptor binds adapterRef "${expectation.adapterRef}" but this adapter serves "${adapter.adapterRef}"`,
      "permanent",
    );
  }
  if (!adapter.servesIsolation.includes(expectation.isolation)) {
    throw new SubstrateAdapterError(
      adapter.adapterRef,
      `adapter cannot serve isolation class "${expectation.isolation}" (serves: ${adapter.servesIsolation.join(", ")})`,
      "permanent",
    );
  }
}

// ---------------------------------------------------------------------------
// Neutral output bounding (shared by every adapter)
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES_DEFAULT = 1024 * 1024;

/** Truncate a provider-returned stream to the byte bound on a character boundary. */
export function boundProviderOutput(value: string, maxBytes = MAX_OUTPUT_BYTES_DEFAULT): string {
  const buffered = Buffer.from(value, "utf8");
  if (buffered.length <= maxBytes) {
    return value;
  }
  let slice = buffered.subarray(0, maxBytes);
  while (slice.length > 0 && (slice[slice.length - 1] as number) >= 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  return slice.toString("utf8");
}
