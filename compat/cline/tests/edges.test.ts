/**
 * PPR-019 edge-attribution tests — the deterministic content-derived
 * request→edge attribution (adapter/edges.ts), pinned per class and per
 * precedence.
 */

import { describe, expect, test } from "vitest";
import { attributeEdge } from "../adapter/edges";

const COMPACTION_SYSTEM =
  "Summarize the provided coding session into a concise continuation note with detailed next steps.";

describe("PPR-019 request→edge attribution", () => {
  test("a plain act-mode request attributes to the act edge", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: "You are Cline, an AI coding agent." },
        { role: "user", content: "Add a function to game.js." },
      ],
    });
    expect(attribution.edgeId).toBe("cline.agent-loop.act");
    expect(attribution.role).toBe("main");
    expect(attribution.signals).toContain("act-mode-default");
  });

  test("the pinned plan-mode contract marker attributes to the plan edge", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: "You are Cline.\n\n# Plan Mode\n\nYou are in Plan mode." },
        { role: "user", content: "Plan the change." },
      ],
    });
    expect(attribution.edgeId).toBe("cline.agent-loop.plan");
  });

  test("image content parts attribute to the vision edge (over plan and act)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: "You are Cline.\n\n# Plan Mode\n\nYou are in Plan mode." },
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    });
    expect(attribution.edgeId).toBe("cline.agent-loop.vision");
    expect(attribution.signals).toContain("image-content-parts");
  });

  test("a reasoning-effort control attributes to the reasoning edge (over plan and act)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: "You are Cline.\n\n# Plan Mode" },
        { role: "user", content: "Solve it." },
      ],
      reasoningEffort: "high",
    });
    expect(attribution.edgeId).toBe("cline.agent-loop.reasoning");
    expect(attribution.signals).toContain("reasoning-effort:high");
  });

  test("the agentic-compaction summarizer prompt attributes to the auxiliary edge (highest precedence)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: COMPACTION_SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "summarize" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
      reasoningEffort: "high",
    });
    expect(attribution.edgeId).toBe("cline.compaction.agentic");
    expect(attribution.role).toBe("auxiliary");
  });

  test("vision outranks reasoning which outranks plan (the fixed precedence)", () => {
    const vision = attributeEdge({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
      reasoningEffort: "high",
    });
    expect(vision.edgeId).toBe("cline.agent-loop.vision");
    const reasoning = attributeEdge({
      messages: [{ role: "system", content: "# Plan Mode" }, { role: "user", content: "x" }],
      reasoningEffort: "medium",
    });
    expect(reasoning.edgeId).toBe("cline.agent-loop.reasoning");
  });

  test("tool-call history and tool-role messages attribute by their content class (act default)", () => {
    const attribution = attributeEdge({
      messages: [
        { role: "system", content: "You are Cline." },
        { role: "user", content: "read the file" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_files", arguments: "{}" } }],
        } as unknown as { role: string; content: unknown },
        { role: "tool", tool_call_id: "call_1", content: "file contents here" } as unknown as {
          role: string;
          content: unknown;
        },
      ],
    });
    expect(attribution.edgeId).toBe("cline.agent-loop.act");
  });

  test("an empty reasoning effort string does not trigger the reasoning edge", () => {
    const attribution = attributeEdge({
      messages: [{ role: "system", content: "You are Cline." }, { role: "user", content: "hi" }],
      reasoningEffort: "",
    });
    expect(attribution.edgeId).toBe("cline.agent-loop.act");
  });
});
