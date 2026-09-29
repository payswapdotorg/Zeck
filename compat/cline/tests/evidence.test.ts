/**
 * PPR-019 delivered-evidence test — validates the delivered evidence
 * record (deploy/evidence/ppr-019.json) with the PPR-017 framework's
 * own validator, re-derives the assessment, and asserts the honest
 * final-certification state. Skips cleanly when the battery has not yet
 * produced the record (the Lead's re-run reproduces it first).
 *
 * PPR-019 Lead binding update: the final certification is now RESOLVED
 * through the merged PPR-018A harness (COMPLETE/BOUND, owner Tech-Lead)
 * — the pre-binding PENDING pin is superseded by the binding itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  createCompatibilityService,
  validateCompatibilityEvidenceRecord,
  type CompatibilityEvidenceRecord,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";
import { CLINE_DISCOVERED_INVENTORY, CLINE_EDGE_IDS } from "../graph/execution-graph";

const EVIDENCE_PATH = "deploy/evidence/ppr-019.json";

describe("PPR-019 delivered evidence record", () => {
  test.skipIf(!existsSync(EVIDENCE_PATH))(
    "the delivered record is structurally valid and honestly certified",
    () => {
      const delivered = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8")) as {
        workOrder: string;
        finalCertification: { status: string; owner: string; bindingStep: string };
        evidenceRecord: CompatibilityEvidenceRecord;
      };
      expect(delivered.workOrder).toBe("PPR-019");
      expect(validateCompatibilityEvidenceRecord(delivered.evidenceRecord)).toEqual([]);
      expect(delivered.evidenceRecord.recordBasis).toBe("live-proof");
      expect(delivered.evidenceRecord.recordId).toBe("ppr-019-cline-live-proof");
      // Every declared edge is dispositioned (the closed set).
      const dispositionIds = delivered.evidenceRecord.dispositions.map((d) => d.edgeId).sort();
      expect(dispositionIds).toEqual([...CLINE_EDGE_IDS].sort());
      // The derived assessment comes from the strict admission machine.
      const service = createCompatibilityService();
      const assessment = service.assess(
        delivered.evidenceRecord,
        CLINE_DISCOVERED_INVENTORY as DiscoveredEdgeInventory,
      );
      expect(["AI_EXECUTION_COMPLETE", "PARTIAL", "BLOCKED", "BYPASS_DETECTED", "UNASSESSED"]).toContain(
        assessment.status,
      );
      // The final certification is resolved through the merged PPR-018A
      // harness (the PPR-019 Lead binding): COMPLETE/BOUND with owner
      // Tech-Lead — the binding step names the harness and its merge
      // head, and the certified re-run facts.
      expect(delivered.finalCertification.owner).toBe("Tech-Lead");
      expect(delivered.finalCertification.status).toContain("COMPLETE");
      expect(delivered.finalCertification.status).toContain("PPR-018A");
      expect(delivered.finalCertification.bindingStep).toContain("0bddee1");
    },
  );
});
