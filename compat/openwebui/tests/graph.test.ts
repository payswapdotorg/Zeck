/**
 * PPR-025 graph test — the declared multi-modal execution graph validates
 * cleanly, the discovered inventory validates, the static no-bypass
 * reconciliation produces NO findings (every discovered edge is
 * declared; every declared edge is discovered), the closed surface
 * vocabulary holds, every dormant seam carries its gate + owner, and the
 * corpus's coverage declaration matches the declared edge set exactly
 * (the work order's multi-modal completeness rule).
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
import {
  OPENWEBUI_DISCOVERED_INVENTORY,
  OPENWEBUI_DORMANT_SEAMS,
  OPENWEBUI_EDGE_IDS,
  OPENWEBUI_EXECUTION_GRAPH,
  OPENWEBUI_INTEGRATION_REVISION,
  OPENWEBUI_NON_AI_OPERATIONS,
  OPENWEBUI_UPSTREAM_REPOSITORY,
  OPENWEBUI_UPSTREAM_REVISION,
} from "../graph/execution-graph";
import { CORPUS_EXERCISED_EDGE_IDS, CORPUS_TASKS } from "../corpus/tasks";

describe("PPR-025 declared execution graph", () => {
  test("validates cleanly (every edge structurally valid, ids unique)", () => {
    const issues = validateExecutionGraph(OPENWEBUI_EXECUTION_GRAPH);
    expect(issues).toEqual([]);
  });

  test("declares EVERY multi-modal surface the work order names (chat, local rail, embeddings, image, stt, tts)", () => {
    const surfaces = OPENWEBUI_EXECUTION_GRAPH.edges.map((edge) => edge.surface);
    expect(surfaces.filter((surface) => surface === "text-generation")).toHaveLength(2);
    expect(surfaces).toContain("embeddings");
    expect(surfaces).toContain("image-generation");
    expect(surfaces).toContain("speech-recognition");
    expect(surfaces).toContain("speech-generation");
    for (const edge of OPENWEBUI_EXECUTION_GRAPH.edges) {
      expect(isExecutionSurface(edge.surface)).toBe(true);
      expect(EXECUTION_SURFACES).toContain(edge.surface);
    }
  });

  test("the two chat edges are the two rails (the openai seam and the LOCAL-INFERENCE rail)", () => {
    const chatEdges = OPENWEBUI_EXECUTION_GRAPH.edges.filter(
      (edge) => edge.surface === "text-generation",
    );
    expect(chatEdges.map((edge) => edge.edgeId).sort()).toEqual(
      ["openwebui.chat.local-rail", "openwebui.chat.openai-rail"].sort(),
    );
    const localRail = chatEdges.find((edge) => edge.edgeId === "openwebui.chat.local-rail");
    expect(localRail?.materiality).toMatch(/local-vs-remote inference law/i);
  });

  test("every edge id is unique and the closed set matches", () => {
    const ids = OPENWEBUI_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...OPENWEBUI_EDGE_IDS].sort());
  });

  test("the embeddings edge records the deterministic representation + the supply boundary honestly", () => {
    const embeddings = OPENWEBUI_EXECUTION_GRAPH.edges.find(
      (edge) => edge.edgeId === "openwebui.rag.embeddings",
    );
    expect(embeddings?.materiality).toMatch(/deterministic lexical-hash/i);
    expect(embeddings?.materiality).toMatch(/404/);
    expect(embeddings?.materiality).toMatch(/never a fixture/i);
  });

  test("the edges carry no direct provider host in their delegated transport (the undelegated chain stays in externalExecution)", () => {
    for (const edge of OPENWEBUI_EXECUTION_GRAPH.edges) {
      expect(edge.transport).not.toMatch(/api\.openai\.com|api\.anthropic\.com|localhost:11434/);
      expect(edge.externalExecution).toMatch(/undelegated/i);
      expect(edge.materiality.length).toBeGreaterThan(20);
    }
  });

  test("the upstream pin is the exact proof-time revision", () => {
    expect(OPENWEBUI_UPSTREAM_REPOSITORY).toBe("https://github.com/open-webui/open-webui.git");
    expect(OPENWEBUI_UPSTREAM_REVISION).toBe("8bd8b4fac5e059578ac0c74b3c18d11139f88b7d");
    expect(OPENWEBUI_INTEGRATION_REVISION).toBe("1485ddd92202153f44c21f3eeb8b65f55322ac67");
  });
});

describe("PPR-025 discovered inventory + static no-bypass reconciliation", () => {
  test("the discovered inventory validates", () => {
    const issues = validateDiscoveredInventory(OPENWEBUI_DISCOVERED_INVENTORY);
    expect(issues).toEqual([]);
  });

  test("the reconciliation produces NO findings (every discovered edge declared, every declared edge discovered)", () => {
    const findings = reconcileExecutionGraph(OPENWEBUI_EXECUTION_GRAPH, OPENWEBUI_DISCOVERED_INVENTORY);
    expect(findings).toEqual([]);
    expect(hasHardCoverageDefect(findings)).toBe(false);
  });

  test("every discovered edge id is a declared edge id (the closed set)", () => {
    for (const edge of OPENWEBUI_DISCOVERED_INVENTORY.edges) {
      expect(OPENWEBUI_EDGE_IDS).toContain(edge.edgeId as (typeof OPENWEBUI_EDGE_IDS)[number]);
    }
  });

  test("every dormant seam carries a non-empty gate + owner (never silently out of scope)", () => {
    expect(OPENWEBUI_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(9);
    for (const seam of OPENWEBUI_DORMANT_SEAMS) {
      expect(seam.gate.length).toBeGreaterThan(20);
      expect(seam.owner.length).toBeGreaterThan(10);
    }
  });

  test("the local-model engines are disclosed as dormant (never silently unselected)", () => {
    const ids = OPENWEBUI_DORMANT_SEAMS.map((seam) => seam.edgeId);
    expect(ids).toContain("openwebui.rag.local-embedding-engine");
    expect(ids).toContain("openwebui.audio.stt-local-whisper");
    expect(ids).toContain("openwebui.websearch");
    expect(ids).toContain("openwebui.pipelines-external-rag");
  });
});

describe("PPR-025 corpus coverage (the multi-modal completeness rule)", () => {
  test("the corpus exercises EVERY declared edge (no chat-only certification)", () => {
    const declared = new Set(OPENWEBUI_EDGE_IDS);
    const exercised = new Set(CORPUS_EXERCISED_EDGE_IDS);
    for (const edgeId of declared) {
      expect(exercised.has(edgeId)).toBe(true);
    }
  });

  test("the corpus declares a RAG/retrieval task, an embedding-dependent task, image, STT and TTS", () => {
    const ids = CORPUS_TASKS.map((task) => task.taskId);
    expect(ids).toContain("openwebui-rag-grounded-qa");
    expect(ids).toContain("openwebui-memories-embeddings");
    expect(ids).toContain("openwebui-image-generation");
    expect(ids).toContain("openwebui-audio-transcription");
    expect(ids).toContain("openwebui-audio-speech");
    expect(ids).toContain("openwebui-local-rail-chat");
  });

  test("every task's edge declaration names only declared edges", () => {
    for (const task of CORPUS_TASKS) {
      expect(task.edges.length).toBeGreaterThan(0);
      for (const edgeId of task.edges) {
        expect(OPENWEBUI_EDGE_IDS).toContain(edgeId as (typeof OPENWEBUI_EDGE_IDS)[number]);
      }
    }
  });

  test("the non-AI operations are disclosed (the app's retained domain state)", () => {
    expect(OPENWEBUI_NON_AI_OPERATIONS.length).toBeGreaterThanOrEqual(6);
  });
});
