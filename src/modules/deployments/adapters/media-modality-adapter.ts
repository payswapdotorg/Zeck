/**
 * Media modality-adapter bridge (deployments module adapter;
 * WORK-026, AC1/AC2 — binding the media rail into the WORK-023
 * deployment fabric).
 *
 * Bridges a provider-neutral `MediaRail` (the upstream
 * media-generation rail seam) into the deployment fabric's
 * `ModalityChannelAdapter` seam so deployment plans with
 * media-generation channel bindings validate against the rail's
 * declared coverage — the WORK-023 registry discipline (fail-closed:
 * an uncovered binding rejects the plan at validation time, never at
 * job time).
 *
 * The bridge is DESCRIPTIVE ONLY (the MOD-004 discipline): it exposes
 * exactly the non-authoritative `checkBinding`/`describeBinding` duo —
 * the rail's authority-free descriptor projected into the plan
 * validation seam. No admission, budget, capability or execution
 * surface crosses (the shapes make it unrepresentable).
 */

import type { ChannelBinding } from "../domain/plan";
import type { MediaRail } from "../ports/media-rail";
import type { ModalityBindingCheck, ModalityChannelAdapter } from "../ports/modality-adapter";

export function createMediaModalityAdapter(rail: MediaRail): ModalityChannelAdapter {
  return {
    descriptor: {
      adapterCapabilityId: rail.descriptor.railCapabilityId,
      channelKinds: ["web", "webhook"],
    },
    async checkBinding(binding: ChannelBinding): Promise<ModalityBindingCheck> {
      // The media rail serves the media-generation modality: its
      // coverage vocabulary is the GENERATION KINDS (video/image/
      // audio/multimodal), which the plan's profile declares through
      // its output modalities. The binding check validates the
      // channel kind the fabric knows (web/webhook media bindings).
      if (binding.channelKind !== "web" && binding.channelKind !== "webhook") {
        return {
          ok: false,
          reason: `the media rail "${rail.descriptor.railCapabilityId}" does not serve channel kind "${binding.channelKind}"`,
        };
      }
      if (rail.descriptor.generationKinds.length === 0) {
        return {
          ok: false,
          reason: `the media rail "${rail.descriptor.railCapabilityId}" serves no generation kinds`,
        };
      }
      return { ok: true };
    },
    async describeBinding(binding: ChannelBinding) {
      return {
        adapterCapabilityId: rail.descriptor.railCapabilityId,
        channelKind: binding.channelKind,
        transportClass: rail.descriptor.transportClass,
        servedGenerationKinds: [...rail.descriptor.generationKinds],
      };
    },
  };
}
