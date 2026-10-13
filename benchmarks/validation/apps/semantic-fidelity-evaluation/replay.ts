/**
 * The PPR-025/PPR-026 embeddings lines re-run under the gated
 * configuration (PCS-004 — ACR-009 §6 "replay discipline").
 *
 * WHAT IS RE-PLAYED (the work order's replay lines): the delegated
 * embeddings edges the application-compatibility program recorded
 * executing through Zeck-side DETERMINISTIC substitutes —
 * `openwebui.rag.embeddings` (PPR-025) and `anythingllm.rag.embeddings`
 * (PPR-026) — over the ERA'S OWN corpus material (the RAG knowledge
 * documents, the RAG questions and the memories journey texts,
 * imported READ-ONLY from the compat corpus modules), under BOTH
 * contract spellings:
 *
 *  - contract-absent (the recorded era configuration): the substitute
 *    EXECUTES (the era's honest basis — lexical overlap between the
 *    corpus question and the knowledge document is the retrieval
 *    signal), the substitution fact is recorded and the
 *    met-by-deterministic-substitute disclosure is projected;
 *  - contract-declared (the gated configuration): the substitute is
 *    TYPED INADMISSIBLE for the task's satisfaction — the task FAILS
 *    CLOSED with `semantic-quality-contract-forbids-substitute`; no
 *    vector is produced for the task's satisfaction even though the
 *    executor CAN produce one (the hard gate's whole point).
 *
 * WHAT IS NEVER DONE (the no-relabeling law): the recorded P2-FIX-era
 * results are QUOTED, never relabeled — the era's evidence records
 * (deploy/evidence/ppr-025.json, deploy/evidence/ppr-026.json) stay
 * exactly as recorded, their limitation ("embeddings execution
 * representation", owner Lead) carried forward VERBATIM as quoted
 * facts with their own provenance. The replay's new facts (the gated
 * verdicts) are ADDITIVE — the era's status is never rewritten.
 *
 * The quoted era facts are READ from the committed records at run
 * time (fail-closed if the records are absent or reshaped) and the
 * suites pin the quoted values against the committed records.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RAG_KNOWLEDGE_DOCUMENT as ANYTHINGLLM_RAG_DOCUMENT,
  RAG_QUESTION as ANYTHINGLLM_RAG_QUESTION,
  RAG_KNOWLEDGE_TOKEN as ANYTHINGLLM_RAG_TOKEN,
} from "../../../../compat/anythingllm/corpus/tasks";
import {
  MEMORY_A,
  MEMORY_B,
  MEMORY_MARKER,
  MEMORY_QUERY,
  RAG_KNOWLEDGE_DOCUMENT as OPENWEBUI_RAG_DOCUMENT,
  RAG_QUESTION as OPENWEBUI_RAG_QUESTION,
  RAG_KNOWLEDGE_TOKEN as OPENWEBUI_RAG_TOKEN,
} from "../../../../compat/openwebui/corpus/tasks";
import type { SemanticQualityContract } from "./fidelity";

// ---------------------------------------------------------------------------
// The era's recorded facts (quoted verbatim — never relabeled)
// ---------------------------------------------------------------------------

/** One era limitation as recorded (quoted verbatim from the committed evidence record). */
export interface EraLimitation {
  readonly area: string;
  readonly statement: string;
  readonly owner: string;
}

/** One era edge disposition as recorded (quoted verbatim). */
export interface EraDisposition {
  readonly edgeId: string;
  readonly disposition: string;
  readonly evidenceBasis: string;
  readonly zeckExecutionIds: readonly string[];
}

/** The quoted era facts of one replay line (read fail-closed from the committed records). */
export interface EraRecord {
  readonly recordId: string;
  readonly workOrder: string;
  readonly recordedAt: string;
  readonly limitation: EraLimitation;
  readonly dispositions: readonly EraDisposition[];
}

/** The committed evidence record's path (fail-closed if absent). */
function readCommittedEvidence(record: "ppr-025" | "ppr-026"): EraRecord {
  const path = fileURLToPath(
    new URL(`../../../../deploy/evidence/${record}.json`, import.meta.url),
  );
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    readonly workOrder: string;
    readonly date: string;
    readonly evidenceRecord: {
      readonly recordId: string;
      readonly graph: { readonly edges: readonly { readonly edgeId: string }[] };
      readonly dispositions: readonly {
        readonly edgeId: string;
        readonly disposition: string;
        readonly evidenceBasis: string;
        readonly zeckExecutionIds?: readonly string[];
      }[];
      readonly limitations: readonly EraLimitation[];
    };
  };
  const limitation = parsed.evidenceRecord.limitations.find(
    (entry) => entry.area === "embeddings execution representation",
  );
  if (limitation === undefined) {
    throw new Error(
      `the committed evidence record ${record}.json carries no "embeddings execution representation" limitation — the era record drifted (fail-closed, never a silent skip)`,
    );
  }
  return {
    recordId: parsed.evidenceRecord.recordId,
    workOrder: parsed.workOrder,
    recordedAt: parsed.date,
    limitation,
    dispositions: parsed.evidenceRecord.dispositions.map((entry) => ({
      edgeId: entry.edgeId,
      disposition: entry.disposition,
      evidenceBasis: entry.evidenceBasis,
      zeckExecutionIds: [...(entry.zeckExecutionIds ?? [])],
    })),
  };
}

/** The PPR-025 era record (quoted — Open WebUI). */
export const PPR_025_ERA: EraRecord = readCommittedEvidence("ppr-025");
/** The PPR-026 era record (quoted — AnythingLLM). */
export const PPR_026_ERA: EraRecord = readCommittedEvidence("ppr-026");

// ---------------------------------------------------------------------------
// The replay corpus (the era's own material + committed distractors)
// ---------------------------------------------------------------------------

/** One retrieval document of a replay line: the ground-truth target or a distractor, with its provenance (era material vs committed distractor). */
export interface ReplayDocument {
  readonly id: string;
  readonly text: string;
  readonly role: "ground-truth" | "distractor";
  readonly provenance: "era-material" | "committed-distractor";
}

/** One replay line's declared configuration (committed, digest-pinned). */
export interface ReplayLine {
  readonly lineId: string;
  /** The era's edge id (the delegated embeddings edge). */
  readonly edgeId: string;
  readonly eraWorkOrder: "PPR-025" | "PPR-026";
  /** The era corpus task the line re-runs. */
  readonly eraTaskId: string;
  /** The query the era's journey asked (the era's own text, read-only import). */
  readonly query: string;
  /** The era's distinctive answer token (the grounded-answer check's own token). */
  readonly eraAnswerToken: string;
  /** The retrieval corpus: the ground-truth document (era material) + the distractors. */
  readonly documents: readonly ReplayDocument[];
  /** The expected top-1 document id under the substitute (the era's lexical-overlap basis). */
  readonly expectedTop1UnderSubstitute: string;
  /** The contract spelling of the gated arm. */
  readonly gatedContract: SemanticQualityContract;
}

/** The committed distractor documents (app-owned, synthetic-supply labeled, digest-pinned). */
const HARBOR_DISTRACTORS: readonly ReplayDocument[] = [
  {
    id: "replay-openwebui-distractor-festival",
    text: "The north harbor festival opens at noon with live music, food stalls and a fireworks display over the water (synthetic-supply distractor document — never era material).",
    role: "distractor",
    provenance: "committed-distractor",
  },
  {
    id: "replay-openwebui-distractor-parking",
    text: "Winter parking permits for the north district ferry terminal are available at the harbormaster office during business hours (synthetic-supply distractor document — never era material).",
    role: "distractor",
    provenance: "committed-distractor",
  },
] as const;

const MERIDIAN_DISTRACTORS: readonly ReplayDocument[] = [
  {
    id: "replay-anythingllm-distractor-park",
    text: "The meridian park fountain operates daily from dawn to dusk and is a popular spot for evening walks (synthetic-supply distractor document — never era material).",
    role: "distractor",
    provenance: "committed-distractor",
  },
  {
    id: "replay-anythingllm-distractor-tours",
    text: "Lighthouse tours require advance booking during the holiday season; groups should arrive fifteen minutes early (synthetic-supply distractor document — never era material).",
    role: "distractor",
    provenance: "committed-distractor",
  },
] as const;

/** The declared contract spelling the gated arm runs under. */
export const REPLAY_GATED_CONTRACT: SemanticQualityContract = {
  kind: "declared",
  requirement: "requires-semantic-retrieval-quality",
  acceptanceBasis: "the RAG answer must be retrieved semantically, not by lexical overlap alone",
} as const;

/** The replay lines (the PPR-025/PPR-026 embeddings edges, stable order). */
export const REPLAY_LINES: readonly ReplayLine[] = [
  {
    lineId: "replay:openwebui.rag.embeddings",
    edgeId: "openwebui.rag.embeddings",
    eraWorkOrder: "PPR-025",
    eraTaskId: "openwebui-rag-grounded-qa",
    query: OPENWEBUI_RAG_QUESTION,
    eraAnswerToken: OPENWEBUI_RAG_TOKEN,
    documents: [
      {
        id: "replay-openwebui-era-target",
        text: OPENWEBUI_RAG_DOCUMENT,
        role: "ground-truth",
        provenance: "era-material",
      },
      ...HARBOR_DISTRACTORS,
    ],
    expectedTop1UnderSubstitute: "replay-openwebui-era-target",
    gatedContract: REPLAY_GATED_CONTRACT,
  },
  {
    lineId: "replay:openwebui.rag.embeddings:memories",
    edgeId: "openwebui.rag.embeddings",
    eraWorkOrder: "PPR-025",
    eraTaskId: "openwebui-memories-embeddings",
    query: MEMORY_QUERY,
    eraAnswerToken: MEMORY_MARKER,
    documents: [
      {
        id: "replay-openwebui-memory-a",
        text: MEMORY_A,
        role: "ground-truth",
        provenance: "era-material",
      },
      {
        id: "replay-openwebui-memory-b",
        text: MEMORY_B,
        role: "distractor",
        provenance: "era-material",
      },
    ],
    expectedTop1UnderSubstitute: "replay-openwebui-memory-a",
    gatedContract: REPLAY_GATED_CONTRACT,
  },
  {
    lineId: "replay:anythingllm.rag.embeddings",
    edgeId: "anythingllm.rag.embeddings",
    eraWorkOrder: "PPR-026",
    eraTaskId: "anythingllm-rag-grounded-qa",
    query: ANYTHINGLLM_RAG_QUESTION,
    eraAnswerToken: ANYTHINGLLM_RAG_TOKEN,
    documents: [
      {
        id: "replay-anythingllm-era-target",
        text: ANYTHINGLLM_RAG_DOCUMENT,
        role: "ground-truth",
        provenance: "era-material",
      },
      ...MERIDIAN_DISTRACTORS,
    ],
    expectedTop1UnderSubstitute: "replay-anythingllm-era-target",
    gatedContract: REPLAY_GATED_CONTRACT,
  },
] as const;

/** The context line the era records name for Continue's edge (quoted, not re-run — the work order's replay lines are PPR-025/026). */
export const CONTINUE_EDGE_CONTEXT =
  "continue.core.indexing.embed (PPR-021): the identical no-/embeddings boundary PPR-025 recorded for Continue's edge — quoted context (ACR-009 §1 names it among the measured-gap edges); this evaluation's replay lines are the PPR-025/PPR-026 edges" as const;
