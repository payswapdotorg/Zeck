/**
 * PPR-023 graph test — the declared execution graph validates cleanly,
 * the discovered inventory validates, the static no-bypass
 * reconciliation produces NO findings (every discovered edge is
 * declared; every declared edge is discovered), and the closed surface
 * vocabulary holds.
 */

import { describe, expect, test } from "vitest";
import {
  EXECUTION_SURFACES,
  isExecutionSurface,
  validateDiscoveredInventory,
  validateExecutionGraph,
  reconcileExecutionGraph,
  hasHardCoverageDefect,
} from "../../../src/integrations/compatibility/public";
import type { ExecutionGraphEdge } from "../../../src/integrations/compatibility/public";
import {
  OPENCLAW_DISCOVERED_INVENTORY,
  OPENCLAW_DORMANT_SEAMS,
  OPENCLAW_EDGE_IDS,
  OPENCLAW_EXECUTION_GRAPH,
  OPENCLAW_INTEGRATION_REVISION,
  OPENCLAW_NON_AI_OPERATIONS,
  OPENCLAW_UPSTREAM_REPOSITORY,
  OPENCLAW_UPSTREAM_REVISION,
} from "../graph/execution-graph";

describe("PPR-023 OpenClaw execution graph", () => {
  test("the declared graph validates with zero issues", () => {
    const issues = [...validateExecutionGraph(OPENCLAW_EXECUTION_GRAPH)];
    expect(issues).toEqual([]);
  });

  test("the discovered inventory validates with zero issues", () => {
    const issues = [...validateDiscoveredInventory(OPENCLAW_DISCOVERED_INVENTORY)];
    expect(issues).toEqual([]);
  });

  test("every declared edge uses a surface from the frozen 20-surface vocabulary", () => {
    for (const edge of OPENCLAW_EXECUTION_GRAPH.edges) {
      expect(isExecutionSurface(edge.surface)).toBe(true);
    }
  });

  test("the declared edge id set is closed and unique (5 edges)", () => {
    expect(OPENCLAW_EDGE_IDS).toHaveLength(5);
    expect(new Set(OPENCLAW_EDGE_IDS).size).toBe(OPENCLAW_EDGE_IDS.length);
    for (const edgeId of OPENCLAW_EDGE_IDS) {
      expect(OPENCLAW_EXECUTION_GRAPH.edges.some((edge) => edge.edgeId === edgeId)).toBe(true);
    }
  });

  test("the multi-surface graph is NOT model-only (the work order's binding rule)", () => {
    const surfaces = new Set(OPENCLAW_EXECUTION_GRAPH.edges.map((edge) => edge.surface));
    expect(surfaces.has("text-generation")).toBe(true);
    expect(surfaces.has("vision-image-understanding")).toBe(true);
    expect(surfaces.has("speech-recognition")).toBe(true);
    expect(surfaces.has("speech-generation")).toBe(true);
    expect(surfaces.has("image-generation")).toBe(true);
    expect(surfaces.size).toBe(5);
    // The full frozen vocabulary is the closed set the surfaces come from.
    expect(EXECUTION_SURFACES).toContain("search-ai-search");
  });

  test("the static no-bypass reconciliation produces no findings (no undeclared edge, no missing inventory)", () => {
    const findings = [
      ...reconcileExecutionGraph(OPENCLAW_EXECUTION_GRAPH, OPENCLAW_DISCOVERED_INVENTORY),
    ];
    expect(findings).toEqual([]);
    expect(hasHardCoverageDefect(findings)).toBe(false);
  });

  test("a missing inventory alone forbids completeness (the reconciliation fails closed)", () => {
    const findings = [...reconcileExecutionGraph(OPENCLAW_EXECUTION_GRAPH, null)];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("INVENTORY_MISSING");
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });

  test("an undeclared discovered edge is a hard coverage defect", () => {
    const rogueEdge: ExecutionGraphEdge = {
      edgeId: "openclaw.tool.rogue-search",
      component: "src/web-search/runtime.ts rogue edge",
      surface: "search-ai-search",
      transport: "direct HTTP",
      externalExecution: "a direct search provider",
      materiality: "test fixture edge",
    };
    const rogue = {
      source: "test",
      edges: [...OPENCLAW_DISCOVERED_INVENTORY.edges, rogueEdge],
    };
    const findings = [...reconcileExecutionGraph(OPENCLAW_EXECUTION_GRAPH, rogue)];
    expect(findings.some((finding) => finding.kind === "UNDECLARED_EDGE")).toBe(true);
    expect(hasHardCoverageDefect(findings)).toBe(true);
  });

  test("the dormant seams are disclosed with gates and owners (never silently out of scope)", () => {
    expect(OPENCLAW_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(6);
    for (const seam of OPENCLAW_DORMANT_SEAMS) {
      expect(seam.edgeId.length).toBeGreaterThan(0);
      expect(seam.gate.length).toBeGreaterThan(0);
      expect(seam.owner.length).toBeGreaterThan(0);
      expect(isExecutionSurface(seam.surface)).toBe(true);
    }
    const seamIds = OPENCLAW_DORMANT_SEAMS.map((seam) => seam.edgeId);
    expect(seamIds).toContain("openclaw.tool.web-search");
    expect(seamIds).toContain("openclaw.tool.web-fetch");
    expect(seamIds).toContain("openclaw.realtime-voice");
  });

  test("the non-AI operations are classified with notes", () => {
    expect(OPENCLAW_NON_AI_OPERATIONS.length).toBeGreaterThanOrEqual(9);
    for (const operation of OPENCLAW_NON_AI_OPERATIONS) {
      expect(operation.name.length).toBeGreaterThan(0);
      expect(operation.note.length).toBeGreaterThan(0);
    }
  });

  test("the upstream and integration revision pins are exact strings", () => {
    expect(OPENCLAW_UPSTREAM_REPOSITORY).toBe("https://github.com/openclaw/openclaw.git");
    expect(OPENCLAW_UPSTREAM_REVISION).toBe("f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3");
    expect(OPENCLAW_INTEGRATION_REVISION).toBe("df6304521e74ea848f1a3691f34c381b42d45e2b");
  });
});
