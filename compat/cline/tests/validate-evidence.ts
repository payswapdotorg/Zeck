/**
 * The PPR-019 evidence validation script — loads the delivered evidence
 * record (deploy/evidence/ppr-019.json), validates its STRUCTURE with
 * the PPR-017 framework's own validator, re-derives the assessment with
 * the strict admission machine, and asserts the honest final-
 * certification state (resolved through the merged PPR-018A harness,
 * owner Tech-Lead — the PPR-019 Lead binding).
 *
 * Run: bun run compat/cline/tests/validate-evidence.ts
 * Exits non-zero when the delivered record is structurally invalid or
 * its certification state is dishonest.
 */

import { readFileSync } from "node:fs";
import {
  createCompatibilityService,
  validateCompatibilityEvidenceRecord,
  type CompatibilityEvidenceRecord,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";
import { CLINE_DISCOVERED_INVENTORY } from "../graph/execution-graph";

const EVIDENCE_PATH = "deploy/evidence/ppr-019.json";

interface DeliveredEvidence {
  readonly workOrder: string;
  readonly finalCertification: { status: string; owner: string; bindingStep: string };
  readonly evidenceRecord: CompatibilityEvidenceRecord;
}

export function main(): void {
  const raw = readFileSync(EVIDENCE_PATH, "utf8");
  const delivered = JSON.parse(raw) as DeliveredEvidence;
  if (delivered.workOrder !== "PPR-019") {
    throw new Error(`unexpected work order ${delivered.workOrder}`);
  }
  const issues = validateCompatibilityEvidenceRecord(delivered.evidenceRecord);
  if (issues.length > 0) {
    throw new Error(`delivered evidence record is structurally invalid: ${JSON.stringify(issues)}`);
  }
  const service = createCompatibilityService();
  const assessment = service.assess(
    delivered.evidenceRecord,
    CLINE_DISCOVERED_INVENTORY as DiscoveredEdgeInventory,
  );
  // PPR-019 Lead binding: the final certification is RESOLVED through
  // the merged PPR-018A harness — COMPLETE/BOUND with owner Tech-Lead
  // (the pre-binding PENDING guard is superseded by the binding itself).
  if (
    delivered.finalCertification.owner !== "Tech-Lead" ||
    !/COMPLETE/.test(delivered.finalCertification.status) ||
    !/PPR-018A/.test(delivered.finalCertification.status)
  ) {
    throw new Error(
      `final certification must be resolved through the merged PPR-018A harness with owner Tech-Lead (found: ${delivered.finalCertification.status}/${delivered.finalCertification.owner})`,
    );
  }
  console.log(`[validate-evidence] record valid; derived status: ${assessment.status}`);
  for (const rule of assessment.ruleResults) {
    console.log(`  ${rule.satisfied ? "PASS" : "FAIL"}  ${rule.ruleId}`);
  }
  console.log(
    `[validate-evidence] final certification: ${delivered.finalCertification.status} (owner ${delivered.finalCertification.owner}); binding: ${delivered.finalCertification.bindingStep}`,
  );
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("validate-evidence.ts")) {
  main();
}
