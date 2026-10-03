/**
 * PPR-024 graph test — the declared two-plane execution graph validates
 * cleanly, the discovered inventory validates, the static no-bypass
 * reconciliation produces NO findings (every discovered edge is
 * declared; every declared edge is discovered), the closed surface
 * vocabulary holds, and every dormant seam carries its gate + owner.
 */

import { describe, expect, test } from "vitest";
import {
  EXECUTION_SURFACES,
  hasHardCoverageDefect,
  isExecutionSurface,
  reconcileExecutionGraph,
  validateDiscoveredInventory,
  validateExecutionGraph,
} from "../../../src/integrations/compatibility/public";
import type { ExecutionGraphEdge } from "../../../src/integrations/compatibility/public";
import {
  BROWSER_USE_DISCOVERED_INVENTORY,
  BROWSER_USE_DORMANT_SEAMS,
  BROWSER_USE_EDGE_IDS,
  BROWSER_USE_EXECUTION_GRAPH,
  BROWSER_USE_INTEGRATION_REVISION,
  BROWSER_USE_NON_AI_OPERATIONS,
  BROWSER_USE_UPSTREAM_REPOSITORY,
  BROWSER_USE_UPSTREAM_REVISION,
} from "../graph/execution-graph";

describe("PPR-024 declared execution graph", () => {
  test("validates cleanly (every edge structurally valid, ids unique)", () => {
    const issues = validateExecutionGraph(BROWSER_USE_EXECUTION_GRAPH);
    expect(issues).toEqual([]);
  });

  test("declares BOTH planes: the model/intelligence edge and the three substrate edges", () => {
    const surfaces = BROWSER_USE_EXECUTION_GRAPH.edges.map((edge) => edge.surface);
    expect(surfaces).toContain("browser-use-intelligence");
    expect(surfaces.filter((surface) => surface === "sandbox-program-execution")).toHaveLength(3);
    for (const edge of BROWSER_USE_EXECUTION_GRAPH.edges) {
      expect(isExecutionSurface(edge.surface)).toBe(true);
      expect(EXECUTION_SURFACES).toContain(edge.surface);
    }
  });

  test("every edge id is unique and the closed set matches", () => {
    const ids = BROWSER_USE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...BROWSER_USE_EDGE_IDS].sort());
  });

  test("the substrate edges carry the neutral tool/substrate vocabulary (never a provider seam)", () => {
    for (const edge of BROWSER_USE_EXECUTION_GRAPH.edges) {
      expect(edge.transport).not.toMatch(/api\.openai|api\.anthropic|cloud\.browser-use/);
      expect(edge.materiality.length).toBeGreaterThan(20);
    }
  });
});

describe("PPR-024 discovered inventory + static no-bypass reconciliation", () => {
  test("the discovered inventory validates cleanly", () => {
    const issues = validateDiscoveredInventory(BROWSER_USE_DISCOVERED_INVENTORY);
    expect(issues).toEqual([]);
  });

  test("reconciliation produces NO findings (no undeclared edge, no missing inventory)", () => {
    const findings = reconcileExecutionGraph(BROWSER_USE_EXECUTION_GRAPH, BROWSER_USE_DISCOVERED_INVENTORY);
    expect(findings).toEqual([]);
    expect(hasHardCoverageDefect(findings)).toBe(false);
  });

  test("a missing inventory alone forbids completeness (the fail-closed rule)", () => {
    const findings = reconcileExecutionGraph(BROWSER_USE_EXECUTION_GRAPH, null);
    expect(findings.map((finding) => finding.kind)).toContain("INVENTORY_MISSING");
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });

  test("an undeclared discovered edge is a hard coverage defect (the hidden-edge rule)", () => {
    const rogue: ExecutionGraphEdge = {
      edgeId: "browseruse.hidden-cloud-llm",
      component: "a hidden direct ChatBrowserUse client",
      surface: "browser-use-intelligence",
      transport: "https to cloud.browser-use.com",
      externalExecution: "the Browser Use cloud LLM",
      materiality: "an undeclared hidden edge for the test",
    };
    const findings = reconcileExecutionGraph(BROWSER_USE_EXECUTION_GRAPH, {
      source: "test probe",
      edges: [...BROWSER_USE_DISCOVERED_INVENTORY.edges, rogue],
    });
    expect(findings.map((finding) => finding.kind)).toContain("UNDECLARED_EDGE");
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });
});

describe("PPR-024 dormant seams + non-AI operations disclosure", () => {
  test("every dormant seam names its component, surface, gate and owner", () => {
    expect(BROWSER_USE_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(5);
    for (const seam of BROWSER_USE_DORMANT_SEAMS) {
      expect(seam.edgeId.length).toBeGreaterThan(0);
      expect(seam.component.length).toBeGreaterThan(10);
      expect(isExecutionSurface(seam.surface)).toBe(true);
      expect(seam.gate.length).toBeGreaterThan(20);
      expect(seam.owner.length).toBeGreaterThan(5);
    }
  });

  test("the cloud LLM and cloud browser seams are recorded as operator-provider boundaries", () => {
    const cloudLlm = BROWSER_USE_DORMANT_SEAMS.find((seam) => seam.edgeId === "browseruse.cloud.llm");
    const cloudBrowser = BROWSER_USE_DORMANT_SEAMS.find(
      (seam) => seam.edgeId === "browseruse.cloud.browser",
    );
    expect(cloudLlm?.owner).toContain("operator-provider boundary");
    expect(cloudBrowser?.owner).toContain("operator-provider boundary");
  });

  test("the app-owned fallback-LLM axis is disclosed as disabled-by-configuration", () => {
    const fallback = BROWSER_USE_DORMANT_SEAMS.find(
      (seam) => seam.edgeId === "browseruse.fallback-llm",
    );
    expect(fallback?.gate).toContain("fallback_llm=None");
  });

  test("non-AI operations are disclosed with notes", () => {
    expect(BROWSER_USE_NON_AI_OPERATIONS.length).toBeGreaterThanOrEqual(5);
    for (const operation of BROWSER_USE_NON_AI_OPERATIONS) {
      expect(operation.name.length).toBeGreaterThan(3);
      expect(operation.note.length).toBeGreaterThan(10);
    }
  });
});

describe("PPR-024 revision pins", () => {
  test("the upstream pin is the exact proof-time clone head (v0.13.10)", () => {
    expect(BROWSER_USE_UPSTREAM_REVISION).toBe("7be96ed8bafa8dfe1eef228b59cf5c884b8b2431");
    expect(BROWSER_USE_UPSTREAM_REPOSITORY).toBe("https://github.com/browser-use/browser-use.git");
  });

  test("the integration pin is the governed delivery base the branch was cut from", () => {
    expect(BROWSER_USE_INTEGRATION_REVISION).toBe("d51b5a59d53ef7824074acc4fce6726f065fcec5");
  });
});
