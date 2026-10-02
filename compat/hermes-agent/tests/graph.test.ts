/**
 * PPR-022 execution-graph tests — the declared graph validates, the
 * discovered inventory validates and is claimed by the declared edges
 * (the static no-bypass reconciliation), and the closed edge set is
 * exactly the seven declared edges.
 */

import { describe, expect, test } from "vitest";
import {
  reconcileExecutionGraph,
  validateDiscoveredInventory,
  validateExecutionGraph,
} from "../../../src/integrations/compatibility/public";
import {
  HERMES_DISCOVERED_INVENTORY,
  HERMES_DORMANT_SEAMS,
  HERMES_EDGE_IDS,
  HERMES_EXECUTION_GRAPH,
  HERMES_NON_AI_OPERATIONS,
  HERMES_UPSTREAM_REPOSITORY,
  HERMES_UPSTREAM_REVISION,
} from "../graph/execution-graph";

describe("PPR-022 declared execution graph", () => {
  test("the declared graph validates fail-closed", () => {
    expect([...validateExecutionGraph(HERMES_EXECUTION_GRAPH)]).toEqual([]);
  });

  test("the discovered inventory validates fail-closed", () => {
    expect([...validateDiscoveredInventory(HERMES_DISCOVERED_INVENTORY)]).toEqual([]);
  });

  test("the static no-bypass reconciliation reports no coverage defects", () => {
    const findings = reconcileExecutionGraph(HERMES_EXECUTION_GRAPH, HERMES_DISCOVERED_INVENTORY);
    const hard = findings.filter((finding) =>
      ["undeclared-discovered-edge", "missing-inventory"].includes(finding.kind),
    );
    expect(hard).toEqual([]);
  });

  test("the declared edge set is the closed seven-edge set", () => {
    expect(HERMES_EDGE_IDS).toHaveLength(7);
    expect([...HERMES_EDGE_IDS]).toEqual([
      "hermes.agent-loop.main",
      "hermes.auxiliary.title-generation",
      "hermes.auxiliary.compression",
      "hermes.auxiliary.vision-analyze",
      "hermes.tool.tts-openai",
      "hermes.tool.stt-openai",
      "hermes.tool.image-generate-openai",
    ]);
  });

  test("every declared edge is unique and every surface is a taxonomy surface", () => {
    const ids = HERMES_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const edge of HERMES_EXECUTION_GRAPH.edges) {
      expect(edge.component.length).toBeGreaterThan(0);
      expect(edge.transport.length).toBeGreaterThan(0);
      expect(edge.externalExecution.length).toBeGreaterThan(0);
      expect(edge.materiality.length).toBeGreaterThan(0);
    }
  });

  test("the graph covers the corpus's multi-surface span: primary + auxiliary LLM, vision, TTS, STT and image generation", () => {
    const surfaces = new Set(HERMES_EXECUTION_GRAPH.edges.map((edge) => edge.surface));
    expect(surfaces.has("text-generation")).toBe(true);
    expect(surfaces.has("vision-image-understanding")).toBe(true);
    expect(surfaces.has("speech-generation")).toBe(true);
    expect(surfaces.has("speech-recognition")).toBe(true);
    expect(surfaces.has("image-generation")).toBe(true);
  });

  test("the upstream pin is the exact recorded revision of the Nous Research repository", () => {
    expect(HERMES_UPSTREAM_REPOSITORY).toBe("https://github.com/NousResearch/hermes-agent");
    expect(HERMES_UPSTREAM_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(HERMES_UPSTREAM_REVISION).toBe("77e2992020eafded09e0c344e687ae53e52e6eab");
  });

  test("the dormant seams are inventoried with gates (never silently out of scope)", () => {
    expect(HERMES_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(10);
    for (const seam of HERMES_DORMANT_SEAMS) {
      expect(seam.edgeId.length).toBeGreaterThan(0);
      expect(seam.component.length).toBeGreaterThan(0);
      expect(seam.gate.length).toBeGreaterThan(0);
    }
    const ids = new Set(HERMES_DORMANT_SEAMS.map((seam) => seam.edgeId));
    // The fragmented provider classes the target matrix flags are named.
    expect(ids.has("hermes.tool.web-search")).toBe(true);
    expect(ids.has("hermes.tool.browser-suite")).toBe(true);
    expect(ids.has("hermes.tool.mcp")).toBe(true);
    expect(ids.has("hermes.tool.video-generation")).toBe(true);
    expect(ids.has("hermes.tts-alternate-providers")).toBe(true);
    expect(ids.has("hermes.image-gen-alternate-providers")).toBe(true);
  });

  test("the non-AI operations are classified with justifications", () => {
    expect(HERMES_NON_AI_OPERATIONS.length).toBeGreaterThanOrEqual(6);
    for (const operation of HERMES_NON_AI_OPERATIONS) {
      expect(operation.name.length).toBeGreaterThan(0);
      expect(operation.note.length).toBeGreaterThan(0);
    }
  });
});
