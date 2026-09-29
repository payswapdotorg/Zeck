/**
 * PPR-019 execution-graph tests — the declared graph validates against
 * the PPR-017 framework's own validators, the discovered inventory
 * reconciles with NO hidden-edge defect, the edge-id set is closed, the
 * surfaces sit in the ACR-006 vocabulary, and every dormant seam carries
 * its configuration gate (never a silent omission).
 */

import { describe, expect, test } from "vitest";
import {
  EXECUTION_SURFACES,
  hasHardCoverageDefect,
  reconcileExecutionGraph,
  validateDiscoveredInventory,
  validateExecutionGraph,
} from "../../../src/integrations/compatibility/public";
import {
  CLINE_DISCOVERED_INVENTORY,
  CLINE_DORMANT_SEAMS,
  CLINE_EDGE_IDS,
  CLINE_EXECUTION_GRAPH,
  CLINE_NON_AI_OPERATIONS,
  CLINE_UPSTREAM_REVISION,
} from "../graph/execution-graph";

describe("PPR-019 declared execution graph", () => {
  test("the declared graph passes the framework validator", () => {
    expect(validateExecutionGraph(CLINE_EXECUTION_GRAPH)).toEqual([]);
  });

  test("the discovered inventory passes the framework validator", () => {
    expect(validateDiscoveredInventory(CLINE_DISCOVERED_INVENTORY)).toEqual([]);
  });

  test("every declared edge id is unique and the set is closed", () => {
    const ids = CLINE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...CLINE_EDGE_IDS].sort());
  });

  test("every declared edge surface is in the ACR-006 vocabulary", () => {
    for (const edge of CLINE_EXECUTION_GRAPH.edges) {
      expect(EXECUTION_SURFACES).toContain(edge.surface);
    }
  });

  test("every declared edge carries its materiality basis", () => {
    for (const edge of CLINE_EXECUTION_GRAPH.edges) {
      expect(edge.materiality.length).toBeGreaterThan(40);
    }
  });

  test("the corpus-reachable edges: plan, act, vision, reasoning and the auxiliary compaction edge are all declared", () => {
    expect(CLINE_EDGE_IDS).toContain("cline.agent-loop.act");
    expect(CLINE_EDGE_IDS).toContain("cline.agent-loop.plan");
    expect(CLINE_EDGE_IDS).toContain("cline.agent-loop.vision");
    expect(CLINE_EDGE_IDS).toContain("cline.agent-loop.reasoning");
    expect(CLINE_EDGE_IDS).toContain("cline.compaction.agentic");
  });
});

describe("PPR-019 static no-bypass reconciliation", () => {
  test("the declared graph reconciles against the discovered inventory with no hidden edge", () => {
    const findings = reconcileExecutionGraph(CLINE_EXECUTION_GRAPH, CLINE_DISCOVERED_INVENTORY);
    expect(hasHardCoverageDefect(findings)).toBe(false);
    expect(findings.filter((finding) => finding.kind === "UNDECLARED_EDGE")).toEqual([]);
    expect(findings.filter((finding) => finding.kind === "INVENTORY_MISSING")).toEqual([]);
  });

  test("a hidden seam (the VS Code commit-message generator, absent from the graph) IS caught by the reconciler", () => {
    const hiddenInventory = {
      source: "negative control",
      edges: [
        ...CLINE_DISCOVERED_INVENTORY.edges,
        {
          edgeId: "cline.vscode.commit-message",
          component: "apps/vscode/src/hosts/vscode/commit-message-generator.ts:227",
          surface: "text-generation" as const,
          transport: "VS Code host apiHandler",
          externalExecution: "the configured provider endpoint",
          materiality: "negative control: a seam the declared graph omits",
        },
      ],
    };
    const findings = reconcileExecutionGraph(CLINE_EXECUTION_GRAPH, hiddenInventory);
    expect(findings.some((finding) => finding.kind === "UNDECLARED_EDGE")).toBe(true);
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });

  test("a missing inventory is itself a named hard defect (never a silent pass)", () => {
    const findings = reconcileExecutionGraph(CLINE_EXECUTION_GRAPH, null);
    expect(findings.some((finding) => finding.kind === "INVENTORY_MISSING")).toBe(true);
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });
});

describe("PPR-019 dormant seams + non-AI operations disclosure", () => {
  test("every dormant seam names its configuration gate and pinned component", () => {
    expect(CLINE_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(5);
    for (const seam of CLINE_DORMANT_SEAMS) {
      expect(seam.component.length).toBeGreaterThan(10);
      expect(seam.gate.length).toBeGreaterThan(30);
      expect(EXECUTION_SURFACES).toContain(seam.surface);
    }
  });

  test("the VS Code host, voice, image-transport and web-search seams are all disclosed as dormant", () => {
    const ids = CLINE_DORMANT_SEAMS.map((seam) => seam.edgeId);
    expect(ids).toContain("cline.vscode.commit-message");
    expect(ids).toContain("cline.vscode.lm-handler");
    expect(ids).toContain("cline.voice.transcription");
    expect(ids).toContain("cline.openrouter.image-generation");
    expect(ids).toContain("cline.web-search-model-tool");
  });

  test("the retained non-AI operations are disclosed with their no-model-call basis", () => {
    expect(CLINE_NON_AI_OPERATIONS.length).toBeGreaterThanOrEqual(4);
    for (const operation of CLINE_NON_AI_OPERATIONS) {
      expect(operation.note.length).toBeGreaterThan(20);
    }
  });

  test("the graph is pinned against the exact upstream revision", () => {
    expect(CLINE_UPSTREAM_REVISION).toBe("252082b9e93b4f91253876391e35b4c13326f5e6");
    expect(CLINE_DISCOVERED_INVENTORY.source).toContain(CLINE_UPSTREAM_REVISION);
  });
});
