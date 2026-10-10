/**
 * PPR-026 edges test — the adapter's request→edge attribution: every
 * OpenAI-shaped chat request maps to the generic-openai chat rail (main
 * role by default at the pinned revision — the naming surfaces are
 * browser-side, disclosed), vision content parts record their signal,
 * and the surface-derived attributions of the media/embedding/local-rail
 * endpoints are the closed declared set.
 */

import { describe, expect, test } from "vitest";
import {
  attributeEdge,
  CHAT_EDGE_BY_RAIL,
  EMBEDDINGS_EDGE_ID,
  LOCAL_RAIL_EDGE_ID,
  MAIN_EDGE_ID,
  OPENAI_CHAT_EDGE_ID,
  STT_EDGE_ID,
  TTS_EDGE_ID,
} from "../adapter/edges";
import { ANYTHINGLLM_EDGE_IDS } from "../graph/execution-graph";

const user = (content: unknown) => ({ role: "user", content });

describe("PPR-026 chat attribution (the generic-openai rail)", () => {
  test("a plain conversation turn attributes to the main chat edge", () => {
    const attribution = attributeEdge({
      messages: [user("Reply with exactly the word EASTGALE and nothing else.")],
      model: "glm-4-plus",
    });
    expect(attribution.edgeId).toBe(MAIN_EDGE_ID);
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("chat-turn-default");
  });

  test("at the pinned revision the server-side developer-API path emits single-role main turns (no auxiliary task templates server-side — disclosed in the graph)", () => {
    // The naming/title surfaces are browser-side at v1.17.0; the
    // auxiliary role stays a protocol-level capability never selected on
    // the certified path (the graph discloses this honestly).
    const attribution = attributeEdge({
      messages: [user("Generate a workspace title summarizing the chat history.")],
      model: "glm-4-plus",
    });
    expect(attribution.role).toBe("main");
  });

  test("vision content parts record their signal on the same chat seam (the pinned runtime's attachmentToContentBlock shape)", () => {
    const attribution = attributeEdge({
      messages: [
        user([
          { type: "text", text: "Is this image red?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ]),
      ],
      model: "glm-4.5v",
    });
    expect(attribution.edgeId).toBe(OPENAI_CHAT_EDGE_ID);
    expect(attribution.signals).toContain("vision-content-parts-openai-rail");
  });

  test("audio content parts (input_audio) do not trip the vision signal", () => {
    const attribution = attributeEdge({
      messages: [
        user([
          { type: "text", text: "What is in this audio?" },
          { type: "input_audio", input_audio: { data: "QUJD", format: "wav" } },
        ]),
      ],
      model: "glm-4-plus",
    });
    expect(attribution.edgeId).toBe(OPENAI_CHAT_EDGE_ID);
    expect(attribution.signals).not.toContain("vision-content-parts-openai-rail");
  });
});

describe("PPR-026 surface-derived attributions (the closed declared set)", () => {
  test("the surface edge constants are exactly the declared edges", () => {
    const surfaceEdges = [
      OPENAI_CHAT_EDGE_ID,
      LOCAL_RAIL_EDGE_ID,
      EMBEDDINGS_EDGE_ID,
      STT_EDGE_ID,
      TTS_EDGE_ID,
    ];
    expect([...surfaceEdges].sort()).toEqual([...ANYTHINGLLM_EDGE_IDS].sort());
  });

  test("the local rail edge is the Ollama-native chat seam (the local-vs-remote law)", () => {
    expect(LOCAL_RAIL_EDGE_ID).toBe("anythingllm.chat.local-rail");
  });

  test("the chat edge ids per rail form the closed rail map", () => {
    expect(CHAT_EDGE_BY_RAIL.openai).toBe("anythingllm.chat.openai-rail");
    expect(CHAT_EDGE_BY_RAIL.ollama).toBe("anythingllm.chat.local-rail");
  });
});
