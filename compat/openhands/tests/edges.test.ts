/**
 * PPR-020 edge-attribution tests — the deterministic content-derived
 * request→edge attribution (adapter/edges.ts), pinned per class and per
 * precedence (oracle > condenser > subagent > vision > main).
 */

import { describe, expect, test } from "vitest";
import { attributeEdge } from "../adapter/edges";

const MAIN_SYSTEM = "You are OpenHands agent, a helpful AI assistant.";
const ORACLE_SYSTEM =
  "You are the Oracle: a highly capable reviewer giving a second opinion to an OpenHands agent.";
const CONDENSER_USER =
  "You are maintaining a context-aware state summary for an interactive agent.\nYou will be given a list of events…";
const SUBAGENT_SYSTEM =
  "You are a workspace exploration specialist. Your sole interface is the terminal.";

describe("PPR-020 request→edge attribution", () => {
  test("a plain agent-loop request attributes to the main edge", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: MAIN_SYSTEM },
        { role: "user", content: "Read a.txt and append its first word." },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.agent-loop.main");
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("agent-loop-default");
  });

  test("the oracle system prompt attributes to the ask-oracle edge (auxiliary)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: ORACLE_SYSTEM },
        { role: "user", content: "Question:\nWhat is 17 times 23?" },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.tool.ask-oracle");
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("oracle-system-prompt");
  });

  test("the condenser's single-user-message summarization prompt attributes to the condenser edge", () => {
    const attribution = attributeEdge({
      messages: [{ role: "user", content: CONDENSER_USER }],
    });
    expect(attribution.edgeId).toBe("openhands.condenser.llm-summarize");
    expect(attribution.role).toBe("auxiliary");
    expect(attribution.signals).toContain("condenser-user-prompt");
  });

  test("a sub-agent definition system prompt attributes to the task-loop edge", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: SUBAGENT_SYSTEM },
        { role: "user", content: "Find the secret word in notes/secret.txt." },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.subagent.task-loop");
    expect(attribution.signals[0]).toMatch(/^subagent-system-prompt:/);
  });

  test("image content parts attribute to the vision edge", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: MAIN_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "What is the dominant color?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.agent-loop.vision");
    expect(attribution.signals).toContain("image-content-parts");
  });

  test("the oracle marker wins over vision content (fixed precedence)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: ORACLE_SYSTEM },
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
        },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.tool.ask-oracle");
  });

  test("the condenser marker wins over the subagent and vision markers (fixed precedence)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: SUBAGENT_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: CONDENSER_USER },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.condenser.llm-summarize");
  });

  test("a tool-role history in a main-loop request stays on the main edge", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: MAIN_SYSTEM },
        { role: "user", content: "Run node verify.js" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "terminal", arguments: "{}" } }],
        } as unknown as { role: string; content: unknown },
        { role: "tool", content: "GAME-OK", tool_call_id: "c1" } as unknown as {
          role: string;
          content: unknown;
        },
      ],
    });
    expect(attribution.edgeId).toBe("openhands.agent-loop.main");
  });

  test("attribution is total: every declared edge is reachable", () => {
    const seen = new Set(
      [
        attributeEdge({ messages: [{ role: "system", content: MAIN_SYSTEM }, { role: "user", content: "x" }] }),
        attributeEdge({ messages: [{ role: "system", content: ORACLE_SYSTEM }, { role: "user", content: "x" }] }),
        attributeEdge({ messages: [{ role: "user", content: CONDENSER_USER }] }),
        attributeEdge({ messages: [{ role: "system", content: SUBAGENT_SYSTEM }, { role: "user", content: "x" }] }),
        attributeEdge({
          messages: [
            { role: "system", content: MAIN_SYSTEM },
            { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,A" } }] },
          ],
        }),
      ].map((a) => a.edgeId),
    );
    expect([...seen].sort()).toEqual([
      "openhands.agent-loop.main",
      "openhands.agent-loop.vision",
      "openhands.condenser.llm-summarize",
      "openhands.subagent.task-loop",
      "openhands.tool.ask-oracle",
    ]);
  });
});
