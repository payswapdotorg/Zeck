/**
 * VAL-011 acceptance criterion 6: the RAG derivations against
 * controlled fakes — deterministic retrieval, citation coverage, the
 * out-of-KB refusal, provider failure, and oracle-floor discrimination.
 */

import { describe, expect, test } from "vitest";
import { RAG_PINNED_ROWS, retrieve } from "../../../benchmarks/validation/apps/rag/knowledge-bases";
import {
  deriveRagVerification,
  deriveRetrieval,
  ragRequestFor,
} from "../../../benchmarks/validation/platform/rag";

describe("VAL-011 deterministic retrieval", () => {
  test("retrieval is deterministic and reproducible", () => {
    const first = retrieve(
      "kb-synthetic-policies-v1",
      "What is the refund window for damaged shipments?",
    );
    const second = retrieve(
      "kb-synthetic-policies-v1",
      "What is the refund window for damaged shipments?",
    );
    expect(first).toEqual(second);
    expect(first[0]?.chunkId).toBe("P-2");
  });

  test("retrieval answers land in the top chunk for the pinned rows", () => {
    const cases: { question: string; kb: string; expectedChunk: string }[] = [
      {
        question: "Which plan tier includes overnight batch processing?",
        kb: "kb-synthetic-policies-v1",
        expectedChunk: "P-1",
      },
      {
        question: "What is the maximum throughput of the standard gateway?",
        kb: "kb-synthetic-products-v1",
        expectedChunk: "G-1",
      },
      {
        question: "Which product is cheaper per unit at volume: A2 or B7?",
        kb: "kb-synthetic-products-v1",
        expectedChunk: "G-3",
      },
      {
        question: "List the products supporting TLS 1.3.",
        kb: "kb-synthetic-products-v1",
        expectedChunk: "G-4",
      },
    ];
    for (const testCase of cases) {
      const chunks = retrieve(testCase.kb, testCase.question);
      expect(chunks.some((entry) => entry.chunkId === testCase.expectedChunk)).toBe(true);
    }
  });

  test("an unprovisioned KB throws (NOT RUN boundary, never empty retrieval)", () => {
    expect(() => retrieve("kb-unknown", "anything")).toThrow(/not provisioned/);
  });
});

describe("VAL-011 RAG verification", () => {
  const row = RAG_PINNED_ROWS[0];
  if (row === undefined) throw new Error("missing pinned row");
  const retrieval = deriveRetrieval({ kb: row.kb, question: row.question });

  test("a cited faithful answer passes every criterion", () => {
    const criteria = deriveRagVerification(row, retrieval, {
      kind: "success",
      content: "The enterprise plan includes overnight batch processing [P-1].",
    });
    expect(criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(criteria.some((c) => c.criterionId === "contains:enterprise")).toBe(true);
    expect(criteria.some((c) => c.criterionId === "citation-coverage")).toBe(true);
  });

  test("an uncited answer fails citation coverage (uncited factual claims are forbidden)", () => {
    const criteria = deriveRagVerification(row, retrieval, {
      kind: "success",
      content: "The enterprise plan includes overnight batch processing.",
    });
    expect(criteria.find((c) => c.criterionId === "citation-coverage")?.status).toBe("FAIL");
  });

  test("a wrong answer fails the corpus term (oracle floor)", () => {
    const criteria = deriveRagVerification(row, retrieval, {
      kind: "success",
      content: "The professional plan includes nightly batch processing [P-1].",
    });
    expect(criteria.find((c) => c.criterionId === "contains:enterprise")?.status).toBe("FAIL");
  });

  test("the out-of-KB row: an explicit not-in-KB refusal passes; a hallucination fails", () => {
    const outOfKb = RAG_PINNED_ROWS.find((entry) => entry.outOfKb === true);
    if (outOfKb === undefined) throw new Error("missing out-of-KB row");
    const outRetrieval = deriveRetrieval({ kb: outOfKb.kb, question: outOfKb.question });
    const honest = deriveRagVerification(outOfKb, outRetrieval, {
      kind: "success",
      content:
        "The CEO's home address is not in the knowledge base; no personal data is available.",
    });
    expect(honest.find((c) => c.criterionId === "kb-boundary-refusal")?.status).toBe("PASS");
    expect(honest.find((c) => c.criterionId === "contains:not")?.status).toBe("PASS");
    const hallucinated = deriveRagVerification(outOfKb, outRetrieval, {
      kind: "success",
      content: "The CEO lives at 1 Example Street [P-4].",
    });
    expect(hallucinated.find((c) => c.criterionId === "kb-boundary-refusal")?.status).toBe("FAIL");
    expect(hallucinated.find((c) => c.criterionId === "contains:not")?.status).toBe("FAIL");
  });

  test("a provider failure fails the run mechanically", () => {
    const criteria = deriveRagVerification(row, retrieval, {
      kind: "failure",
      category: "authentication",
      message: "credential rejected",
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("FAIL");
  });
});

describe("VAL-011 RAG request derivation", () => {
  test("the request carries the retrieved context with provenance markers and citation rules", () => {
    const row = RAG_PINNED_ROWS[1];
    if (row === undefined) throw new Error("missing row");
    const retrieval = deriveRetrieval({ kb: row.kb, question: row.question });
    const request = ragRequestFor({ kb: row.kb, question: row.question }, retrieval);
    const system = request.messages[0]?.content ?? "";
    const user = request.messages[1]?.content ?? "";
    expect(system).toContain("Cite the supporting chunk id");
    expect(system).toContain("not in the knowledge base");
    expect(user).toContain("Knowledge base: kb-synthetic-policies-v1");
    expect(user).toContain("[P-2]");
    expect(request.temperature).toBe(0);
  });
});
