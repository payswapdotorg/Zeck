/**
 * Capability authority port (planning module outbound; WORK-009 / INT-002).
 *
 * The planner consults the WORK-005 capability registry through this seam
 * BEFORE any provider/model selection — capability resolution precedes
 * routing by construction (the adapter wraps the capabilities module's
 * public registry; the planner never sees a rail, a provider or a model
 * from this port).
 */

import type { CapabilityResolution, TaskCapabilityProfile } from "../../capabilities/public";

export interface PlanningCapabilityAuthority {
  resolve(profile: TaskCapabilityProfile): Promise<CapabilityResolution>;
  /** The arbitrated catalog revision consulted (recorded as evidence). */
  readonly catalogRevision: string;
}
