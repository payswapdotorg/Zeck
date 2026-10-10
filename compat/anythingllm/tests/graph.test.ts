/**
 * PPR-026 graph test — the declared multi-modal execution graph validates
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
  ANYTHINGLLM_DISCOVERED_INVENTORY,
  ANYTHINGLLM_DORMANT_SEAMS,
  ANYTHINGLLM_EDGE_IDS,
  ANYTHINGLLM_EXECUTION_GRAPH,
  ANYTHINGLLM_INTEGRATION_REVISION,
  ANYTHINGLLM_NON_AI_OPERATIONS,
  ANYTHINGLLM_UPSTREAM_REPOSITORY,
  ANYTHINGLLM_UPSTREAM_REVISION,
} from "../graph/execution-graph";
import { CORPUS_EXERCISED_EDGE_IDS, CORPUS_TASKS } from "../corpus/tasks";

describe("PPR-026 declared execution graph", () => {
  test("validates cleanly (every edge structurally valid, ids unique)", () => {
    const issues = validateExecutionGraph(ANYTHINGLLM_EXECUTION_GRAPH);
    expect(issues).toEqual([]);
  });

  test("declares EVERY multi-modal surface the work order names (chat/generation on both rails, embeddings, stt, tts)", () => {
    const surfaces = ANYTHINGLLM_EXECUTION_GRAPH.edges.map((edge) => edge.surface);
    expect(surfaces.filter((surface) => surface === "text-generation")).toHaveLength(2);
    expect(surfaces).toContain("embeddings");
    expect(surfaces).toContain("speech-recognition");
    expect(surfaces).toContain("speech-generation");
    for (const edge of ANYTHINGLLM_EXECUTION_GRAPH.edges) {
      expect(isExecutionSurface(edge.surface)).toBe(true);
      expect(EXECUTION_SURFACES).toContain(edge.surface);
    }
  });

  test("the two chat edges are the two rails (the generic-openai seam and the LOCAL-INFERENCE rail)", () => {
    const chatEdges = ANYTHINGLLM_EXECUTION_GRAPH.edges.filter(
      (edge) => edge.surface === "text-generation",
    );
    expect(chatEdges.map((edge) => edge.edgeId).sort()).toEqual(
      ["anythingllm.chat.local-rail", "anythingllm.chat.openai-rail"].sort(),
    );
    const localRail = chatEdges.find((edge) => edge.edgeId === "anythingllm.chat.local-rail");
    expect(localRail?.materiality).toMatch(/local-vs-remote inference law/i);
  });

  test("every edge id is unique and the closed set matches", () => {
    const ids = ANYTHINGLLM_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...ANYTHINGLLM_EDGE_IDS].sort());
  });

  test("the embeddings edge records the deterministic representation + the supply boundary honestly", () => {
    const embeddings = ANYTHINGLLM_EXECUTION_GRAPH.edges.find(
      (edge) => edge.edgeId === "anythingllm.rag.embeddings",
    );
    expect(embeddings?.materiality).toMatch(/deterministic lexical-hash/i);
    expect(embeddings?.materiality).toMatch(/404/);
    expect(embeddings?.materiality).toMatch(/never a fixture/i);
  });

  test("the edges carry no direct provider host in their delegated transport (the undelegated chain stays in externalExecution)", () => {
    for (const edge of ANYTHINGLLM_EXECUTION_GRAPH.edges) {
      expect(edge.transport).not.toMatch(/api\.openai\.com|api\.anthropic\.com|localhost:11434/);
      expect(edge.externalExecution).toMatch(/undelegated/i);
      expect(edge.materiality.length).toBeGreaterThan(20);
    }
  });

  test("the upstream pin is the exact proof-time revision", () => {
    expect(ANYTHINGLLM_UPSTREAM_REPOSITORY).toBe("https://github.com/Mintplex-Labs/anything-llm.git");
    expect(ANYTHINGLLM_UPSTREAM_REVISION).toBe("fa7ec877f005a21ede94888b3b8618b700343857");
    expect(ANYTHINGLLM_INTEGRATION_REVISION).toBe("a8ffc9e2c93b38e60c3fa5cec8591a22dfc5be86");
  });
});

describe("PPR-026 discovered inventory + static no-bypass reconciliation", () => {
  test("the discovered inventory validates", () => {
    const issues = validateDiscoveredInventory(ANYTHINGLLM_DISCOVERED_INVENTORY);
    expect(issues).toEqual([]);
  });

  test("the reconciliation produces NO findings (every discovered edge declared, every declared edge discovered)", () => {
    const findings = reconcileExecutionGraph(ANYTHINGLLM_EXECUTION_GRAPH, ANYTHINGLLM_DISCOVERED_INVENTORY);
    expect(findings).toEqual([]);
    expect(hasHardCoverageDefect(findings)).toBe(false);
  });

  test("every discovered edge id is a declared edge id (the closed set)", () => {
    for (const edge of ANYTHINGLLM_DISCOVERED_INVENTORY.edges) {
      expect(ANYTHINGLLM_EDGE_IDS).toContain(edge.edgeId as (typeof ANYTHINGLLM_EDGE_IDS)[number]);
    }
  });

  test("every dormant seam carries a non-empty gate + owner (never silently out of scope)", () => {
    expect(ANYTHINGLLM_DORMANT_SEAMS.length).toBeGreaterThanOrEqual(9);
    for (const seam of ANYTHINGLLM_DORMANT_SEAMS) {
      expect(seam.gate.length).toBeGreaterThan(20);
      expect(seam.owner.length).toBeGreaterThan(10);
    }
  });

  test("the local-model engines, alternative providers and agent surfaces are disclosed as dormant (never silently unselected)", () => {
    const ids = ANYTHINGLLM_DORMANT_SEAMS.map((seam) => seam.edgeId);
    expect(ids).toContain("anythingllm.embeddings.native-transformers");
    expect(ids).toContain("anythingllm.chat.alternative-providers");
    expect(ids).toContain("anythingllm.images.agent-skill");
    expect(ids).toContain("anythingllm.agent-flows");
    expect(ids).toContain("anythingllm.ollama.direct-localhost");
  });
});

describe("PPR-026 corpus coverage (the multi-modal completeness rule)", () => {
  test("the corpus exercises EVERY declared edge (no chat-only certification)", () => {
    const declared = new Set(ANYTHINGLLM_EDGE_IDS);
    const exercised = new Set(CORPUS_EXERCISED_EDGE_IDS);
    for (const edgeId of declared) {
      expect(exercised.has(edgeId)).toBe(true);
    }
  });

  test("the corpus declares a RAG/retrieval task, an embedding-dependent task, STT, TTS and the local rail", () => {
    const ids = CORPUS_TASKS.map((task) => task.taskId);
    expect(ids).toContain("anythingllm-chat-basic");
    expect(ids).toContain("anythingllm-embed-document");
    expect(ids).toContain("anythingllm-rag-grounded-qa");
    expect(ids).toContain("anythingllm-audio-transcription");
    expect(ids).toContain("anythingllm-audio-speech");
    expect(ids).toContain("anythingllm-local-rail-chat");
  });

  test("every task's edge declaration names only declared edges", () => {
    for (const task of CORPUS_TASKS) {
      expect(task.edges.length).toBeGreaterThan(0);
      for (const edgeId of task.edges) {
        expect(ANYTHINGLLM_EDGE_IDS).toContain(edgeId as (typeof ANYTHINGLLM_EDGE_IDS)[number]);
      }
    }
  });

  test("the non-AI operations are disclosed (the app's retained domain state — the PRESERVED-STATE LAW)", () => {
    expect(ANYTHINGLLM_NON_AI_OPERATIONS.length).toBeGreaterThanOrEqual(6);
  });
});
