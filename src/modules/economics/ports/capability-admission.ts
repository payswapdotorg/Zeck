/**
 * Economic capability admission port (economics module inbound seam;
 * WORK-032).
 *
 * The capability authority stays singular: an economic action's required
 * capabilities are resolved through THIS REQUIRED port (implemented by
 * the adapter consuming the capabilities module's public registry — the
 * same one-claim-authority pattern the planning module follows) BEFORE
 * any budget reservation or authorization issuance. Unmet requirements
 * fail closed (`CAPABILITY_UNAVAILABLE`) with zero external side effects.
 */

import type { EconomicActionRecord } from "../domain/economic-action";

export interface EconomicCapabilityAdmissionInput {
  readonly action: EconomicActionRecord;
  readonly actorId: string;
}

export interface EconomicCapabilityAdmissionDecision {
  readonly satisfied: boolean;
  /** Unmet requirement names (machine-readable). */
  readonly unmet: readonly string[];
}

export interface EconomicCapabilityAdmissionPort {
  resolve(input: EconomicCapabilityAdmissionInput): Promise<EconomicCapabilityAdmissionDecision>;
}
