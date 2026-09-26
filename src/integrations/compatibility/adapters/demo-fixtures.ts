/**
 * The PPR-017 Demo Mirror fixtures — the foundation's own demo data.
 *
 * DOCTRINE: NO application proof exists at PPR-017 (the sibling
 * application orders PPR-018/019 are still in flight), so every demo
 * example here is an honest FIXTURE evidence record (`recordBasis:
 * "fixture"` — proof scaffolding for exercising the Demo Mirror surface
 * itself), and every fixture is honestly labeled UNASSESSED or PARTIAL
 * by the strict admission evaluation. A fixture record can NEVER
 * produce AI_EXECUTION_COMPLETE regardless of its contents (admission
 * rule 5's record-level clause) — the demo surface can therefore never
 * masquerade these examples as certified demos.
 *
 * These are code-resident fixtures (the seed-catalog precedent), NOT
 * real proof records: real records are FILE-based evidence documents
 * produced by actual proof runs (the file store adapter reads those).
 * The fixtures model two honestly different shapes:
 *
 *  - example-coding-assistant (UNASSESSED): a plausible coding-assistant
 *    execution graph whose proof has not started — every edge explicitly
 *    not-run, no corpus, no egress observation;
 *  - example-rag-knowledge-app (PARTIAL): a proof in progress — two
 *    edges delegated through Zeck (fixture-basis evidence, disclosed as
 *    scaffolding), one edge externally blocked (provider owner), the
 *    corpus declared but not yet replayed.
 */

import type { DemoMirrorEntry, DemoMirrorRegistry } from "../application/demo-registry";
import type { CompatibilityEvidenceRecord } from "../domain/evidence";

const FIXTURE_APP_ID = "00000000-0000-7000-8000-0000000000c1";
const FIXTURE_RECORDED_AT = "2026-09-26T00:00:00Z";

/** Fixture A — an UNASSESSED coding-assistant-shaped graph (no proof run). */
export const EXAMPLE_CODING_ASSISTANT_RECORD: CompatibilityEvidenceRecord = {
  recordId: "fixture-example-coding-assistant",
  recordBasis: "fixture",
  pinnedApplication: {
    identity: {
      name: "Example coding assistant (fixture)",
      repository: "https://example.invalid/example-coding-assistant",
      applicationId: FIXTURE_APP_ID,
    },
    pin: {
      upstreamRevision: "000000000000000000000000000000000000f1a1",
      integrationRevision: "0000000000000000000000000000000000000171",
    },
  },
  graph: {
    edges: [
      {
        edgeId: "main-completion",
        component: "chat completion loop",
        surface: "text-generation",
        transport: "OpenAI-compatible client seam",
        externalExecution: "direct provider model invocation",
        materiality: "the main model call chooses and invokes a provider model directly",
      },
      {
        edgeId: "weak-model-summarizer",
        component: "diff summarizer",
        surface: "text-generation",
        transport: "auxiliary model client",
        externalExecution: "auxiliary provider model invocation",
        materiality: "an auxiliary summarization model call outside the main seam",
      },
      {
        edgeId: "repo-embeddings",
        component: "repository indexer",
        surface: "embeddings",
        transport: "provider embedding client",
        externalExecution: "provider embedding service",
        materiality: "repository embeddings invoke a provider embedding service",
      },
    ],
  },
  dispositions: [
    {
      edgeId: "main-completion",
      disposition: "not-run",
      cause: "the compatibility proof for this application has not started",
      owner: "lead",
    },
    {
      edgeId: "weak-model-summarizer",
      disposition: "not-run",
      cause: "the compatibility proof for this application has not started",
      owner: "lead",
    },
    {
      edgeId: "repo-embeddings",
      disposition: "not-run",
      cause: "the compatibility proof for this application has not started",
      owner: "lead",
    },
  ],
  egressObservation: { mode: "observe", status: "not-run", violations: [] },
  providerCredentials: [],
  runtimeEvidence: { corpusDeclared: false, corpusUsability: "not-run", observations: [] },
  comparison: [],
  zeckTraces: [],
  limitations: [
    {
      area: "proof status",
      statement:
        "This is a FIXTURE record shipped with the PPR-017 foundation to exercise the Demo Mirror surface: no proof run has been executed for any application yet, and this record must never be presented as evidence about any real application.",
      owner: "lead",
    },
  ],
  notRunCauses: [
    {
      area: "entire proof",
      cause:
        "no application compatibility proof has been executed (the sibling application orders PPR-018/PPR-019 are in flight)",
      owner: "lead",
    },
  ],
  recordedAt: FIXTURE_RECORDED_AT,
};

/** Fixture B — a PARTIAL RAG-knowledge-app-shaped proof in progress. */
export const EXAMPLE_RAG_KNOWLEDGE_APP_RECORD: CompatibilityEvidenceRecord = {
  recordId: "fixture-example-rag-knowledge-app",
  recordBasis: "fixture",
  pinnedApplication: {
    identity: {
      name: "Example RAG knowledge app (fixture)",
      repository: "https://example.invalid/example-rag-knowledge-app",
      applicationId: FIXTURE_APP_ID,
    },
    pin: {
      upstreamRevision: "000000000000000000000000000000000000f1b2",
      integrationRevision: "0000000000000000000000000000000000000172",
    },
  },
  graph: {
    edges: [
      {
        edgeId: "answer-generation",
        component: "answer synthesis",
        surface: "text-generation",
        transport: "provider SDK client",
        externalExecution: "direct provider model invocation",
        materiality: "answer generation invokes a provider model directly",
      },
      {
        edgeId: "document-embeddings",
        component: "ingestion pipeline",
        surface: "embeddings",
        transport: "provider embedding client",
        externalExecution: "provider embedding service",
        materiality: "ingestion embeddings invoke a provider embedding service",
      },
      {
        edgeId: "retrieval-reranking",
        component: "retrieval stage",
        surface: "reranking",
        transport: "provider reranking client",
        externalExecution: "provider reranking service",
        materiality: "retrieval reranking invokes a provider reranking service",
      },
    ],
  },
  dispositions: [
    {
      edgeId: "answer-generation",
      disposition: "delegated",
      zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d1"],
      evidenceBasis: "fixture",
    },
    {
      edgeId: "document-embeddings",
      disposition: "delegated",
      zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d2"],
      evidenceBasis: "fixture",
    },
    {
      edgeId: "retrieval-reranking",
      disposition: "not-run",
      cause:
        "the reranking execution surface is provider-gated in this environment (no operator-authorized rail yet)",
      owner: "provider",
    },
  ],
  egressObservation: { mode: "observe", status: "not-run", violations: [] },
  providerCredentials: [{ envVarName: "EXAMPLE_PROVIDER_API_KEY", present: true }],
  runtimeEvidence: {
    corpusDeclared: true,
    corpusUsability: "not-run",
    observations: [
      "the representative corpus (10 fixture documents + 4 fixture questions) is declared but has not been replayed through the integration yet",
    ],
  },
  comparison: [
    {
      baseline: "direct-baseline",
      basis: "not-measured",
      statement:
        "No direct-baseline comparison has been measured yet — the proof is partial (fixture scaffolding only).",
    },
  ],
  zeckTraces: [
    {
      edgeId: "answer-generation",
      executionId: "00000000-0000-7000-8000-0000000000d1",
      applicationId: FIXTURE_APP_ID,
      found: true,
      status: "COMPLETED",
      terminal: true,
      eventCount: 6,
      verificationCount: 1,
      passingVerificationCount: 1,
      correlated: true,
    },
    {
      edgeId: "document-embeddings",
      executionId: "00000000-0000-7000-8000-0000000000d2",
      applicationId: FIXTURE_APP_ID,
      found: true,
      status: "COMPLETED",
      terminal: true,
      eventCount: 5,
      verificationCount: 1,
      passingVerificationCount: 1,
      correlated: true,
    },
  ],
  limitations: [
    {
      area: "evidence basis",
      statement:
        "The two delegated edges carry FIXTURE-basis Zeck evidence (scaffolding executions recorded for this foundation's own demonstration) — fixture evidence never counts as an external PASS, so this record can never certify, by construction.",
      owner: "lead",
    },
    {
      area: "reranking edge",
      statement:
        "The retrieval-reranking edge is externally blocked: the reranking execution surface has no operator-authorized rail in this environment (provider-owned boundary).",
      owner: "provider",
    },
  ],
  notRunCauses: [
    {
      area: "egress observation",
      cause:
        "the runtime egress observation harness has not been wrapped around a run of this application",
      owner: "lead",
    },
    {
      area: "corpus replay",
      cause: "the declared representative corpus has not been replayed",
      owner: "lead",
    },
  ],
  recordedAt: FIXTURE_RECORDED_AT,
};

/** The PPR-017 fixture evidence records (stable order). */
export const FIXTURE_EVIDENCE_RECORDS: readonly CompatibilityEvidenceRecord[] = [
  EXAMPLE_CODING_ASSISTANT_RECORD,
  EXAMPLE_RAG_KNOWLEDGE_APP_RECORD,
];

/** The default Demo Mirror registry (bound to the fixture records). */
export function defaultDemoRegistry(): DemoMirrorRegistry {
  return {
    entries: [
      {
        demoId: "example-coding-assistant",
        evidenceRecordId: "fixture-example-coding-assistant",
        representativeTask: {
          title: "Apply a small refactoring instruction to a fixture repository",
          description:
            "The representative task a certified run would replay: the assistant applies a small, well-specified refactoring to a fixture repository and summarizes the diff. No certified integration exists for this application yet — the task is declared, not runnable.",
        },
        runBinding: { kind: "none" },
        reproducibility: {
          instructions:
            "Fixture demo of the PPR-017 foundation: no certified integration path exists yet. When the application's compatibility proof lands, this entry re-binds to its live evidence record and the pinned-runtime runner replays the representative task through the certified path.",
          pinnedUpstreamRevision: "000000000000000000000000000000000000f1a1",
          integrationRevision: "0000000000000000000000000000000000000171",
        },
        warnings: [
          "Fixture record — the application's compatibility proof has not started (status derives honestly as UNASSESSED).",
        ],
      },
      {
        demoId: "example-rag-knowledge-app",
        evidenceRecordId: "fixture-example-rag-knowledge-app",
        representativeTask: {
          title: "Answer a fixture question over a fixture document set",
          description:
            "The representative task a certified run would replay: the application ingests ten fixture documents and answers four fixture questions with grounded citations. The proof is PARTIAL (fixture-basis delegations, one provider-blocked edge) — the task is declared, not runnable.",
        },
        runBinding: { kind: "none" },
        reproducibility: {
          instructions:
            "Fixture demo of the PPR-017 foundation: the proof is partial and its delegated evidence is fixture-basis scaffolding, so no certified run exists. When the application's real proof lands, this entry re-binds to its live evidence record.",
          pinnedUpstreamRevision: "000000000000000000000000000000000000f1b2",
          integrationRevision: "0000000000000000000000000000000000000172",
        },
        warnings: [
          "Fixture record — the proof is partial and its delegated evidence is fixture-basis (never an external PASS).",
        ],
      },
    ],
  };
}

/** Look up one fixture record by id (the default store's read). */
export function fixtureRecordOf(recordId: string): CompatibilityEvidenceRecord | null {
  return FIXTURE_EVIDENCE_RECORDS.find((record) => record.recordId === recordId) ?? null;
}

/** Resolve every default registry entry against the fixture records. */
export function defaultDemoEntries(): readonly DemoMirrorEntry[] {
  return defaultDemoRegistry().entries;
}
