/**
 * Substrate-federation integration domain (WORK-031, CSX-004).
 *
 * The external-compute-system submission contract: an external
 * substrate operator's DECLARATION crosses as the capabilities
 * module's provider-neutral `ComputationalSubstrateInput` vocabulary
 * (validated by that module's authority — the integration adds NO
 * second validation regime), plus the neutral operator attribution.
 * Vendor specifics never cross: the adapter reference is opaque; the
 * operator identity is a neutral publisher string.
 */

import type { ComputationalSubstrateInput } from "../../../modules/capabilities/public";

/** An external substrate operator's submission. */
export interface ExternalSubstrateSubmission {
  /** The provider-neutral substrate declaration (CSX-001's contract). */
  readonly substrate: ComputationalSubstrateInput;
  /** Neutral operator attribution (the publisher provenance). */
  readonly operator: string;
}
