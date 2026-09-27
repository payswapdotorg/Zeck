/**
 * PPR-018 graph + admission tests: the declared execution graph and the
 * discovered inventory are structurally valid, reconcile without hard
 * coverage defects, and the strict admission machine derives the honest
 * statuses from synthetic records (the derivation discriminating power
 * PPR-017 pinned, applied to the Aider graph).
 */

import { describe, expect, test } from "vitest";
import {
  AIDER_DORMANT_EDGES,
  AIDER_DISCOVERED_INVENTORY,
  AIDER_EXECUTION_GRAPH,
  AIDER_PINNED_REVISION,
} from "../graph/execution-graph";
import {
  createCompatibilityService,
  hasHardCoverageDefect,
  reconcileExecutionGraph,
  validateDiscoveredInventory,
  validateExecutionGraph,
  type CompatibilityEvidenceRecord,
} from "../../../src/integrations/compatibility/public";

const service = createCompatibilityService();

function recordOf(over: Partial<CompatibilityEvidenceRecord> = {}): CompatibilityEvidenceRecord {
  return {
    recordId: "test-record",
    recordBasis: "live-proof",
    pinnedApplication: {
      identity: {
        name: "Aider",
        repository: "https://github.com/Aider-AI/aider",
        applicationId: "app-1",
      },
      pin: { upstreamRevision: AIDER_PINNED_REVISION, integrationRevision: "int-1" },
    },
    graph: AIDER_EXECUTION_GRAPH,
    dispositions: AIDER_EXECUTION_GRAPH.edges.map((edge) => ({
      edgeId: edge.edgeId,
      disposition: "delegated" as const,
      zeckExecutionIds: [`exec-${edge.edgeId}`],
      evidenceBasis: "live" as const,
    })),
    egressObservation: { mode: "deny", status: "observed-clean", violations: [] },
    providerCredentials: [],
    runtimeEvidence: {
      corpusDeclared: true,
      corpusUsability: "verified",
      observations: [],
    },
    comparison: [],
    zeckTraces: AIDER_EXECUTION_GRAPH.edges.flatMap((edge) => [
      {
        edgeId: edge.edgeId,
        executionId: `exec-${edge.edgeId}`,
        applicationId: "app-1",
        found: true,
        status: "COMPLETED",
        terminal: true,
        eventCount: 10,
        verificationCount: 2,
        passingVerificationCount: 2,
        correlated: true,
      },
    ]),
    limitations: [],
    notRunCauses: [],
    recordedAt: "2026-09-27T00:00:00Z",
    ...over,
  };
}

describe("the declared Aider execution graph", () => {
  test("is structurally valid", () => {
    expect(validateExecutionGraph(AIDER_EXECUTION_GRAPH)).toEqual([]);
  });

  test("declares the three active AI edges of the pinned corpus configuration", () => {
    expect(AIDER_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toEqual([
      "aider.main-completion",
      "aider.commit-message",
      "aider.summarizer",
    ]);
    for (const edge of AIDER_EXECUTION_GRAPH.edges) {
      expect(edge.surface).toBe("text-generation");
      expect(edge.transport.toLowerCase()).toContain("litellm");
      expect(edge.materiality.length).toBeGreaterThan(20);
    }
  });

  test("the discovered inventory is valid and reconciles without hard defects", () => {
    expect(validateDiscoveredInventory(AIDER_DISCOVERED_INVENTORY)).toEqual([]);
    const findings = reconcileExecutionGraph(AIDER_EXECUTION_GRAPH, AIDER_DISCOVERED_INVENTORY);
    expect(hasHardCoverageDefect(findings)).toBe(false);
  });

  test("discloses the dormant AI edges (never silently ignored)", () => {
    const dormantIds = AIDER_DORMANT_EDGES.map((edge) => edge.edgeId);
    expect(dormantIds).toContain("aider.cache-warming");
    expect(dormantIds).toContain("aider.voice-transcription");
    for (const edge of AIDER_DORMANT_EDGES) {
      expect(edge.gate.length).toBeGreaterThan(20);
    }
  });
});

describe("the admission machine over the Aider graph", () => {
  test("a fully-delegated live record with verified corpus derives AI_EXECUTION_COMPLETE", () => {
    const assessment = service.assess(recordOf(), AIDER_DISCOVERED_INVENTORY);
    expect(assessment.status).toBe("AI_EXECUTION_COMPLETE");
  });

  test("an undelegated edge downgrades to PARTIAL", () => {
    const dispositions = [
      ...AIDER_EXECUTION_GRAPH.edges.slice(0, 2).map((edge) => ({
        edgeId: edge.edgeId,
        disposition: "delegated" as const,
        zeckExecutionIds: [`exec-${edge.edgeId}`],
        evidenceBasis: "live" as const,
      })),
      {
        edgeId: "aider.summarizer",
        disposition: "not-run" as const,
        cause: "test cause",
        owner: "Lead",
      },
    ];
    const assessment = service.assess(
      recordOf({ dispositions }),
      AIDER_DISCOVERED_INVENTORY,
    );
    expect(assessment.status).toBe("PARTIAL");
  });

  test("a hidden discovered edge is a hard coverage defect that forbids COMPLETE", () => {
    const inventoryWithHiddenEdge = {
      source: "test",
      edges: [
        ...AIDER_DISCOVERED_INVENTORY.edges,
        {
          edgeId: "aider.hidden-cache-warming",
          component: "aider/coders/base_coder.py:1373",
          surface: "text-generation" as const,
          transport: "litellm.completion",
          externalExecution: "direct provider (hidden)",
          materiality: "a hidden direct edge",
        },
      ],
    };
    const assessment = service.assess(recordOf(), inventoryWithHiddenEdge);
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(
      assessment.staticFindings.some((finding) => finding.kind === "UNDECLARED_EDGE"),
    ).toBe(true);
  });

  test("a fixture record can never reach AI_EXECUTION_COMPLETE", () => {
    const assessment = service.assess(
      recordOf({ recordBasis: "fixture" }),
      AIDER_DISCOVERED_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
  });

  test("observed-passing egress is BYPASS_DETECTED", () => {
    const assessment = service.assess(
      recordOf({
        egressObservation: {
          mode: "observe",
          status: "violations-detected",
          violations: [
            {
              host: "api.openai.com",
              url: "https://api.openai.com/v1/chat/completions",
              rule: "test",
              at: "2026-09-27T00:00:00Z",
              blocked: false,
            },
          ],
        },
      }),
      AIDER_DISCOVERED_INVENTORY,
    );
    expect(assessment.status).toBe("BYPASS_DETECTED");
  });
});
