/**
 * PPR-020 execution-graph tests — the declared graph validates, the
 * discovered inventory validates and is claimed by the declared edges
 * (the static no-bypass reconciliation), and the closed edge set is
 * exactly the five declared edges.
 */

import { describe, expect, test } from "vitest";
import {
  reconcileExecutionGraph,
  validateDiscoveredInventory,
  validateExecutionGraph,
} from "../../../src/integrations/compatibility/public";
import {
  OPENHANDS_DISCOVERED_INVENTORY,
  OPENHANDS_DISTRIBUTION_REVISION,
  OPENHANDS_DORMANT_SEAMS,
  OPENHANDS_EDGE_IDS,
  OPENHANDS_EXECUTION_GRAPH,
  OPENHANDS_NON_AI_OPERATIONS,
  OPENHANDS_UPSTREAM_REVISION,
} from "../graph/execution-graph";

describe("PPR-020 declared execution graph", () => {
  test("the declared graph validates fail-closed", () => {
    expect([...validateExecutionGraph(OPENHANDS_EXECUTION_GRAPH)]).toEqual([]);
  });

  test("the discovered inventory validates fail-closed", () => {
    expect([...validateDiscoveredInventory(OPENHANDS_DISCOVERED_INVENTORY)]).toEqual([]);
  });

  test("the static no-bypass reconciliation reports no coverage defects", () => {
    const findings = reconcileExecutionGraph(OPENHANDS_EXECUTION_GRAPH, OPENHANDS_DISCOVERED_INVENTORY);
    const hard = findings.filter((finding) =>
      ["undeclared-discovered-edge", "missing-inventory"].includes(finding.kind),
    );
    expect(hard).toEqual([]);
  });

  test("the declared edge set is the closed five-edge set", () => {
    expect(OPENHANDS_EDGE_IDS).toHaveLength(5);
    expect([...OPENHANDS_EDGE_IDS]).toEqual([
      "openhands.agent-loop.main",
      "openhands.agent-loop.vision",
      "openhands.condenser.llm-summarize",
      "openhands.subagent.task-loop",
      "openhands.tool.ask-oracle",
    ]);
  });

  test("every declared edge names a component, a surface and an external execution", () => {
    for (const edge of OPENHANDS_EXECUTION_GRAPH.edges) {
      expect(edge.component.length).toBeGreaterThan(0);
      expect(edge.surface.length).toBeGreaterThan(0);
      expect(edge.externalExecution.length).toBeGreaterThan(0);
      expect(edge.materiality.length).toBeGreaterThan(0);
    }
  });

  test("the pinned upstream revisions are the exact recorded SHAs", () => {
    expect(OPENHANDS_UPSTREAM_REVISION).toBe("fcc102a697874d54a357e36004e02c95040dbdc0");
    expect(OPENHANDS_DISTRIBUTION_REVISION).toBe("7dc6805406ea3c76cb4a3ce407c3c72d481b0ac6");
  });

  test("the dormant seams are inventoried with configuration gates (never silently ignored)", () => {
    expect(OPENHANDS_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(10);
    for (const seam of OPENHANDS_DORMANT_SEAMS) {
      expect(seam.gate.length).toBeGreaterThan(0);
    }
    const browserSeam = OPENHANDS_DORMANT_SEAMS.find((s) => s.edgeId === "openhands.tool.browser-use");
    expect(browserSeam).toBeDefined();
    expect(browserSeam?.gate).toMatch(/browser-use browser environment/);
  });

  test("the browser-use tool discloses the no-separate-LLM inventory finding", () => {
    const browserSeam = OPENHANDS_DORMANT_SEAMS.find((s) => s.edgeId === "openhands.tool.browser-use");
    expect(browserSeam?.component).toMatch(/NO separate LLM|observations returned to the main agent loop/);
  });

  test("the second-client seams are disclosed (tom-consult and the API critic)", () => {
    const tom = OPENHANDS_DORMANT_SEAMS.find((s) => s.edgeId === "openhands.tool.tom-consult");
    expect(tom?.component).toMatch(/external tom_swe package/);
    const critic = OPENHANDS_DORMANT_SEAMS.find((s) => s.edgeId === "openhands.critic.api");
    expect(critic?.component).toMatch(/classify/);
  });

  test("the non-AI operations include the deterministic skills-trigger finding", () => {
    const skills = OPENHANDS_NON_AI_OPERATIONS.find((op) => op.name.includes("skills"));
    expect(skills?.note).toMatch(/deterministic/);
    expect(skills?.note).toMatch(/no embeddings|keyword/);
  });
});
