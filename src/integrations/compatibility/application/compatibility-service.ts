/**
 * The compatibility application service — the orchestrator of the
 * non-authoritative proof flow (work order parts A–D).
 *
 * It composes the pure domain pieces into the three proof operations:
 *
 *  - ASSESS: static no-bypass reconciliation (declared graph vs
 *    discovered inventory) + the strict status admission evaluation.
 *    This is the ONLY place a status is ever derived, and it delegates
 *    that to the domain's pure function — the service holds no status
 *    logic of its own.
 *
 *  - CORRELATE: read every delegated edge's Zeck executions THROUGH the
 *    trace source port (the executions public surface adapter, or an
 *    SDK-backed implementation) and produce the durable trace facts the
 *    record carries. Read-only by construction.
 *
 *  - BUILD: construct a structurally valid evidence record (the proof
 *    harness's write path into a record OBJECT — persisting it as a
 *    file is the harness's/Lead's act, not this layer's).
 *
 * The service is NON-AUTHORITATIVE evidence/projection infrastructure:
 * it executes nothing, chooses no providers, owns no budgets and never
 * becomes a second optimizer (ACR-006 Non-goals).
 */

import type { CompatibilityEvidenceRecord, ZeckTraceFact } from "../domain/evidence";
import { validateCompatibilityEvidenceRecord } from "../domain/evidence";
import type { DiscoveredEdgeInventory } from "../domain/execution-graph";
import { validateDiscoveredInventory } from "../domain/execution-graph";
import type { CompatibilityAssessment } from "../domain/status";
import { evaluateCompatibility } from "../domain/status";
import type { ZeckTraceSource } from "../ports/zeck-trace";
import { zeckTraceFactOf } from "../ports/zeck-trace";

export interface CompatibilityServiceOptions {
  /**
   * The Zeck trace source for correlation. OPTIONAL: when absent, the
   * service cannot correlate (correlate() fails closed with a named
   * error) — never a fabricated trace fact.
   */
  readonly traceSource?: ZeckTraceSource;
}

/** A raised, named proof-flow error (fail closed; never silent). */
export class CompatibilityFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompatibilityFlowError";
  }
}

/** Build the compatibility service over its optional trace seam. */
export function createCompatibilityService(options: CompatibilityServiceOptions = {}) {
  const traceSource = options.traceSource;
  return {
    /**
     * Assess one evidence record: static reconciliation + strict
     * admission evaluation. The inventory is the proof's discovered
     * edge inventory (null when discovery never ran — a named defect).
     */
    assess(
      record: CompatibilityEvidenceRecord,
      inventory: DiscoveredEdgeInventory | null = null,
    ): CompatibilityAssessment {
      if (inventory !== null) {
        const issues = validateDiscoveredInventory(inventory);
        if (issues.length > 0) {
          throw new CompatibilityFlowError(
            `invalid discovered inventory: ${issues.map((issue) => issue.issue).join("; ")}`,
          );
        }
      }
      return evaluateCompatibility(record, inventory);
    },

    /**
     * Correlate every delegated edge's declared Zeck executions through
     * the trace source (READ-ONLY): returns the durable trace facts for
     * the record. Fail closed when no trace source is bound.
     */
    async correlate(record: CompatibilityEvidenceRecord): Promise<readonly ZeckTraceFact[]> {
      if (traceSource === undefined) {
        throw new CompatibilityFlowError(
          "no trace source is bound to this compatibility service — correlation is NOT RUN, never fabricated",
        );
      }
      const facts: ZeckTraceFact[] = [];
      for (const disposition of record.dispositions) {
        if (disposition.disposition !== "delegated") {
          continue;
        }
        for (const executionId of disposition.zeckExecutionIds) {
          const read = await traceSource.readExecutionTrace(
            record.pinnedApplication.identity.applicationId,
            executionId,
          );
          facts.push(
            zeckTraceFactOf(
              disposition.edgeId,
              record.pinnedApplication.identity.applicationId,
              executionId,
              read,
            ),
          );
        }
      }
      return facts;
    },

    /**
     * Construct a validated evidence record object (the proof harness's
     * build path). Structural validity is enforced here; the derived
     * status is NEVER a field — assess() derives it from facts.
     */
    buildRecord(record: CompatibilityEvidenceRecord): CompatibilityEvidenceRecord {
      const issues = validateCompatibilityEvidenceRecord(record);
      if (issues.length > 0) {
        throw new CompatibilityFlowError(
          `invalid evidence record: ${issues.map((issue) => `${issue.field}: ${issue.issue}`).join("; ")}`,
        );
      }
      return record;
    },
  };
}

export type CompatibilityService = ReturnType<typeof createCompatibilityService>;
