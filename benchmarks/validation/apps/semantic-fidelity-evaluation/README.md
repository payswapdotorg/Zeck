# semantic-fidelity-evaluation (PCS-004)

The P2 program's semantic-fidelity evaluation (ACR-009 §6, work order PCS-004): the evidence that the semantic-fidelity gating does what the architecture requires — quality fixtures where model-backed semantic quality is measurably distinct from deterministic lexical/hash substitutes, negative controls proving a task requiring semantic retrieval FAILS CLOSED on a deterministic substitute, mechanically differentiated evidence, and the honest replay of the PPR-025/PPR-026 embeddings lines under the gated configuration.

**Every number this evaluation emits is a fresh synthetic measurement** — synthetic-supply (the deterministic executors and the committed curated dictionaries), synthetic-semantic-supply (the curated-knowledge upper bound on this corpus, never a live model measurement), no cost and no latency measurements at all. No live/credentialed provider runs, no market or production claims; a threshold miss with honest attribution is a VALID delivery (the program's truth discipline).

## The four evidence lines

| Line | What it proves |
|---|---|
| quality fixtures | 18 curated fixtures (6 paraphrase/synonym retrieval + 6 cross-lingual nearest-neighbor + 6 polysemy discrimination) where the REAL PPR-025 lexical/hash substitute measurably ranks the lexically-closer distractor first while the ground-truth semantic neighbor ranks first under the synthetic semantic oracle — the measurable distinction (0/18 vs 18/18 top-1, synthetic labels on both) |
| negative controls (the hard gate) | 6 hard-gate controls (tasks declaring `requires-semantic-retrieval-quality` offered ONLY the deterministic substitute) ALL fail closed with the typed reason `semantic-quality-contract-forbids-substitute` — a task requiring semantic retrieval must not pass merely because a deterministic vector is produced; 8 discriminating controls prove the gate's precision (a model-backed representation satisfies a declared contract; the explicit absent spelling and the undeclared spelling permit the substitute with the disclosure recorded; malformed contracts fail closed; an already-inadmissible candidate is returned unchanged) |
| differentiated evidence | every emitted record carries its typed SemanticFidelityFacts; the mechanical discriminator (reading ONLY the typed facts, never prose) separates `semantic-model-backed` from `deterministic-substitute` on 100% of records with both kinds present, and rejects every tampered shape with a typed reason |
| replay of the PPR-025/PPR-026 lines | the delegated embeddings edges (`openwebui.rag.embeddings`, `anythingllm.rag.embeddings`) re-run over the era's own corpus material under both contract spellings: contract-absent the substitute executes (the era's lexical-overlap basis holds — the era target ranks first), contract-declared the substitute is TYPED INADMISSIBLE (fail closed, no vector produced for the task's satisfaction); the era's recorded results are quoted verbatim from the committed evidence records and NEVER relabeled |

## The two representation arms (the pre-registered comparison)

- `deterministic-substitute` — the REAL PPR-025 Zeck-side executor (`compat/openwebui/harness/embeddings.ts`, imported read-only): SHA-256-signed feature hashing of lowercased unigram+bigram surface tokens, sublinear TF, L2-normalized, 512 fixed dimensions — the era's recorded execution representation, never a strawman (synthetic-supply).
- `synthetic-semantic-supply` — concept normalization through the committed curated dictionaries (the synthetic supply of the semantic knowledge a model-backed embedding service would bring to this corpus) followed by the SAME feature-hash arithmetic: same tokenizer, dimensions, weighting, normalization. The ONLY difference is surface tokens vs dictionary-canonicalized concepts — the comparison is fair by construction, and the measured distinction is exactly the curated semantic knowledge (synthetic-semantic-supply — the declared upper bound of model-backed semantic retrieval ON THIS CURATED CORPUS, never a live model measurement; live credentialed validation is the operator-era obligation, never backfilled).

## The explicit outcome thresholds (declared BEFORE the run)

| Threshold | Rule |
|---|---|
| T1a | the synthetic semantic arm retrieves the ground truth first on 100% of every fixture group |
| T1b | the deterministic substitute is STRICTLY below the semantic arm on every group (the measurable distinction) |
| T2 | the hard gate: 100% of hard-gate controls fail closed with the typed reason; ZERO admitted (any admission is delivery-blocking) |
| T3 | the mechanical discriminator separates 100% of emitted records, both kinds present |
| T4 | every replay line: the era target ranks first under the substitute AND the gated arm fails closed |
| T5 | the re-run digest is byte-identical (the deterministic replay discipline) |

## The artifacts (`results/`)

- `threshold-report.md` — the durable evidence document: every threshold with its derived verdict, every number labeled, attribution on every miss, the quoted era records, the reproducibility proof.
- `evaluation-aggregate.json` — the aggregate + verdicts + the complete typed records (fixture, control and replay records with their SemanticFidelityFacts).

## Run

The suites: `tests/unit/validation/pcs-004-semantic-fidelity-evaluation.test.ts` (the oracles) and `tests/unit/validation/pcs-004-apps.test.ts` (the app boundary).

```bash
bun run benchmarks/validation/apps/semantic-fidelity-evaluation/run.ts          # the full evaluation + the reproducibility re-run
bun run benchmarks/validation/apps/semantic-fidelity-evaluation/run.ts single   # the full evaluation once
```

## Boundaries

- Synthetic replay only — no live/credentialed provider runs, ever; live validation is the operator-era obligation and is never backfilled.
- Evaluation only — the PCS-002 plane (`src/modules/capabilities/domain/semantic-fidelity.ts`) and the PCS-003 wiring (`src/modules/planning/domain/semantic-quality-gating.ts`) are consumed read-only through app-local mirrors pinned byte-for-byte in-suite against the real planes; a defect there is REPORTED, never patched.
- The PPR-025/PPR-026 compat executors and corpus material are imported read-only (`compat/openwebui/**`, `compat/anythingllm/**`); the era's evidence records (`deploy/evidence/ppr-025.json`, `deploy/evidence/ppr-026.json`) are read fail-closed and quoted verbatim, never relabeled.
- No new platform surfaces: the app + suites + results are the deliverable.

## The customer-boundary disciplines (VAL-002 AC7 — never `src/**` from the application tree)

The evaluation consumes the platform planes without importing them — each need follows the repository's OWN established answers to a boundary that forbids the import (the PCR-003 app's precedent set):

- **the canonical serializer + digest port** (`canonical.ts`): implemented locally over neutral values, byte-for-byte pinned in-suite against the platform's own serializer and digest port;
- **the typed fact block** (`fidelity.ts`): the app-local mirror of the PCS-002 closed vocabularies + validator + the mechanical discriminator, pinned in-suite against the capabilities authority (`src/modules/capabilities/public`) — every emitted fact validates on the REAL `validateSemanticFidelityFacts`;
- **the gating projection** (`gate.ts`): the app-local projection of the PCS-003 quality-contract gating, pinned verdict-for-verdict in-suite against the REAL planner gate (`applySemanticQualityGating` from `src/modules/planning/public`) over every control and the discriminating matrix;
- **the deterministic substitute** (`representations.ts`): the REAL PPR-025 executor imported from the compat tree (the PCR-003 app's own compat-import precedent) — never reimplemented, never a strawman;
- this evaluation consumes no ppr-027 workload-transport helpers (its replay lines are the compat-plane embeddings edges, not the synthetic supply transport), so the lab's shared seam re-export surface (`apps/shared/seam.ts`) has nothing to route for it — the seam law is honored by NOT widening it.
