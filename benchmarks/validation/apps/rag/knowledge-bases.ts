/**
 * The synthetic knowledge bases (VAL-011) with deterministic retrieval.
 *
 * Each KB is a set of chunks (stable identities, embedded text, sha256
 * digests). Retrieval is DETERMINISTIC in-lab keyword scoring — no
 * external vector store, no environment, no randomness: the same
 * question always retrieves the same chunks in the same order. Ground
 * truth answers travel with the corpus rows (VAL-003); this module owns
 * only the provisioned knowledge.
 */

import { createHash } from "node:crypto";

export interface KnowledgeChunk {
  readonly chunkId: string;
  readonly text: string;
}

const chunk = (chunkId: string, text: string): KnowledgeChunk => ({ chunkId, text });

// ---------------------------------------------------------------------------
// kb-synthetic-policies-v1 — the synthetic policy knowledge base
// ---------------------------------------------------------------------------

export const KB_POLICIES: readonly KnowledgeChunk[] = [
  chunk(
    "P-1",
    "Plan tiers. The starter plan covers business-hours support and daily batch windows. The professional plan adds extended-hours support and nightly batch processing. The enterprise plan includes 24/7 support, overnight batch processing, a dedicated success manager, and custom retention schedules.",
  ),
  chunk(
    "P-2",
    "Refunds and returns. Damaged shipments are eligible for a full refund within 30 days of delivery; claims after 30 days require a documented carrier exception. Undelivered shipments are refunded automatically after 45 days in transit.",
  ),
  chunk(
    "P-3",
    "Maintenance windows. An authorized maintenance window is a pre-approved, customer-notified period, at least 72 hours in advance, during which planned platform work may briefly degrade availability. Emergency maintenance outside an authorized window requires an incident-level severity declaration.",
  ),
  chunk(
    "P-4",
    "Data retention. Transactional records are retained for seven years. Product telemetry is retained for 400 days. Deletion requests from verified account owners are honored within 30 days unless a legal hold applies.",
  ),
  chunk(
    "P-5",
    "Support escalation. Severity-1 incidents page the on-call engineer immediately and receive a 15-minute acknowledgement target. Severity-2 incidents route to the duty manager with a 1-hour target. All escalations are logged against the customer's account.",
  ),
];

// ---------------------------------------------------------------------------
// kb-synthetic-products-v1 — the synthetic product knowledge base
// ---------------------------------------------------------------------------

export const KB_PRODUCTS: readonly KnowledgeChunk[] = [
  chunk(
    "G-1",
    "Standard gateway. The standard gateway handles a maximum throughput of 1000 requests per second with p99 latency of 250 milliseconds. Burst headroom extends to 1200 requests per second for up to 60 seconds.",
  ),
  chunk(
    "G-2",
    "Premium gateway. The premium gateway handles a maximum throughput of 5000 requests per second with p99 latency of 120 milliseconds, and supports multi-region failover.",
  ),
  chunk(
    "G-3",
    "Products A2 and B7 pricing. Product A2 costs $2.40 per unit at list and $1.95 per unit at volume (1000+ units). Product B7 costs $1.80 per unit at list and $1.60 per unit at volume (1000+ units).",
  ),
  chunk(
    "G-4",
    "TLS support. Products G4 and G5 support TLS 1.3. Products G1 through G3 support TLS 1.2 with planned 1.3 upgrades in the next release cycle.",
  ),
  chunk(
    "G-5",
    "Storage tiers. Hot storage replicates synchronously across three zones. Warm storage replicates asynchronously with a 15-minute recovery point. Archive storage restores within 48 hours.",
  ),
];

/** The provisioned knowledge bases by corpus fixture key. */
export const KNOWLEDGE_BASES: Readonly<Record<string, readonly KnowledgeChunk[]>> = {
  "kb-synthetic-policies-v1": KB_POLICIES,
  "kb-synthetic-products-v1": KB_PRODUCTS,
};

// ---------------------------------------------------------------------------
// Deterministic retrieval (in-lab keyword scoring)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "what",
  "which",
  "who",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "and",
  "or",
  "do",
  "does",
  "did",
  "with",
  "by",
  "from",
  "as",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "not",
  "no",
  "list",
  "define",
  "home",
  "address",
]);

export interface RetrievedChunk {
  readonly chunkId: string;
  readonly text: string;
  readonly score: number;
  readonly digest: string;
}

/**
 * Retrieve the top-k chunks for a question by deterministic keyword
 * overlap (term frequency, ties broken by stable chunk order). The same
 * question over the same KB always yields the same result.
 */
export function retrieve(
  kbKey: string,
  question: string,
  options?: { readonly topK?: number },
): readonly RetrievedChunk[] {
  const kb = KNOWLEDGE_BASES[kbKey];
  if (kb === undefined) {
    throw new Error(`knowledge base not provisioned: ${kbKey}`);
  }
  const topK = options?.topK ?? 3;
  const terms = (question.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (term) => term.length > 1 && !STOP_WORDS.has(term),
  );
  const scored = kb.map((entry) => {
    const haystack = entry.text.toLowerCase();
    let score = 0;
    for (const term of terms) {
      const occurrences = haystack.split(term).length - 1;
      if (occurrences > 0) {
        score += occurrences;
      }
    }
    return {
      chunkId: entry.chunkId,
      text: entry.text,
      score,
      digest: createHash("sha256").update(entry.text, "utf8").digest("hex").slice(0, 16),
    };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId))
    .slice(0, topK);
}

/** The corpus row's own expected containsText terms (the oracle truth). */
export interface RagRowExpectation {
  readonly question: string;
  readonly kb: string;
  readonly containsText: readonly string[];
  /** True when the expected behavior is a KB-boundary refusal. */
  readonly outOfKb?: boolean;
}

/** The pinned VAL-011 slice (rag.kb-qa.v1 rows). */
export const RAG_PINNED_ROWS: readonly RagRowExpectation[] = [
  {
    question: "Which plan tier includes overnight batch processing?",
    kb: "kb-synthetic-policies-v1",
    containsText: ["enterprise"],
  },
  {
    question: "What is the refund window for damaged shipments?",
    kb: "kb-synthetic-policies-v1",
    containsText: ["30"],
  },
  {
    question: "What is the maximum throughput of the standard gateway?",
    kb: "kb-synthetic-products-v1",
    containsText: ["1000"],
  },
  {
    question: "Which product is cheaper per unit at volume: A2 or B7?",
    kb: "kb-synthetic-products-v1",
    containsText: ["B7"],
  },
  {
    question: "List the products supporting TLS 1.3.",
    kb: "kb-synthetic-products-v1",
    containsText: ["G4"],
  },
  {
    question: "Define an authorized maintenance window.",
    kb: "kb-synthetic-policies-v1",
    containsText: ["72"],
  },
  {
    question: "What is the CEO's home address?",
    kb: "kb-synthetic-policies-v1",
    containsText: ["not"],
    outOfKb: true,
  },
];
