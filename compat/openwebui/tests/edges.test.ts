/**
 * PPR-025 edges test — the adapter's request→edge attribution: every
 * OpenAI-shaped chat request maps to the openai chat rail (main or
 * auxiliary by the app's OWN task-template signatures), vision content
 * parts record their signal, and the surface-derived attributions of the
 * media/embedding/local-rail endpoints are the closed declared set.
 */

import { describe, expect, test } from "vitest";
import {
  attributeEdge,
  EMBEDDINGS_EDGE_ID,
  IMAGE_EDGE_ID,
  LOCAL_RAIL_EDGE_ID,
  MAIN_EDGE_ID,
  OPENAI_CHAT_EDGE_ID,
  STT_EDGE_ID,
  TTS_EDGE_ID,
} from "../adapter/edges";
import { OPENWEBUI_EDGE_IDS } from "../graph/execution-graph";

const user = (content: unknown) => ({ role: "user", content });

describe("PPR-025 chat attribution (the openai rail)", () => {
  test("a plain conversation turn attributes to the main chat edge", () => {
    const attribution = attributeEdge({
      messages: [user("Reply with exactly the word NORTHWIND and nothing else.")],
      model: "glm-4-plus",
    });
    expect(attribution.edgeId).toBe(MAIN_EDGE_ID);
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("chat-turn-default");
  });

  test("the app's OWN title-generation template signature attributes to the auxiliary role", () => {
    const attribution = attributeEdge({
      messages: [
        user(
          "### Task:\nGenerate a concise title summarizing the chat history.\n### Guidelines:\n- keep it short",
        ),
      ],
      model: "glm-4-plus",
    });
    expect(attribution.edgeId).toBe(OPENAI_CHAT_EDGE_ID);
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("auxiliary-task:title_generation");
  });

  test("the tags-generation and follow-up template signatures attribute to the auxiliary role", () => {
    const tags = attributeEdge({
      messages: [
        user(
          "### Task:\nGenerate 1-3 broad tags categorizing the main themes of the chat history, along with 1-3 more specific subtopic tags.",
        ),
      ],
    });
    expect(tags.role).toBe("auxiliary");
    expect(tags.signals).toContain("auxiliary-task:tags_generation");
    const followUp = attributeEdge({
      messages: [
        user("### Task:\nSuggest 3-5 relevant follow-up questions or prompts that the user might naturally ask next."),
      ],
    });
    expect(followUp.role).toBe("auxiliary");
    expect(followUp.signals).toContain("auxiliary-task:follow_up_generation");
  });

  test("a plain turn that merely MENTIONS the template words does not misattribute (the full signature is required)", () => {
    const attribution = attributeEdge({
      messages: [user("Can you generate a concise title for my essay?")],
    });
    expect(attribution.role).toBe("main");
  });

  test("vision content parts record their signal on the same chat seam", () => {
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
});

describe("PPR-025 surface-derived attributions (the closed declared set)", () => {
  test("the surface edge constants are exactly the declared edges", () => {
    const surfaceEdges = [
      OPENAI_CHAT_EDGE_ID,
      LOCAL_RAIL_EDGE_ID,
      EMBEDDINGS_EDGE_ID,
      IMAGE_EDGE_ID,
      STT_EDGE_ID,
      TTS_EDGE_ID,
    ];
    expect([...surfaceEdges].sort()).toEqual([...OPENWEBUI_EDGE_IDS].sort());
  });

  test("the local rail edge is the Ollama-native chat seam (the local-vs-remote law)", () => {
    expect(LOCAL_RAIL_EDGE_ID).toBe("openwebui.chat.local-rail");
  });
});
