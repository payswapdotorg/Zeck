/**
 * PPR-022 edge-attribution tests — every request class the pinned
 * Hermes runtime sends is attributed to exactly one declared edge,
 * deterministically, from the wire's own content markers.
 */

import { describe, expect, test } from "vitest";
import {
  attributeEdge,
  IMAGE_EDGE_ID,
  MEDIA_EDGE_BY_PATH,
  STT_EDGE_ID,
  TTS_EDGE_ID,
} from "../adapter/edges";
import { HERMES_EDGE_IDS } from "../graph/execution-graph";

const TITLE_SYSTEM = {
  role: "system",
  content:
    "You name chat sessions. Given the user's opening message, write a title that lets them find this conversation again in a list.\n\nReply with JSON only: {\"title\": \"...\"}",
};

const COMPRESSION_USER = {
  role: "user",
  content:
    "You are a summarization agent creating a context checkpoint. Treat the conversation turns below as source material...",
};

const AGENT_SYSTEM = {
  role: "system",
  content: "You are Hermes Agent, built by Nous Research. Be direct...",
};

describe("PPR-022 request→edge attribution", () => {
  test("the automatic session-title call is attributed to the title-generation aux edge", () => {
    const attribution = attributeEdge({
      messages: [TITLE_SYSTEM, { role: "user", content: "Reply with exactly: PROBE-OK" }],
    });
    expect(attribution.edgeId).toBe("hermes.auxiliary.title-generation");
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("title-system-prompt");
  });

  test("the compression summarizer call is attributed to the compression aux edge", () => {
    const attribution = attributeEdge({
      messages: [COMPRESSION_USER],
    });
    expect(attribution.edgeId).toBe("hermes.auxiliary.compression");
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("compression-prompt-prefix");
  });

  test("an image-carrying request is attributed to the vision-analyze aux edge", () => {
    const attribution = attributeEdge({
      messages: [
        AGENT_SYSTEM,
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Fully describe and explain everything about this image, then answer the following question:\n\nWhat color?",
            },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("hermes.auxiliary.vision-analyze");
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("vision-analyze-prompt+image-parts");
  });

  test("a plain agent turn is attributed to the main edge (the default)", () => {
    const attribution = attributeEdge({
      messages: [AGENT_SYSTEM, { role: "user", content: "Write SMOKE-OUT into out.txt." }],
    });
    expect(attribution.edgeId).toBe("hermes.agent-loop.main");
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("agent-loop-default");
  });

  test("the title marker wins over a plain agent system prompt (fixed precedence)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: `${AGENT_SYSTEM.content}\n\n${TITLE_SYSTEM.content}` },
        { role: "user", content: "hello" },
      ],
    });
    expect(attribution.edgeId).toBe("hermes.auxiliary.title-generation");
  });

  test("the media endpoints' path-derived attributions cover the three tool surfaces", () => {
    expect(MEDIA_EDGE_BY_PATH["audio/speech"]).toBe(TTS_EDGE_ID);
    expect(MEDIA_EDGE_BY_PATH["audio/transcriptions"]).toBe(STT_EDGE_ID);
    expect(MEDIA_EDGE_BY_PATH["images/generations"]).toBe(IMAGE_EDGE_ID);
  });

  test("every attribution target is a declared edge (the closed set)", () => {
    const declared = new Set(HERMES_EDGE_IDS);
    const samples = [
      attributeEdge({ messages: [TITLE_SYSTEM, { role: "user", content: "x" }] }),
      attributeEdge({ messages: [COMPRESSION_USER] }),
      attributeEdge({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "q" },
              { type: "image_url", image_url: { url: "data:image/png;base64,B" } },
            ],
          },
        ],
      }),
      attributeEdge({ messages: [AGENT_SYSTEM, { role: "user", content: "x" }] }),
    ];
    for (const attribution of samples) {
      expect(declared.has(attribution.edgeId)).toBe(true);
    }
    for (const edgeId of [TTS_EDGE_ID, STT_EDGE_ID, IMAGE_EDGE_ID]) {
      expect(declared.has(edgeId)).toBe(true);
    }
  });
});
