# PCS-004 Threshold Report — semantic-fidelity-evaluation

The P2 program's semantic-fidelity evaluation (ACR-009 §6, work order PCS-004): the quality fixtures (the measurable distinction between model-backed semantic quality and deterministic lexical/hash substitutes), the negative controls (the hard gate — a task requiring semantic retrieval must NOT pass merely because a deterministic vector is produced), the differentiated evidence (the mechanical discriminator over the typed facts) and the honest replay of the PPR-025/PPR-026 embeddings lines under the gated configuration. All numbers are fresh measurements of THIS evaluation at run revision `ef2e25f9fd6d64c5ec14156f570bd7ddd5f361ac`; the recorded P2-FIX-era results are quoted verbatim and never relabeled.

## Honest labels (carried on every number)

- supply: synthetic-supply (the deterministic executors and the committed curated dictionaries — never a live provider)
- semantic arm: synthetic-semantic-supply (the curated-knowledge upper bound on this corpus — never a live model measurement; live credentialed semantic-quality validation is the operator-era obligation, never backfilled)
- measurements: no cost and no latency measurements (this evaluation measures retrieval quality distinctions and gating verdicts, nothing else)
- a threshold miss with honest attribution is a valid delivery (the program's truth discipline); live/credentialed validation is the operator-era obligation and is never backfilled from synthetic runs

## The two representation arms (the pre-registered comparison)

- **deterministic-substitute** — the REAL PPR-025 Zeck-side executor (`compat/openwebui/harness/embeddings.ts`, imported read-only): SHA-256-signed feature hashing of lowercased unigram+bigram surface tokens, sublinear TF, L2-normalized, 512 fixed dimensions — the era's recorded execution representation (synthetic-supply; never a model rail)
- **synthetic-semantic-supply** — concept normalization through the committed curated dictionaries (synonym/translation/sense maps — the synthetic supply of the semantic knowledge a model-backed embedding service would bring to this corpus) followed by the SAME feature-hash arithmetic (same tokenizer, dimensions, weighting, normalization): the declared upper bound of model-backed semantic retrieval ON THIS CURATED CORPUS (synthetic-semantic-supply — never a live model measurement)

## T1 — The quality fixtures (the measurable distinction)

| fixture group | fixtures | semantic arm top-1 (synthetic-semantic-supply) | substitute top-1 (synthetic-supply) | distinct |
|---|---:|---:|---:|---|
| paraphrase-synonym-retrieval | 6 | 6/6 (100.00%) | 0/6 (0.00%) | yes |
| cross-lingual-nearest-neighbor | 6 | 6/6 (100.00%) | 0/6 (0.00%) | yes |
| polysemy-discrimination | 6 | 6/6 (100.00%) | 0/6 (0.00%) | yes |
| **overall** | 18 | 18/18 (100.00%) | 0/18 (0.00%) | yes |

The construction law (verified mechanically in-suite against the real executor): every fixture's distractor shares MORE discriminating surface lexical tokens with the query than the ground-truth target does — so the lexical/hash substitute ranks the distractor first (the honest failure mode), while the ground-truth target is the paraphrase/translation/sense-family neighbor (the curated semantic relation). The measured distinction is exactly the curated semantic knowledge a model-backed representation would supply.

### Verdicts

- declared: the synthetic semantic arm retrieves the ground truth first on 100% of every group → verdict: **MET**
- declared: the deterministic substitute is strictly below the semantic arm on every group → verdict: **MET**

## T2 — The negative controls (the hard gate)

- hard-gate controls (tasks declaring `requires-semantic-retrieval-quality` offered ONLY the deterministic substitute): **6**
- failed closed with the typed reason `semantic-quality-contract-forbids-substitute`: **6/6**
- admitted (a typed pass on the substitute): **0** — any admission is delivery-blocking
- the discriminating matrix (the gate's precision): **8/8** controls produced their expected verdicts (a declared contract is satisfiable by a model-backed representation; a substitute not on the plan does not trip it; the explicit absent spelling and the undeclared spelling permit the substitute with the disclosure recorded; malformed contracts fail closed; an already-inadmissible candidate is returned unchanged — the invariant-13 composition)

Every control's verdict is asserted mechanically IN-SUITE against the REAL planner gate (`applySemanticQualityGating` from `src/modules/planning/public`, driven by `tests/unit/validation/pcs-004-*.test.ts`) — the local projection the run uses (gate.ts) is pinned verdict-for-verdict against it; a fabricated pass is unrepresentable.

- declared: 100% fail closed; 0 admitted → verdict: **MET**

## T3 — The differentiated evidence (the mechanical discriminator)

- emitted representation records: **54** (every record carries its typed SemanticFidelityFacts)
- separated by the mechanical discriminator (reading ONLY the typed facts, never prose): **54/54** (100.00%)
- separated as `semantic-model-backed`: **20**; as `deterministic-substitute`: **34** (both kinds present — the closed two-kind vocabulary's both members exercised)
- rejected by the discriminator (malformed/incoherent shapes): **0**

The discriminator's tamper-discriminations (a flipped representation kind, a substitute fact without its substitute identity, a model-backed fact claiming one, an unknown kind) are each REJECTED with a typed reason — proven in-suite over the emitted record corpus.

- declared: the discriminator separates 100% of emitted records, both kinds present → verdict: **MET**

## T4 — The replay of the PPR-025/PPR-026 embeddings lines

| replay line | era work order | era task | era target top-1 under the substitute (contract-absent) | gated arm (contract-declared) |
|---|---|---|---|---|
| replay:openwebui.rag.embeddings | PPR-025 | openwebui-rag-grounded-qa | yes (the era's lexical-overlap basis holds) | FAIL CLOSED (typed reason; no vector produced for the task's satisfaction) |
| replay:openwebui.rag.embeddings:memories | PPR-025 | openwebui-memories-embeddings | yes (the era's lexical-overlap basis holds) | FAIL CLOSED (typed reason; no vector produced for the task's satisfaction) |
| replay:anythingllm.rag.embeddings | PPR-026 | anythingllm-rag-grounded-qa | yes (the era's lexical-overlap basis holds) | FAIL CLOSED (typed reason; no vector produced for the task's satisfaction) |

- the era's recorded limitation, quoted VERBATIM from the committed evidence records (never relabeled): "the authorized supply exposes no embeddings endpoint (probed live: POST /embeddings → 404); the delegated embeddings edge is executed by the Zeck-side DETERMINISTIC lexical-hash strategy (real, deterministic, mechanically verified; strategyClass deterministic-embeddings, modelCalls 0) — a model-backed embeddings rail remains an operator-provider boundary" (area: embeddings execution representation; owner: Lead)
- context (quoted, not re-run): continue.core.indexing.embed (PPR-021): the identical no-/embeddings boundary PPR-025 recorded for Continue's edge — quoted context (ACR-009 §1 names it among the measured-gap edges); this evaluation's replay lines are the PPR-025/PPR-026 edges
- the replay's new facts are ADDITIVE: the era's records stay exactly as recorded; under the gated configuration the SAME tasks now carry the typed inadmissibility verdict and the unmet-no-admissible-semantic-representation disclosure (what remains unavailable: semantic-model-backed)

- declared: every line: the era target ranks first under the substitute AND the gated arm fails closed → verdict: **MET**

## T5 — Reproducibility (the deterministic replay discipline)

- corpus digest (pinned): `f9c7698ea031a09a9b5ad985390e1ee9137d77f89f6e9ecbf4f49758ff9b2c3b`
- evaluation digest (this run): `3e8956f82ad82cec8d26d9417d6a4ec7b9b576b394626a97421e57fc3df101be`
- re-run digest comparison: `3e8956f82ad82cec8d26d9417d6a4ec7b9b576b394626a97421e57fc3df101be` — IDENTICAL (the re-run reproduced the evaluation digest byte-for-byte)
- wall-clock values and run identities are excluded from every digest projection; the in-suite determinism proof re-runs the complete evaluation and compares digests

## Honest boundaries

- synthetic replay only: no live/credentialed provider runs, no market or production claims; live validation is the operator-era obligation
- the synthetic semantic arm is the curated-knowledge upper bound ON THIS CORPUS, not a live model measurement — the fixture distinction proves the SUBSTITUTION GAP (what the lexical/hash substitute cannot do that semantic structure can), never live model quality
- the evaluation consumes the PCS-002/PCS-003 planes through app-local mirrors pinned byte-for-byte in-suite against the real planes (the customer boundary — VAL-002 AC7 — forbids `src/**` imports from the application tree; the canonical-serializer precedent)
- the replay's era material is imported read-only from the compat corpus modules and the committed evidence records; no compat file is modified
- run started 2026-10-13T11:28:05.884Z; run revision `ef2e25f9fd6d64c5ec14156f570bd7ddd5f361ac`
