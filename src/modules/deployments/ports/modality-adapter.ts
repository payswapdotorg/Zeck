/**
 * Modality adapter port (deployments module outbound; WORK-023,
 * MOD-004 — the provider-neutral channel/modality seam).
 *
 * THE non-authoritative infrastructure seam: a modality adapter
 * DESCRIBES how a channel binding would be served and validates that
 * it CAN serve it — nothing more. The port's SHAPE makes duplicate
 * authorities unrepresentable (MOD-004's discrimination target):
 *
 *   - there is NO admission, authorization, budget, capability or
 *     execution-transition surface anywhere in the interface — no
 *     invoke/execute/admit/authorize method, no stores, no authority
 *     handles (an adapter is never handed anything beyond the
 *     neutral binding description);
 *   - the adapter is identified by a NEUTRAL capability id and the
 *     channel kinds it serves — vendor rails (WORK-024/025/026)
 *     implement this seam behind their own provider adapters and
 *     NEVER cross vendor identifiers through it;
 *   - binding descriptions returned to callers are neutral metadata
 *     for downstream modality work — session/job binding happens in
 *     the modality work orders under the FULL existing admission
 *     chain.
 */

import type { ChannelBinding } from "../domain/plan";

export interface ModalityAdapterDescriptor {
  /** Provider-neutral adapter identity (e.g. "realtime-channel-adapter"). */
  readonly adapterCapabilityId: string;
  /** The provider-neutral channel kinds this adapter serves. */
  readonly channelKinds: readonly string[];
}

export type ModalityBindingCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ModalityChannelAdapter {
  readonly descriptor: ModalityAdapterDescriptor;
  /**
   * Validate that this adapter can serve the plan's channel binding
   * (neutral metadata only; fail-closed). This is INFRASTRUCTURE
   * capability checking, not admission: the policy/capability/
   * budget authorities decide admission at execution time, unchanged.
   */
  checkBinding(binding: ChannelBinding): Promise<ModalityBindingCheck>;
  /**
   * Neutral binding metadata for downstream modality work
   * (WORK-024/025/026 bind sessions/jobs to deployment identity
   * using this description). Never credentials, never vendor rails.
   */
  describeBinding(binding: ChannelBinding): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * The modality-adapter registry (composition wiring): neutral
 * capability id → adapter. Consulted at plan validation
 * (fail-closed: an uncovered binding rejects the plan) and never at
 * admission/execution time.
 */
export interface ModalityAdapterRegistry {
  register(adapter: ModalityChannelAdapter): void;
  /** Find the adapter serving a capability id, or null. */
  forCapabilityId(adapterCapabilityId: string): ModalityChannelAdapter | null;
  list(): readonly ModalityAdapterDescriptor[];
}

export function createModalityAdapterRegistry(): ModalityAdapterRegistry {
  const byCapabilityId = new Map<string, ModalityChannelAdapter>();
  return {
    register(adapter) {
      byCapabilityId.set(adapter.descriptor.adapterCapabilityId, adapter);
    },
    forCapabilityId(adapterCapabilityId) {
      return byCapabilityId.get(adapterCapabilityId) ?? null;
    },
    list() {
      return [...byCapabilityId.values()].map((adapter) => adapter.descriptor);
    },
  };
}
