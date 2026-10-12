# ACR-009 — Capability Semantic Fidelity: Real Capability vs Deterministic Substitute

Status: APPROVED / FORWARD ARCHITECTURE EVOLUTION
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1 + ACR-006 + ACR-007 + ACR-008
Approval date: 2026-10-12
Authorization basis: Operator standing directive of 2026-10-12 — "continuous resident watch from here on: monitor → harvest → review → approve/require-changes → dispatch next, until the roadmap is complete. No early returns. Use the github repo as guide for roadmap" — delegating the Architect's `approve-architecture-change` and `approve-work-order` rights (delegation-able per `spec/governance/architect.json`) to the Tech Lead for the competitiveness roadmap's remaining phases (P2 first). The non-delegable rights (change-governing-architecture, weaken-frozen-invariant, bypass-verification, bypass-required-review, bypass-merge-gate) remain with the Architect principal `@pectoraux`. The delegation is recorded additively in `spec/governance/authority-delegations.json`; the principal record is not rewritten. P3–P5 of `docs/architecture-proposals/ZECK-COMPETITIVENESS-ROADMAP.md` remain proposals requiring their own per-phase authorization records under the same standing directive.

## Decision

Extend the existing capability/evidence model with **typed semantic-fidelity facts** so that a real capability (e.g. a model-backed semantic embedding) and a deterministic substitute (e.g. lexical/hash vectorization executed Zeck-side) are distinct, non-interchangeable typed facts — and gate the planner's selection of deterministic substitutes on the task's **declared quality contract**, with an honest user-facing disclosure of which requirement is met and what remains unavailable.

The governing execution chain remains unchanged:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

ACR-009 adds no new capability registry, no second router, no second evidence authority and no new durable surface beyond the typed facts themselves. The existing 22-family capability truth (`spec/architecture.md` capability families; the registry's closed family set) is NOT broadened: a deterministic substitute is NOT a new family and is NOT a similarly-named widening of an existing family — it is a typed execution representation OF a task against a declared quality contract, projected through the existing capability facts.

All 20 frozen invariants of `spec/architecture-lock.md` are preserved — explicitly including invariant discipline on capability truth (a capability claim is typed evidence, never a label) and invariant 13 (learning may reorder recommendations but never weaken policy or authority boundaries).

## 1. The measured gap this ACR addresses

The application-compatibility program's honest disclosures (PPR-021 `PARTIAL`, PPR-025/PPR-026 `COMPLETE — BOUND`) recorded: the authorized supply in the evaluation environment exposes no `/embeddings` surface (`POST /v1/embeddings` → HTTP 404, re-confirmed fresh), so the RAG embeddings edges (`openwebui.rag.embeddings`, `anythingllm.rag.embeddings`, `continue` indexing.embed) executed through deterministic Zeck-side substitutes with the limitation "embeddings execution representation (Lead)" carried on the records.

This proved the governed delegation path executes and returns a result — but it did NOT, and cannot, prove semantic-embedding quality equivalent to a model-backed embedding service. The current model carries no typed distinction between "a semantic embedding was produced by a model-backed capability" and "a deterministic vector was produced by a lexical/hash substitute": the quality semantics of the substitution are a prose limitation, not a machine-checkable fact. A task whose utility depends on semantic retrieval quality could therefore pass on a deterministic vector with nothing in the typed record forcing the difference to light.

The gap, precisely: **the capability/evidence model lacks a typed representation of output semantics and quality requirements, so substitute selection is not quality-contract-gated and the user is not shown which requirement is met versus unavailable.**

## 2. The semantic-fidelity fact system (typed, closed)

`SemanticFidelityFacts` — a typed, closed, optional fact block on the capability/execution representation (data, never an engine — the continuation-package discipline):

- **representation kind**: `semantic-model-backed` vs `deterministic-substitute` — the closed two-kind distinction this ACR exists to type; each kind carries its full provenance (which capability, which execution, which substitute function);
- **modality** (where relevant): the input modality the representation is defined over (text, image, audio, multimodal);
- **dimensionality**: the vector dimension count, typed and checked at the boundary;
- **normalization**: the declared normalization semantics of the produced vectors (none, l2, scale-bounded) — mismatched normalization is a compatibility constraint, never a silent fix;
- **similarity semantics**: the declared similarity/distance semantics the representation supports (cosine, dot, exact-match-lexical, hash-proximity) — a deterministic substitute may support only a subset;
- **quality contract**: the declared, task-authored quality requirement (e.g. `requires-semantic-retrieval-quality`, with the task's own acceptance basis) or its explicit absence;
- **compatibility constraints**: the closed list of constraints a consumer must satisfy (dimensionality match, normalization match, similarity-semantics match) — checked mechanically at the delegation boundary.

The laws (each testable):

- **Closed vocabulary**: every field is a closed enum or a typed bounded value; unknown values fail closed at the boundary, never default.
- **No silent substitution**: an execution whose representation kind is `deterministic-substitute` is recorded as such on the evidence — the evidence surface must let any consumer distinguish it from `semantic-model-backed` without reading prose.
- **No family widening**: the substitute is not a capability family, not a new registry entry and never a renamed broadening of the existing families (§ Non-goals).
- **Absence equivalence**: the fact block is OPTIONAL — its absence selects and records byte-identically to today's behavior at every existing call site (the PCR-002 absence-equivalence discipline, discrimination-tested).
- **Explicit provenance**: every fact carries its basis (which execution, which declared capability, which substitute identity) — the explicit-basis `CostClaim` discipline applied to semantic facts.

## 3. Planner quality-contract gating

The planner (the existing planning authority — no second planner) consumes the typed facts:

- a task that declares a quality contract requiring semantic quality (e.g. `requires-semantic-retrieval-quality`) makes a `deterministic-substitute` representation INADMISSIBLE for that task's satisfaction — a typed inadmissibility reason, exactly like an economics-inadmissible move; the planner never "tries anyway";
- a task that declares no quality contract (or explicitly permits deterministic substitutes) may select the substitute — and the selection records the substitution fact (the disclosure of §4);
- the gating is fail-closed: an unknown or malformed quality contract is inadmissible, never a permissive default;
- the gating NEVER lowers a quality floor, raises a budget ceiling or bypasses policy (invariant 13 boundary) — it is a new typed admissibility dimension over the existing machinery, composed exactly like the existing constraints.

## 4. User-facing requirement disclosure

Where a task's declared requirement is met by a substitute, or is unmet and blocked (no admissible semantic capability available), the public evidence/projection surface shows it: which requirement was declared, which representation satisfied it (kind + provenance), and what remains unavailable (the honest `NOT RUN`/unmet boundary discipline already carried by the records — extended with the typed facts so the disclosure is mechanical, not prose).

## 5. Wiring discipline (default-off, absence-equivalent)

The fact block and the gating are introduced behind the existing capability/planning seams with the fact block ABSENT by default: every existing call site, test and evidence record is byte-identical until a task authors a quality contract or a capability declares its fidelity facts (discrimination-tested at the selection and evidence level, the PCR-002 pattern). Promotion of gating into any evaluated arm is an evaluation configuration, not a code path change.

## 6. Evaluation contract

The P2 program's evidence standard (work order PCS-004):

- **quality fixtures**: curated semantic-retrieval fixtures where model-backed semantic quality is measurably distinct from deterministic substitutes (e.g. paraphrase/synonym retrieval, cross-lingual nearest-neighbor, polysemy discrimination);
- **negative controls**: tasks declaring `requires-semantic-retrieval-quality` offered ONLY a deterministic substitute must FAIL CLOSED with the typed inadmissibility reason — the hard gate: **a task requiring semantic retrieval must not pass merely because a deterministic vector is produced**;
- **differentiated evidence**: the evaluation must demonstrate the evidence surface separates `semantic-embeddings` from `deterministic-vectorization` mechanically (a consumer reading only typed facts, no prose);
- **replay discipline**: the PPR-025/PPR-026 evidence lines re-run under the gated configuration with honest verdicts — no relabeling of the recorded P2-FIX-era results; synthetic-supply labels preserved;
- a threshold miss with honest attribution is a valid delivery (the truth discipline).

## 7. Non-goals / guardrails

- No new capability registry; no new capability family; no silent broadening of the existing 22-family truth by a similarly named substitute.
- No second planner, router, verification service or evidence authority.
- No quality-score invention: the quality CONTRACT is task-authored and declared; Zeck types and enforces it, it does not fabricate a semantic-quality metric.
- No silent substitution; no permissive defaults on unknown contracts; no relabeling of deterministic results as semantic evidence.
- No live-provider claims: live credentialed validation of real semantic quality remains the operator-era obligation, never backfilled from synthetic runs.

## Consequence

- `spec/architecture.md` gains §25 (ACR-009) via the Tech Lead records channel.
- The `zeck-competitiveness-p2` program is authorized: work orders PCS-001 (program enablement — the two TL-owned PCR-003 findings: console app-to-work-order PCR/PCS vocabulary + validation-lab seam re-exports), PCS-002 (semantic-fidelity typed facts — the pure plane), PCS-003 (planner quality-contract gating + disclosure — the wiring), PCS-004 (evaluation — quality fixtures, negative controls, differentiated evidence, replay of the PPR-025/026 lines), with the dependency chain PCS-002 → PCS-003 → PCS-004 and PCS-001 independent (dispatchable first).
