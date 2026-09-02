/**
 * Realtime modality-adapter bridge (deployments module adapter;
 * WORK-024, AC1/AC2 — binding the realtime rail into the WORK-023
 * deployment fabric).
 *
 * Bridges a provider-neutral `RealtimeRail` (the upstream realtime
 * rail seam) into the deployment fabric's `ModalityChannelAdapter`
 * seam so deployment plans with realtime channel bindings (web /
 * in-app / telephony) validate against the rail's declared coverage —
 * the WORK-023 registry discipline (fail-closed: an uncovered binding
 * rejects the plan at validation time, never at session time).
 *
 * The bridge is DESCRIPTIVE ONLY (the MOD-004 discipline): it exposes
 * exactly the non-authoritative `checkBinding`/`describeBinding` duo —
 * the rail's authority-free descriptor projected into the plan
 * validation seam. No admission, budget, capability or execution
 * surface crosses (the shapes make it unrepresentable).
 */

import type { ChannelBinding } from "../domain/plan";
import type { ModalityBindingCheck, ModalityChannelAdapter } from "../ports/modality-adapter";
import type { RealtimeRail } from "../ports/realtime-rail";

export function createRealtimeModalityAdapter(rail: RealtimeRail): ModalityChannelAdapter {
  return {
    descriptor: {
      adapterCapabilityId: rail.descriptor.railCapabilityId,
      channelKinds: rail.descriptor.channelKinds,
    },
    async checkBinding(binding: ChannelBinding): Promise<ModalityBindingCheck> {
      if (!rail.descriptor.channelKinds.includes(binding.channelKind)) {
        return {
          ok: false,
          reason: `the rail "${rail.descriptor.railCapabilityId}" does not serve channel kind "${binding.channelKind}"`,
        };
      }
      return { ok: true };
    },
    async describeBinding(binding: ChannelBinding) {
      return {
        adapterCapabilityId: rail.descriptor.railCapabilityId,
        channelKind: binding.channelKind,
        transportClass: rail.descriptor.transportClass,
        servedChannelKinds: [...rail.descriptor.channelKinds],
      };
    },
  };
}
