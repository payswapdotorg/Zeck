/**
 * PPR-017 — the REQUIRED negative no-bypass tests (the work order:
 * "negative test: hidden direct-provider edge cannot be certified" and
 * "negative test: missing edge inventory cannot be certified").
 *
 * These are the two defect classes the completeness invariant exists
 * for: an application whose main model path routes through Zeck while
 * an auxiliary edge silently bypasses it (the OpenClaw/Hermes lesson),
 * and a proof whose edge inventory was never produced (nothing was
 * reconciled, so nothing was proven).
 *
 * Both tests construct records that would OTHERWISE satisfy admission
 * (green corpus, clean egress, live traces on every DECLARED edge) —
 * the hidden edge / missing inventory alone must be what forbids
 * AI_EXECUTION_COMPLETE. A relaxed admission function fails here.
 */

import { describe, expect, test } from "vitest";
import {
  type CompatibilityEvidenceRecord,
  type EdgeDispositionEntry,
  type ExecutionGraphEdge,
  evaluateCompatibility,
  hasHardCoverageDefect,
  reconcileExecutionGraph,
} from "../../../src/integrations/compatibility/public";

const APP_ID = "00000000-0000-7000-8000-0000000000c1";
const MAIN_EXECUTION_ID = "00000000-0000-7000-8000-0000000000d1";
const HIDDEN_EXECUTION_ID = "00000000-0000-7000-8000-0000000000d3";

const MAIN_EDGE: ExecutionGraphEdge = {
  edgeId: "main-completion",
  component: "chat loop",
  surface: "text-generation",
  transport: "provider client",
  externalExecution: "provider model",
  materiality: "the main model call",
};

const HIDDEN_EDGE: ExecutionGraphEdge = {
  edgeId: "hidden-summarizer",
  component: "diff summarizer",
  surface: "text-generation",
  transport: "auxiliary model client",
  externalExecution: "auxiliary provider model invocation",
  materiality: "an auxiliary summarization call outside the main seam",
};

/**
 * A record whose DECLARED graph is fully delegated with live evidence —
 * everything the five admission rules need. The tests below add the
 * one defect that must break it.
 */
function otherwiseCompleteRecord(
  extraEdges: readonly ExecutionGraphEdge[] = [],
  extraDispositions: readonly EdgeDispositionEntry[] = [],
  extraTraces: readonly CompatibilityEvidenceRecord["zeckTraces"][number][] = [],
): CompatibilityEvidenceRecord {
  return {
    recordId: "negative-test-record",
    recordBasis: "live-proof",
    pinnedApplication: {
      identity: {
        name: "Synthetic hidden-edge test application",
        repository: "https://example.invalid/synthetic-hidden",
        applicationId: APP_ID,
      },
      pin: { upstreamRevision: "a".repeat(40), integrationRevision: "b".repeat(40) },
    },
    graph: { edges: [MAIN_EDGE, ...extraEdges] },
    dispositions: [
      {
        edgeId: "main-completion",
        disposition: "delegated",
        zeckExecutionIds: [MAIN_EXECUTION_ID],
        evidenceBasis: "live",
      },
      ...extraDispositions,
    ],
    egressObservation: { mode: "observe", status: "observed-clean", violations: [] },
    providerCredentials: [],
    runtimeEvidence: {
      corpusDeclared: true,
      corpusUsability: "verified",
      observations: ["the corpus replayed functionally"],
    },
    comparison: [],
    zeckTraces: [
      {
        edgeId: "main-completion",
        executionId: MAIN_EXECUTION_ID,
        applicationId: APP_ID,
        found: true,
        status: "COMPLETED",
        terminal: true,
        eventCount: 5,
        verificationCount: 1,
        passingVerificationCount: 1,
        correlated: true,
      },
      ...extraTraces,
    ],
    limitations: [],
    notRunCauses: [],
    recordedAt: "2026-09-26T00:00:00Z",
  };
}

describe("NEGATIVE: a hidden direct-provider edge cannot be certified", () => {
  test("the static reconciliation names the hidden edge (UNDECLARED_EDGE)", () => {
    const record = otherwiseCompleteRecord();
    const findings = reconcileExecutionGraph(record.graph, {
      source: "synthetic runtime discovery",
      edges: [MAIN_EDGE, HIDDEN_EDGE],
    });
    expect(findings.some((finding) => finding.kind === "UNDECLARED_EDGE")).toBe(true);
    expect(findings.find((finding) => finding.kind === "UNDECLARED_EDGE")?.edgeId).toBe(
      "hidden-summarizer",
    );
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });

  test("a hidden edge ALONE forbids AI_EXECUTION_COMPLETE (the green main path is not enough)", () => {
    const record = otherwiseCompleteRecord();
    const assessment = evaluateCompatibility(record, {
      source: "synthetic runtime discovery",
      edges: [MAIN_EDGE, HIDDEN_EDGE],
    });
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "UNDECLARED_EDGE")).toBe(true);
    // The five rules may all be satisfied over the DECLARED graph —
    // the coverage gate is what refuses certification (the omitted
    // material edge is a coverage defect, never silently out of scope).
    expect(assessment.ruleResults.every((rule) => rule.satisfied)).toBe(true);
  });

  test("an id-renamed hidden edge cannot hide behind the rename (chain matching)", () => {
    const record = otherwiseCompleteRecord();
    const renamed: ExecutionGraphEdge = { ...HIDDEN_EDGE, edgeId: "totally-different-id" };
    const findings = reconcileExecutionGraph(record.graph, {
      source: "synthetic runtime discovery",
      edges: [MAIN_EDGE, renamed],
    });
    expect(findings.some((finding) => finding.kind === "UNDECLARED_EDGE")).toBe(true);
  });

  test("the egress observation corroborating the hidden edge escalates to BYPASS_DETECTED", () => {
    const record = {
      ...otherwiseCompleteRecord(),
      egressObservation: {
        mode: "observe" as const,
        status: "violations-detected" as const,
        violations: [
          {
            host: "provider.example",
            url: "https://provider.example/v1/completions",
            rule: "deny direct AI-provider hosts",
            at: "2026-09-26T00:00:00Z",
            blocked: false,
          },
        ],
      },
    };
    const assessment = evaluateCompatibility(record, {
      source: "synthetic runtime discovery",
      edges: [MAIN_EDGE, HIDDEN_EDGE],
    });
    expect(assessment.status).toBe("BYPASS_DETECTED");
  });

  test("sanity: the SAME record with the edge declared and delegated certifies (the gate is the omission)", () => {
    const record = otherwiseCompleteRecord(
      [HIDDEN_EDGE],
      [
        {
          edgeId: "hidden-summarizer",
          disposition: "delegated",
          zeckExecutionIds: [HIDDEN_EXECUTION_ID],
          evidenceBasis: "live",
        },
      ],
      [
        {
          edgeId: "hidden-summarizer",
          executionId: HIDDEN_EXECUTION_ID,
          applicationId: APP_ID,
          found: true,
          status: "COMPLETED",
          terminal: true,
          eventCount: 4,
          verificationCount: 1,
          passingVerificationCount: 1,
          correlated: true,
        },
      ],
    );
    const assessment = evaluateCompatibility(record, {
      source: "synthetic runtime discovery",
      edges: [MAIN_EDGE, HIDDEN_EDGE],
    });
    expect(assessment.status).toBe("AI_EXECUTION_COMPLETE");
  });
});

describe("NEGATIVE: a missing edge inventory cannot be certified", () => {
  test("a null inventory is the named INVENTORY_MISSING defect (missing evidence is not evidence of absence)", () => {
    const record = otherwiseCompleteRecord();
    const findings = reconcileExecutionGraph(record.graph, null);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("INVENTORY_MISSING");
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });

  test("no inventory ALONE forbids AI_EXECUTION_COMPLETE (every declared edge can be green — nothing was reconciled)", () => {
    const record = otherwiseCompleteRecord();
    const assessment = evaluateCompatibility(record, null);
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "INVENTORY_MISSING")).toBe(true);
    expect(assessment.ruleResults.every((rule) => rule.satisfied)).toBe(true);
  });

  test("the omitted-inventory record stays PARTIAL (progress exists) — never certified, never silently unassessed", () => {
    const record = otherwiseCompleteRecord();
    expect(evaluateCompatibility(record, null).status).toBe("PARTIAL");
  });

  test("a missing-disposition edge is a coverage defect too (the record itself omits the edge's proof)", () => {
    const record = { ...otherwiseCompleteRecord(), dispositions: [] };
    const assessment = evaluateCompatibility(record, null);
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "EDGE_MISSING_DISPOSITION")).toBe(
      true,
    );
  });
});
