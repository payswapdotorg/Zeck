/**
 * PPR-023 edge attribution test — the deterministic content-derived
 * request→edge attribution (the precedence the adapter discloses):
 * media-understanding describe prompt + image parts → the image
 * understanding edge; image parts without the marker → the main agent
 * loop; plain text → the main agent loop; the media endpoints'
 * path-derived attributions.
 */

import { describe, expect, test } from "vitest";
import {
  ADAPTER_EDGE_IDS,
  attributeEdge,
  IMAGE_EDGE_ID,
  MEDIA_EDGE_BY_PATH,
  STT_EDGE_ID,
  TTS_EDGE_ID,
} from "../adapter/edges";
import { OPENCLAW_EDGE_IDS } from "../graph/execution-graph";

describe("PPR-023 adapter edge attribution", () => {
  test("a plain chat request attributes to the main agent loop", () => {
    const attribution = attributeEdge({
      model: "glm-4-plus",
      messages: [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Implement wordScore in game.js." },
      ],
    });
    expect(attribution.edgeId).toBe("openclaw.agent-loop.main");
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("agent-loop-default");
  });

  test("a media-understanding describe request (image parts + the describe marker) attributes to the image-understanding edge", () => {
    const attribution = attributeEdge({
      model: "glm-4.5v",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe the image in detail." },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("openclaw.media-understanding.image");
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("media-understanding-describe-prompt+image-parts");
  });

  test("image parts WITHOUT the describe marker (native vision / browser screenshots) attribute to the main loop", () => {
    const attribution = attributeEdge({
      model: "glm-4-plus",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the token from this page screenshot." },
            { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("openclaw.agent-loop.main");
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("image-content-parts-main-loop");
  });

  test("the describe marker WITHOUT image parts attributes to the main loop (no vision payload)", () => {
    const attribution = attributeEdge({
      model: "glm-4-plus",
      messages: [{ role: "user", content: "Describe the image you cannot see." }],
    });
    expect(attribution.edgeId).toBe("openclaw.agent-loop.main");
  });

  test("the media endpoints are attributed by path (one per tool surface)", () => {
    expect(MEDIA_EDGE_BY_PATH["audio/speech"]).toBe(TTS_EDGE_ID);
    expect(TTS_EDGE_ID).toBe("openclaw.tool.tts-openai");
    expect(MEDIA_EDGE_BY_PATH["audio/transcriptions"]).toBe(STT_EDGE_ID);
    expect(STT_EDGE_ID).toBe("openclaw.media-understanding.audio");
    expect(MEDIA_EDGE_BY_PATH["images/generations"]).toBe(IMAGE_EDGE_ID);
    expect(IMAGE_EDGE_ID).toBe("openclaw.tool.image-generate-openai");
  });

  test("the attribution's edge set is exactly the declared closed set", () => {
    expect([...ADAPTER_EDGE_IDS].sort()).toEqual([...OPENCLAW_EDGE_IDS].sort());
  });

  test("text parts are extracted from array content for the marker scan", () => {
    const attribution = attributeEdge({
      model: "glm-4.5v",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Please " },
            { type: "text", text: "Describe the image " },
            { type: "text", text: "for the record." },
            { type: "image_url", image_url: { url: "data:image/png;base64,CCCC" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("openclaw.media-understanding.image");
  });
});
