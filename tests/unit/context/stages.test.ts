/**
 * The five explicit compiler stages as individual testable units
 * (WORK-008 / CTX-001 criterion 1): intended behavior + negative case for
 * each stage.
 */

import { describe, expect, test } from "vitest";
import {
  applyCompressionStage,
  applyDeduplicationStage,
  applyRelevanceStage,
  applyRetrievalStage,
  applyStructureStage,
  type ContextCandidate,
} from "../../../src/modules/context/public";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

function candidate(overrides: Partial<ContextCandidate> & { content: string }): ContextCandidate {
  return {
    tenantId: TENANT_A,
    sourceId: "docs",
    locator: `loc-${overrides.content.length}`,
    title: "t",
    ...overrides,
  };
}

describe("stage 1: retrieval", () => {
  test("accepts same-tenant candidates and orders them deterministically regardless of input order", () => {
    const c1 = candidate({ content: "ccc", locator: "3" });
    const c2 = candidate({ content: "aaa", locator: "1" });
    const c3 = candidate({ content: "bbb", locator: "2" });
    const out = applyRetrievalStage({ tenantId: TENANT_A, candidates: [c1, c2, c3] });
    expect(out.foreign).toEqual([]);
    expect(out.accepted.map((c) => c.content)).toEqual(["aaa", "bbb", "ccc"]);
  });

  test("negative: foreign-tenant candidates are segregated, recorded with a reason, and sorted", () => {
    const own = candidate({ content: "aaa", locator: "1" });
    const f1 = candidate({ tenantId: TENANT_B, content: "zzz", locator: "9" });
    const f2 = candidate({ tenantId: TENANT_B, content: "yyy", locator: "8" });
    const out = applyRetrievalStage({ tenantId: TENANT_A, candidates: [f1, own, f2] });
    expect(out.accepted.map((c) => c.content)).toEqual(["aaa"]);
    expect(out.foreign.map((f) => f.candidate.content)).toEqual(["yyy", "zzz"]);
    expect(out.foreign.every((f) => f.reason === "tenant-mismatch")).toBe(true);
  });
});

describe("stage 2: relevance filtering", () => {
  const kw = ["invoice", "refund"];

  test("integer scoring ranks by score desc with deterministic tie order; exclusion recorded", () => {
    const high = candidate({ content: "invoice refund policy details", locator: "h" });
    const low = candidate({ content: "invoice mention", locator: "l" });
    const off = candidate({ content: "unrelated newsletter", locator: "o" });
    const out = applyRelevanceStage({
      candidates: [off, low, high],
      taskKeywords: kw,
      policy: { minScore: 1 },
    });
    expect(out.kept.map((k) => k.candidate.locator)).toEqual(["h", "l"]);
    expect(out.kept.map((k) => k.score)).toEqual([2, 1]);
    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.reason).toBe("below-minimum-score");
    expect(out.excluded[0]?.score).toBe(0);
  });

  test("negative: below-minimum candidates are excluded even when the corpus is small", () => {
    const out = applyRelevanceStage({
      candidates: [candidate({ content: "nothing relevant", locator: "x" })],
      taskKeywords: kw,
      policy: { minScore: 2 },
    });
    expect(out.kept).toEqual([]);
    expect(out.excluded).toHaveLength(1);
  });

  test("scoring is case-insensitive via term sets; each keyword counts once (integer discipline)", () => {
    const c = candidate({ content: "INVOICE invoice Invoice", locator: "i" });
    const out = applyRelevanceStage({ candidates: [c], taskKeywords: kw, policy: { minScore: 0 } });
    expect(out.kept[0]?.score).toBe(1);
  });

  test("pre-extracted terms are honored when provided", () => {
    const c = candidate({ content: "opaque-body", terms: ["Invoice", "REFUND"], locator: "t" });
    const out = applyRelevanceStage({ candidates: [c], taskKeywords: kw, policy: { minScore: 2 } });
    expect(out.kept[0]?.score).toBe(2);
  });
});

describe("stage 3: deduplication", () => {
  test("exact-content duplicates collapse onto the highest-ranked survivor; collapse recorded", () => {
    const ranked = [
      { candidate: candidate({ content: "same", locator: "first" }), score: 3 },
      { candidate: candidate({ content: "same", locator: "second" }), score: 2 },
      { candidate: candidate({ content: "same", locator: "third" }), score: 1 },
      { candidate: candidate({ content: "distinct", locator: "fourth" }), score: 1 },
    ];
    const out = applyDeduplicationStage({ ranked });
    expect(out.unique.map((u) => u.candidate.locator)).toEqual(["first", "fourth"]);
    expect(out.collapsedCount).toBe(2);
    expect(out.collapsedLocators).toEqual(["docs\u0000second", "docs\u0000third"]);
  });

  test("negative: near-identical content is NOT collapsed (exact-equality contract)", () => {
    const ranked = [
      { candidate: candidate({ content: "same ", locator: "a" }), score: 2 },
      { candidate: candidate({ content: "same", locator: "b" }), score: 1 },
    ];
    const out = applyDeduplicationStage({ ranked });
    expect(out.unique).toHaveLength(2);
    expect(out.collapsedCount).toBe(0);
  });
});

describe("stage 4: compression", () => {
  const policy = { perItemCharBudget: 20, totalCharBudget: 1000 };

  test("deterministic truncation with a marker; original size recorded; source kept", () => {
    const ranked = [
      {
        candidate: candidate({
          content: "012345678901234567890123456789",
          locator: "long",
          sourceId: "s",
        }),
        score: 2,
      },
    ];
    const out = applyCompressionStage({ ranked, policy });
    expect(out.items).toHaveLength(1);
    const item = out.items[0];
    expect(item?.content).toBe("01234567890123456...");
    expect(item?.content.length).toBe(20);
    expect(item?.truncated).toBe(true);
    expect(item?.originalChars).toBe(30);
    expect(item?.sourceId).toBe("s");
    expect(item?.locator).toBe("long");
  });

  test("byte-deterministic: identical input -> identical output across calls", () => {
    const ranked = [
      { candidate: candidate({ content: "abcdef".repeat(10), locator: "x" }), score: 1 },
      { candidate: candidate({ content: "short", locator: "y" }), score: 1 },
    ];
    const a = applyCompressionStage({ ranked, policy });
    const b = applyCompressionStage({ ranked, policy });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("negative: total budget drops lowest-ranked items tail-first and records every drop", () => {
    // RANKED order (score desc): l3 (3), l2 (2), l1 (1).
    const ranked = [
      { candidate: candidate({ content: "content-number-3", locator: "l3" }), score: 3 },
      { candidate: candidate({ content: "content-number-2", locator: "l2" }), score: 2 },
      { candidate: candidate({ content: "content-number-1", locator: "l1" }), score: 1 },
    ];
    const out = applyCompressionStage({
      ranked,
      policy: { perItemCharBudget: 15, totalCharBudget: 30 },
    });
    expect(out.droppedLocators).toEqual(["docs\u0000l1"]); // lowest-ranked (tail) dropped
    expect(out.items.map((i) => i.locator)).toEqual(["l3", "l2"]);
    expect(out.outputChars).toBeLessThanOrEqual(30);
  });

  test("short content passes through untouched (truncated=false)", () => {
    const out = applyCompressionStage({
      ranked: [{ candidate: candidate({ content: "tiny", locator: "t" }), score: 1 }],
      policy,
    });
    expect(out.items[0]?.content).toBe("tiny");
    expect(out.items[0]?.truncated).toBe(false);
  });
});

describe("stage 5: structural compilation", () => {
  test("sections are task + sources; every item carries a source reference; order deterministic", () => {
    const out = applyStructureStage({
      task: { summary: "Do the thing", keywords: ["thing"] },
      applicationId: "app-1",
      execution: { executionId: "018f1e10-0000-7000-8000-000000000001", applicationId: "app-1" },
      items: [
        {
          sourceId: "s1",
          locator: "l1",
          title: "first",
          content: "c1",
          truncated: false,
          originalChars: 2,
          compressedChars: 2,
        },
      ],
    });
    expect(out.sections.map((s) => s.id)).toEqual(["task", "sources"]);
    const task = out.sections[0]?.items[0];
    expect(task?.sourceRef).toEqual({
      kind: "request",
      id: "018f1e10-0000-7000-8000-000000000001",
      locator: "app-1",
    });
    expect(task?.content).toBe("Do the thing");
    const source = out.sections[1]?.items[0];
    expect(source?.sourceRef).toEqual({ kind: "source", id: "s1", locator: "l1" });
  });

  test("negative: empty items yield an empty sources section, never a missing one", () => {
    const out = applyStructureStage({
      task: { summary: "s" },
      applicationId: "a",
      execution: { executionId: "018f1e10-0000-7000-8000-000000000002", applicationId: "a" },
      items: [],
    });
    expect(out.sections).toHaveLength(2);
    expect(out.sections[1]?.items).toEqual([]);
  });
});
