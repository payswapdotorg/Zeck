/**
 * PPR-024 adapter edge attribution test — every inbound chat request
 * rides the ONE model seam (vision content parts recorded as a signal),
 * and the substrate endpoints attribute to their declared edges.
 */

import { describe, expect, test } from "vitest";
import {
  ACTION_EDGE_ID,
  attributeEdge,
  MAIN_EDGE_ID,
  SESSION_EDGE_ID,
  STATE_EDGE_ID,
  SUBSTRATE_EDGE_BY_OP,
} from "../adapter/edges";
import { BROWSER_USE_EDGE_IDS } from "../graph/execution-graph";

describe("PPR-024 chat edge attribution", () => {
  test("every chat request attributes to the main model seam", () => {
    const attribution = attributeEdge({
      messages: [{ role: "user", content: "anything" }],
      model: "glm-4-plus",
    });
    expect(attribution.edgeId).toBe(MAIN_EDGE_ID);
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("agent-loop-default");
  });

  test("vision content parts are a signal on the SAME seam (not a second edge)", () => {
    const attribution = attributeEdge({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
          ],
        },
      ],
      model: "glm-4-plus",
    });
    expect(attribution.edgeId).toBe(MAIN_EDGE_ID);
    expect(attribution.signals).toContain("vision-content-parts-main-seam");
  });

  test("text parts inside array content do not confuse the vision signal", () => {
    const attribution = attributeEdge({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "pure text parts" }],
        },
      ],
      model: "glm-4-plus",
    });
    expect(attribution.signals).not.toContain("vision-content-parts-main-seam");
  });
});

describe("PPR-024 substrate edge attribution", () => {
  test("every substrate endpoint maps to its declared edge", () => {
    expect(SUBSTRATE_EDGE_BY_OP["substrate/session"]).toBe(SESSION_EDGE_ID);
    expect(SUBSTRATE_EDGE_BY_OP["substrate/state"]).toBe(STATE_EDGE_ID);
    expect(SUBSTRATE_EDGE_BY_OP["substrate/action"]).toBe(ACTION_EDGE_ID);
  });

  test("the closed edge set covers the model seam plus the three substrate edges", () => {
    expect([...BROWSER_USE_EDGE_IDS].sort()).toEqual(
      [
        "browseruse.agent-loop.main",
        "browseruse.substrate.action",
        "browseruse.substrate.session",
        "browseruse.substrate.state-extraction",
      ].sort(),
    );
  });
});
