/**
 * PPR-018 edge attribution tests: the pinned revision's prompt
 * signatures route every adapter request to the correct declared edge.
 */

import { describe, expect, test } from "vitest";
import { attributeEdge, EDGE_COMMIT, EDGE_MAIN, EDGE_SUMMARIZER } from "../adapter/edges";

const COMMIT_SYSTEM =
  "You are an expert software engineer that generates concise, one-line Git commit messages based on the provided diffs.\nReview the provided context and diffs which are about to be committed to a git repo.\n…";

const SUMMARIZE_SYSTEM =
  "*Briefly* summarize this partial conversation about programming.\nInclude less detail about older parts…";

const MAIN_SYSTEM = "Act as an expert software engineer…";

describe("edge attribution by pinned prompt signature", () => {
  test("the commit-message system prompt attributes to the weak-model edge", () => {
    const attribution = attributeEdge({
      model: "zeck-weak",
      messages: [
        { role: "system", content: COMMIT_SYSTEM },
        { role: "user", content: "diff --git a/game.py" },
      ],
    });
    expect(attribution.edgeId).toBe(EDGE_COMMIT);
    expect(attribution.role).toBe("weak");
  });

  test("the summarize system prompt attributes to the summarizer edge", () => {
    const attribution = attributeEdge({
      model: "zeck-weak",
      messages: [
        { role: "system", content: SUMMARIZE_SYSTEM },
        { role: "user", content: "# USER\n…" },
      ],
    });
    expect(attribution.edgeId).toBe(EDGE_SUMMARIZER);
    expect(attribution.role).toBe("summarizer");
  });

  test("anything else attributes to the main completion edge", () => {
    const attribution = attributeEdge({
      model: "zeck-coder",
      messages: [
        { role: "system", content: MAIN_SYSTEM },
        { role: "user", content: "implement word_score" },
      ],
    });
    expect(attribution.edgeId).toBe(EDGE_MAIN);
    expect(attribution.role).toBe("main");
  });

  test("a request without a system message still attributes to main", () => {
    const attribution = attributeEdge({
      model: "zeck-coder",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(attribution.edgeId).toBe(EDGE_MAIN);
  });

  test("near-miss prompts do not false-positive on the signatures", () => {
    const attribution = attributeEdge({
      model: "zeck-coder",
      messages: [
        {
          role: "system",
          content: "You are an expert software engineer. Write concise commit messages for humans.",
        },
        { role: "user", content: "…" },
      ],
    });
    expect(attribution.edgeId).toBe(EDGE_MAIN);
  });
});
