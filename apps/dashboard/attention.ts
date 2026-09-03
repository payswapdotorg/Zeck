/**
 * Zeck Attention primitive (WORK-035) — the v2 §23 attention model.
 *
 * Attention is the aggregation of CONSEQUENTIAL items only: decisions,
 * approvals, failed work and consequential recommendations. It is
 * explicitly NOT a routine notification center — routine lifecycle events
 * (queued, running, completed cleanly) belong to Activity and Evidence and
 * MUST NOT produce attention items (the discrimination test pins this).
 *
 * The primitive owns the attention VOCABULARY and presentation:
 *  - the four kinds with their symbols and labels (status is never
 *    communicated by color alone — symbol + kind label + text);
 *  - the attention card (kind-aware);
 *  - the attention area (the in-main region);
 *  - the header attention indicator (visible only when action is
 *    required);
 *  - the attention summary (the §23 aggregate: "2 decisions / 1 approval /
 *    1 failed execution / 1 improvement recommendation").
 *
 * WHERE the facts come from stays with the projection layer: today the
 * public API exposes executions, so the live derivation produces decision
 * and failed items from execution records. Approval and recommendation
 * facts are not exposed by the public API yet — the primitive supports
 * them (downstream Work Orders wire the sources); the attention page says
 * so honestly instead of fabricating any.
 */

import { esc } from "./components";

/**
 * The link guard: attention links are INTERNAL dashboard routes only — a
 * relative path that is not protocol-relative. Anything else (javascript:
 * schemes, absolute external URLs) is dropped rather than rendered: the
 * primitive never becomes an injection surface even if a hostile value
 * reaches it.
 */
export function isInternalHref(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//");
}

/** The v2 §23 attention kinds (the full vocabulary). */
export const ATTENTION_KINDS = ["decision", "approval", "failed", "recommendation"] as const;

export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const ATTENTION_KIND_META: Readonly<
  Record<AttentionKind, { readonly label: string; readonly symbol: string }>
> = {
  decision: { label: "Decision", symbol: "?" },
  approval: { label: "Approval", symbol: "!" },
  failed: { label: "Failed work", symbol: "✕" },
  recommendation: { label: "Recommendation", symbol: "↗" },
};

export interface AttentionLink {
  readonly label: string;
  readonly href: string;
}

/** One consequential attention item (kind required — no untyped items). */
export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly body: string;
  readonly links: readonly AttentionLink[];
}

/** The attention card: kind symbol + kind label + title + body + actions. */
export function attentionCard(item: AttentionItem): string {
  const meta = ATTENTION_KIND_META[item.kind];
  const links = item.links
    .filter((link) => isInternalHref(link.href))
    .map((link) => `<a href="${esc(link.href)}">${esc(link.label)}</a>`)
    .join(" ");
  return `<article class="attention-card attention-${esc(item.kind)}">
  <p class="attention-kind"><span aria-hidden="true">${esc(meta.symbol)}</span> ${esc(meta.label)}</p>
  <p class="card-title">${esc(item.title)}</p>
  <p class="card-body">${esc(item.body)}</p>
  ${links.length === 0 ? "" : `<p class="card-actions">${links}</p>`}
</article>`;
}

/** The in-main attention region (rendered only when items exist). */
export function attentionArea(items: readonly AttentionItem[]): string {
  if (items.length === 0) {
    return "";
  }
  return `<section class="attention-area" aria-label="Needs your attention">
  ${items.map(attentionCard).join("\n  ")}
</section>`;
}

/**
 * The header attention indicator (v2 §2): rendered ONLY when at least one
 * item needs action — attention never becomes a permanent fixture.
 */
export function attentionIndicator(count: number, href: string): string {
  if (count <= 0) {
    return "";
  }
  const one = count === 1 ? "1 item needs your attention" : `${count} items need your attention`;
  return `<a class="attention-indicator" href="${esc(href)}">
  <span aria-hidden="true">!</span> Attention
  <span class="count">${count}</span>
  <span class="visually-hidden">${esc(one)}</span>
</a>`;
}

/**
 * The §23 aggregate summary: counts per kind, only for kinds that occur,
 * in the canonical kind order — the "Attention: 2 decisions, 1 approval…"
 * shape. Never invents a kind with zero count.
 */
export function attentionSummary(items: readonly AttentionItem[]): string {
  if (items.length === 0) {
    return "";
  }
  const counts = new Map<AttentionKind, number>();
  for (const item of items) {
    counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  }
  const rows = ATTENTION_KINDS.filter((kind) => (counts.get(kind) ?? 0) > 0).map((kind) => {
    const count = counts.get(kind) ?? 0;
    const meta = ATTENTION_KIND_META[kind];
    const noun =
      kind === "decision"
        ? count === 1
          ? "decision"
          : "decisions"
        : kind === "approval"
          ? count === 1
            ? "approval"
            : "approvals"
          : kind === "failed"
            ? count === 1
              ? "failed execution"
              : "failed executions"
            : count === 1
              ? "improvement recommendation"
              : "improvement recommendations";
    return `<li><span class="kind-count">${count}</span><span><span aria-hidden="true">${esc(
      meta.symbol,
    )}</span> ${esc(noun)}</span></li>`;
  });
  return `<ul class="attention-summary">
  ${rows.join("\n  ")}
</ul>`;
}
