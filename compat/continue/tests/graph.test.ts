/**
 * PPR-021 graph tests — the declared execution graph, the discovered
 * inventory and the static no-bypass reconciliation, pinned.
 */

import { describe, expect, it } from "vitest";
import {
  reconcileExecutionGraph,
  validateDiscoveredInventory,
  validateExecutionGraph,
} from "../../../src/integrations/compatibility/public";
import {
  CONTINUE_DISCOVERED_INVENTORY,
  CONTINUE_DORMANT_SEAMS,
  CONTINUE_EDGE_IDS,
  CONTINUE_EXECUTION_GRAPH,
  CONTINUE_NON_AI_OPERATIONS,
  CONTINUE_UPSTREAM_REPOSITORY,
  CONTINUE_UPSTREAM_REVISION,
} from "../graph/execution-graph";

describe("the PPR-021 declared execution graph", () => {
  it("validates fail-closed (zero issues)", () => {
    expect(validateExecutionGraph(CONTINUE_EXECUTION_GRAPH)).toEqual([]);
  });

  it("declares every material model role the corpus exercises (7 edges)", () => {
    expect(CONTINUE_EDGE_IDS).toEqual([
      "continue.cli.agent-loop.chat",
      "continue.cli.subagent.child-session",
      "continue.core.edit.inline-edit",
      "continue.core.apply.fast-apply",
      "continue.core.autocomplete.tab",
      "continue.core.indexing.embed",
      "continue.core.retrieval.rerank",
    ]);
    expect(CONTINUE_EDGE_IDS.length).toBe(7);
  });

  it("covers chat, edit, apply, autocomplete, embed and rerank (the work order's role list)", () => {
    const surfaces = CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.surface);
    expect(surfaces).toContain("text-generation");
    expect(surfaces).toContain("embeddings");
    expect(surfaces).toContain("reranking");
    // The role-model mapping (one declared edge per Continue role):
    expect(CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toContain(
      "continue.cli.agent-loop.chat",
    );
    expect(CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toContain(
      "continue.core.edit.inline-edit",
    );
    expect(CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toContain(
      "continue.core.apply.fast-apply",
    );
    expect(CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toContain(
      "continue.core.autocomplete.tab",
    );
    expect(CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toContain(
      "continue.core.indexing.embed",
    );
    expect(CONTINUE_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId)).toContain(
      "continue.core.retrieval.rerank",
    );
  });

  it("pins the exact upstream revision and repository", () => {
    expect(CONTINUE_UPSTREAM_REVISION).toBe("5522c6f44ca0ac3528b37244818fbfa39b5af470");
    expect(CONTINUE_UPSTREAM_REPOSITORY).toBe("https://github.com/continuedev/continue");
  });
});

describe("the PPR-021 discovered edge inventory", () => {
  it("validates fail-closed (zero issues)", () => {
    expect(validateDiscoveredInventory(CONTINUE_DISCOVERED_INVENTORY)).toEqual([]);
  });

  it("reconciles against the declared graph with NO hard coverage defect", () => {
    const findings = reconcileExecutionGraph(CONTINUE_EXECUTION_GRAPH, CONTINUE_DISCOVERED_INVENTORY);
    const hard = findings.filter(
      (finding) => finding.kind === "UNDECLARED_EDGE" || finding.kind === "INVENTORY_MISSING",
    );
    expect(hard).toEqual([]);
  });

  it("carries a provenance source naming the pinned revision", () => {
    expect(CONTINUE_DISCOVERED_INVENTORY.source).toContain(CONTINUE_UPSTREAM_REVISION);
  });
});

describe("the dormant-seam and non-AI disclosures", () => {
  it("discloses the summarize role as schema-only at the pinned revision", () => {
    const summarize = CONTINUE_DORMANT_SEAMS.find((seam) => seam.edgeId === "continue.role.summarize");
    expect(summarize).toBeDefined();
    expect(summarize?.gate).toContain("not implemented yet");
  });

  it("discloses every dormant seam with its configuration gate", () => {
    for (const seam of CONTINUE_DORMANT_SEAMS) {
      expect(seam.gate.length).toBeGreaterThan(0);
      expect(seam.component.length).toBeGreaterThan(0);
    }
    expect(CONTINUE_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(9);
  });

  it("discloses the non-AI operations (terminal, file tools, git — no model call)", () => {
    const names = CONTINUE_NON_AI_OPERATIONS.map((op) => op.name).join("\n");
    expect(names).toContain("Bash");
    expect(names).toContain("Read/Write/Edit/MultiEdit");
    expect(names).toContain("git");
  });
});
