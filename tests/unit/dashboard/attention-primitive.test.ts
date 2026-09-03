/**
 * Attention primitive tests (WORK-035) — the v2 §23 attention model.
 *
 * The contract under test:
 *  - the vocabulary is exactly the four consequential kinds
 *    (decision / approval / failed / recommendation) with symbol + label
 *    — status is NEVER color alone;
 *  - the card carries the kind, title, body and action links, all
 *    escaped;
 *  - the area renders only when items exist;
 *  - the header indicator renders ONLY when action is required (count >
 *    0) with an accessible label;
 *  - the aggregate summary counts per kind in canonical order and never
 *    invents a zero-count kind;
 *  - DISCRIMINATION (the anti-notification-center rule): the LIVE
 *    derivation produces attention ONLY for WAITING_USER/WAITING_HUMAN
 *    (decision) and FAILED (failed) executions — routine lifecycle
 *    states (CREATED/QUEUED/RUNNING/COMPLETED/CANCELLED) NEVER produce
 *    attention items.
 */

import { describe, expect, test } from "vitest";
import {
  ATTENTION_KIND_META,
  ATTENTION_KINDS,
  type AttentionItem,
  attentionArea,
  attentionCard,
  attentionIndicator,
  attentionSummary,
} from "../../../apps/dashboard/attention";
import { deriveAttention } from "../../../apps/dashboard/projection";
import type { Execution } from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
const APPLICATION_ID = "00000000-0000-7000-8000-0000000000a1";

function executionAt(status: Execution["status"]): Execution {
  return {
    id: EXECUTION_ID,
    applicationId: APPLICATION_ID,
    environmentId: null,
    status,
    task: { kind: "outcome", description: "Contract risk analysis" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: null,
  };
}

const DECISION: AttentionItem = {
  kind: "decision",
  title: "Decision needed",
  body: '"Contract risk analysis" is waiting for your decision.',
  links: [{ label: "Open the execution", href: `/runs/${EXECUTION_ID}` }],
};

describe("the attention vocabulary (v2 §23)", () => {
  test("the kinds are exactly the four consequential ones, each with symbol + label", () => {
    expect([...ATTENTION_KINDS]).toEqual(["decision", "approval", "failed", "recommendation"]);
    for (const kind of ATTENTION_KINDS) {
      const meta = ATTENTION_KIND_META[kind];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.symbol.length).toBeGreaterThan(0);
    }
  });

  test("the card renders symbol + kind label + title + body + links (never color alone)", () => {
    const html = attentionCard(DECISION);
    expect(html).toContain("attention-decision");
    expect(html).toContain('aria-hidden="true">?</span>');
    expect(html).toContain("Decision</p>");
    expect(html).toContain("Decision needed");
    expect(html).toContain("waiting for your decision");
    expect(html).toContain(`href="/runs/${EXECUTION_ID}"`);
  });

  test("every kind renders its own symbol + label", () => {
    for (const kind of ATTENTION_KINDS) {
      const item: AttentionItem = {
        kind,
        title: `A ${kind}`,
        body: "Body",
        links: [],
      };
      const html = attentionCard(item);
      expect(html).toContain(`attention-${kind}`);
      expect(html).toContain(ATTENTION_KIND_META[kind].label);
      expect(html).toContain(ATTENTION_KIND_META[kind].symbol);
      // No links ⇒ no empty actions paragraph.
      expect(html).not.toContain("card-actions");
    }
  });

  test("the area renders only when items exist (Home keeps its hierarchy otherwise)", () => {
    expect(attentionArea([])).toBe("");
    const html = attentionArea([DECISION]);
    expect(html).toContain('aria-label="Needs your attention"');
    expect(html).toContain("attention-card");
  });

  test("hostile content in the card is escaped and hostile hrefs are dropped", () => {
    const hostile: AttentionItem = {
      kind: "failed",
      title: '<script>alert("x")</script>',
      body: 'x" onmouseover="alert(1)',
      links: [
        { label: '"><a href="http://evil', href: "javascript:alert(1)" },
        { label: "protocol-relative", href: "//evil.example/x" },
        { label: "absolute external", href: "https://evil.example/x" },
        { label: "internal", href: "/runs/safe" },
      ],
    };
    const html = attentionCard(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    // Only the internal route link survives; javascript:/external/protocol-
    // relative hrefs are dropped entirely (the primitive is safe by
    // construction, not by caller discipline).
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("//evil.example");
    expect(html).not.toContain("https://evil.example");
    expect(html).toContain('href="/runs/safe"');
  });
});

describe("the header attention indicator (v2 §2: only when action is required)", () => {
  test("zero items render NO indicator (attention is not a permanent fixture)", () => {
    expect(attentionIndicator(0, "/attention")).toBe("");
  });

  test("a positive count renders the symbol, the count and the accessible label", () => {
    const html = attentionIndicator(2, "/attention");
    expect(html).toContain('class="attention-indicator"');
    expect(html).toContain('href="/attention"');
    expect(html).toContain("Attention");
    expect(html).toContain('<span class="count">2</span>');
    expect(html).toContain("2 items need your attention");
  });

  test("singular phrasing for one item", () => {
    expect(attentionIndicator(1, "/attention")).toContain("1 item needs your attention");
  });
});

describe("the aggregate summary (v2 §23: counts per kind, no zero-count kinds)", () => {
  test("an empty list renders no summary", () => {
    expect(attentionSummary([])).toBe("");
  });

  test("counts aggregate per kind in canonical order with symbols", () => {
    const items: AttentionItem[] = [
      DECISION,
      { ...DECISION, title: "Second decision" },
      { kind: "failed", title: "F", body: "b", links: [] },
      { kind: "recommendation", title: "R", body: "b", links: [] },
    ];
    const html = attentionSummary(items);
    expect(html).toContain("attention-summary");
    expect(html).toContain('<span class="kind-count">2</span>');
    expect(html).toContain("decisions");
    expect(html).toContain("1</span>");
    expect(html).toContain("failed execution");
    expect(html).toContain("improvement recommendation");
    // The absent kind never appears (no fabricated zero counts).
    expect(html).not.toContain("approval");
  });
});

describe("DISCRIMINATION: the live derivation is consequential-only (never a notification center)", () => {
  test("routine lifecycle states NEVER produce attention items", () => {
    const routine: readonly Execution["status"][] = [
      "CREATED",
      "AUTHORIZED",
      "PLANNING",
      "QUEUED",
      "RUNNING",
      "REPLANNING",
      "VERIFYING",
      "COMPLETED",
      "CANCELLED",
      "EXPIRED",
      "WAITING_TOOL",
    ];
    for (const status of routine) {
      expect(deriveAttention([executionAt(status)]), status).toHaveLength(0);
    }
  });

  test("WAITING_USER / WAITING_HUMAN produce decision items; FAILED produces a failed item", () => {
    const decision = deriveAttention([executionAt("WAITING_USER")]);
    expect(decision).toHaveLength(1);
    expect(decision[0]?.kind).toBe("decision");
    expect(decision[0]?.body).toContain("normal governed state");
    const human = deriveAttention([executionAt("WAITING_HUMAN")]);
    expect(human[0]?.kind).toBe("decision");
    const failed = deriveAttention([executionAt("FAILED")]);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.kind).toBe("failed");
    expect(failed[0]?.links.some((link) => link.href.includes("outcome="))).toBe(true);
  });

  test("multiple executions aggregate with the recents order preserved", () => {
    const items = deriveAttention([
      executionAt("RUNNING"),
      executionAt("WAITING_USER"),
      executionAt("FAILED"),
      executionAt("COMPLETED"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["decision", "failed"]);
  });
});
