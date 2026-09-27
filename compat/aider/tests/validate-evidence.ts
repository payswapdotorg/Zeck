import { readFileSync } from "node:fs";
import {
  validateCompatibilityEvidenceRecord,
  evaluateCompatibility,
  type CompatibilityEvidenceRecord,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";

const file = JSON.parse(readFileSync("deploy/evidence/ppr-018.json", "utf8")) as {
  evidenceRecord: CompatibilityEvidenceRecord;
  derivedAssessment: { status: string };
};
const issues = validateCompatibilityEvidenceRecord(file.evidenceRecord);
console.log("structural issues:", issues.length === 0 ? "NONE (valid)" : JSON.stringify(issues, null, 2));

// Re-derive the status from the record + the graph's inventory (fresh derivation).
const { AIDER_DISCOVERED_INVENTORY } = await import("../graph/execution-graph");
const assessment = evaluateCompatibility(file.evidenceRecord, AIDER_DISCOVERED_INVENTORY as DiscoveredEdgeInventory);
console.log("re-derived status:", assessment.status);
console.log("rules:", assessment.ruleResults.map((r) => `${r.ruleId}=${r.satisfied}`).join("\n         "));
console.log("findings:", assessment.findings.length, "static:", assessment.staticFindings.length);

// Secret scan: no credential-shaped values (the supply auth) may appear.
const text = readFileSync("deploy/evidence/ppr-018.json", "utf8");
const supply = JSON.parse(readFileSync("/etc/.z-ai-config", "utf8")) as Record<string, string>;
let leaks = 0;
for (const [key, value] of Object.entries(supply)) {
  if (key === "baseUrl") continue; // the endpoint host is disclosed by design
  if (typeof value === "string" && value.length > 3 && text.includes(value)) {
    console.log("SECRET LEAK:", key);
    leaks += 1;
  }
}
console.log("secret scan:", leaks === 0 ? "CLEAN (no supply credential values present)" : `${leaks} LEAK(S)`);
