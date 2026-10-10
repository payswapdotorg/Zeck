/**
 * PPR-027 hermetic tests — the portfolio aggregation over the nine
 * delivered evidence records and the ACR-007 thin-adapter audit over the
 * frozen compat adapters. Read-only over the delivered artifacts.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditAllSubjectAdapters } from "../adapter-audit";
import { aggregatePortfolio, extractPortfolioFacts } from "../aggregation";

const REPO_ROOT = join(new URL(".", import.meta.url).pathname, "..", "..", "..");

describe("the portfolio aggregation (nine delivered records)", () => {
  const aggregation = aggregatePortfolio();

  it("reads exactly the nine delivered records", () => {
    expect(aggregation.records).toHaveLength(9);
    expect(aggregation.records.map((record) => record.subjectId)).toEqual([
      "aider",
      "cline",
      "openhands",
      "continue",
      "hermes-agent",
      "openclaw",
      "browser-use",
      "openwebui",
      "anythingllm",
    ]);
  });

  it("tallies eight AI_EXECUTION_COMPLETE and one PARTIAL (the Continue record's own derivation)", () => {
    expect(aggregation.tallies.aiExecutionComplete).toBe(8);
    expect(aggregation.tallies.partial).toBe(1);
    expect(aggregation.tallies.blocked).toBe(0);
    expect(aggregation.tallies.bypassDetected).toBe(0);
    const partial = aggregation.records.find((record) => record.derivedStatus === "PARTIAL");
    expect(partial?.subjectId).toBe("continue");
    expect(
      partial?.ruleResults.filter((rule) => !rule.satisfied).map((rule) => rule.ruleId),
    ).toEqual([
      "EVERY_DECLARED_EDGE_DELEGATED",
      "CORPUS_FUNCTIONALLY_USABLE",
      "ZECK_EVIDENCE_FOR_EVERY_DELEGATED_EDGE",
    ]);
  });

  it("carries the gap taxonomy the records' own vocabulary classifies into", () => {
    expect(aggregation.tallies.gapClassifications.operatorProviderBoundary).toBeGreaterThan(0);
    expect(aggregation.tallies.gapClassifications.architectureGapCandidate).toBe(0);
  });

  it("degrades honestly when a record file is absent (never guesses)", () => {
    const facts = extractPortfolioFacts(
      join(REPO_ROOT, "deploy", "evidence", "ppr-9999.json"),
      "ghost",
    );
    expect(facts.title).toBe("RECORD ABSENT");
    expect(facts.derivedStatus).toBeNull();
    expect(facts.notes.join("\n")).toContain("absent");
  });
});

describe("the ACR-007 thin-adapter audit (nine frozen adapters)", () => {
  const audits = auditAllSubjectAdapters();

  it("audits exactly the nine certified subjects", () => {
    expect(audits).toHaveLength(9);
    expect(audits.map((audit) => audit.subjectId).sort()).toEqual(
      [
        "aider",
        "anythingllm",
        "browser-use",
        "cline",
        "continue",
        "hermes-agent",
        "openclaw",
        "openhands",
        "openwebui",
      ].sort(),
    );
  });

  it("derives every verdict THIN with zero forbidden authority mechanisms (from the actual pinned runtimes)", () => {
    for (const audit of audits) {
      expect(audit.forbiddenFindings, `${audit.subjectId}: no forbidden authority`).toEqual([]);
      expect(audit.verdict, `${audit.subjectId}: thin`).toBe("thin");
      expect(audit.delegationCallSites).toBeGreaterThan(0);
      expect(audit.adapterLinesTotal).toBeGreaterThan(0);
      expect(audit.verdictBasis).toContain("createExecution delegation call site");
    }
  });

  it("records the disclosed non-thin mechanisms with file:line evidence", () => {
    for (const audit of audits) {
      const kinds = new Set(audit.disclosedMechanisms.map((mechanism) => mechanism.kind));
      expect(kinds.has("terminal-polling-loop")).toBe(true);
      expect(kinds.has("idempotency-key-cache")).toBe(true);
      for (const mechanism of audit.disclosedMechanisms) {
        expect(mechanism.evidence).toMatch(/compat\/[a-z-]+\/adapter\/[a-z-]+\.ts:\d+:/);
      }
    }
  });
});
