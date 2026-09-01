/**
 * External substrate operator port (substrate-federation integration
 * outbound; WORK-031, CSX-004).
 *
 * THE replaceable-adapter seam for external compute systems: an
 * operator adapter is consulted for NEUTRAL substrate declarations
 * only — it has no execution, admission, policy or budget surface
 * (the port's shape makes duplicate authorities unrepresentable, the
 * deployment-fabric modality-adapter discipline). Concrete operators
 * (cloud runtimes, GPU fleets, edge fabrics — WORK-027..030's
 * territories) implement this seam behind their own adapters; no
 * vendor SDK crosses the integration boundary.
 */

import type { ExternalSubstrateSubmission } from "../domain/submission";

export interface SubstrateOperatorAdapter {
  /** The neutral operator identity (publisher string, never a vendor SDK). */
  readonly operatorId: string;
  /**
   * List the operator's neutral substrate declarations for an
   * application. The declarations are VALIDATED by the capabilities
   * module's authority before anything durable (fail-closed).
   */
  listSubstrates(applicationId: string): Promise<readonly ExternalSubstrateSubmission[]>;
}
