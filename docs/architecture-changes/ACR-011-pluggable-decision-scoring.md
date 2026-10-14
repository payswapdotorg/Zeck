# ACR-011 — Pluggable Decision Scoring: Typed Advisory Scores, Absent-Scorer Equivalence, Measured-Lift Promotion

Status: APPROVED / FORWARD ARCHITECTURE EVOLUTION
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1 + ACR-006 + ACR-007 + ACR-008 + ACR-009 + ACR-010
Approval date: 2026-10-14
Authorization basis: Operator standing directive of 2026-10-12 — "continuous resident watch from here on: monitor → harvest → review → approve/require-changes → dispatch next, until the roadmap is complete. No early returns. Use the github repo as guide for roadmap" — delegating the Architect's `approve-architecture-change` and `approve-work-order` rights (delegation-able per `spec/governance/architect.json`) to the Tech Lead for the competitiveness roadmap's remaining phases. The non-delegable rights (change-governing-architecture, weaken-frozen-invariant, bypass-verification, bypass-required-review, bypass-merge-gate) remain with the Architect principal `@pectoraux`. The delegation is recorded additively in `spec/governance/authority-delegations.json` (DEL-2026-10-14-P4); the principal record is not rewritten. This record is the separate per-phase authorization the P3 close-out required for P4; P5 of `docs/architecture-proposals/ZECK-COMPETITIVENESS-ROADMAP.md` remains a proposal requiring its own.

## Decision

Extend the existing decision model with a **typed advisory score plane** — `DecisionScoreFacts`, a closed, optional, prediction-only fact block carrying what an interchangeable scorer (a Jev/Laya/CLM-style external scorer or a Zeck-trained scorer) estimates about **admissible execution candidates** (candidate success, failure class, verifier value, route suitability) — and a **single pluggable scorer seam** that is configuration-driven, default-off and absence-equivalent. The governing execution chain is unchanged:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

A scorer is NEVER the router or authority. Its output is a prediction, not proof. The Execution Compiler continues to apply policy, capability, budget, latency and verification constraints to every candidate regardless of scores; a score may at most refine the ORDERING among candidates the effective policy already admits — the LRN-002 learned-policy consultation discipline, generalized from internal learning publications to interchangeable scorers. All 20 frozen invariants of `spec/architecture-lock.md` are preserved — explicitly §2.11 (learning improves decisions; it never silently rewrites authority) and invariant 13 (no scoring may weaken policy, budget or authority boundaries).

## 1. The gap this ACR addresses

The competitiveness roadmap §P4: the Execution Compiler ranks admissible candidates deterministically today (the cheap-first cascade with the deterministic-first preference untouchable). The repository already owns the internal learning loop's read seam — `LearnedPolicyConsultation` (WORK-020/LRN-002): a published learned policy refines ordering among admissible candidates, canary publications record divergence evidence without changing live selection, and the record class is pinned non-authoritative. What the model does NOT carry:

- a **typed contract for interchangeable scorers**: an external Jev/Laya/CLM-style scorer or a Zeck-trained scorer has no closed vocabulary for what it may claim (which score kinds exist), with what provenance (scorer identity, version, calibration basis) and what confidence discipline (declared bounds, honest unknowns);
- a **pluggable seam**: no configuration-driven adapter boundary where such a scorer can be authored without touching the compiler, absent by default and byte-identical-today when absent;
- a **promotion gate for scorers**: no evaluation contract requiring measured lift NET of the scorer's own cost and latency — calibration, top-k decision quality, worst-case regressions and policy-constraint preservation against the deterministic/current baseline — before any production enablement.

The gap, precisely: **the decision model lacks a typed, prediction-only score representation and a default-off pluggable scorer seam, governed by a net-lift promotion gate that forbids authority transfer — so an optional System One capability can be evaluated honestly without ever becoming the router.**

## 2. The decision-score fact system (typed, closed, prediction-only)

`DecisionScoreFacts` — a typed, closed, optional fact block attached to the planning decision record's candidate set (the pure plane):

- **score kinds**: the closed vocabulary of what a scorer may estimate — `candidate-success` (a probability, [0,1]), `failure-class-distribution` (a mass over the ACR-010 per-leg failure taxonomy, summing to ≤ 1 with the honest remainder), `verifier-value` (a non-negative bounded estimate of verification value for the candidate), `route-suitability` (a non-negative bounded ranking score with a declared scale);
- **scorer kinds**: the closed vocabulary of who scored — `deterministic-baseline` | `external-scorer` | `zeck-trained` — with the scorer's identity, version and configuration digest;
- **confidence bounds**: every estimate carries declared bounds (or the honest `unbounded-unknown`); a scorer that cannot bound its confidence states so — never a fabricated precision;
- **explicit provenance**: every fact names its scorer, scorer version, the calibration basis digest, the candidate it scores and the scoring context digest — the explicit-basis discipline applied to predictions;
- **prediction truth**: a score is a PREDICTION, never a measurement — `DecisionScoreFacts` are a separate plane from outcome evidence (`OutcomeLatencyFacts` and kin measure real executions; scores estimate futures). The two planes never merge, never substitute for one another, and never share a digest namespace.

The laws (each testable):

- **Closed vocabulary**: every field is a closed enum or a typed bounded value; unknown kinds/values fail closed at the boundary, never default.
- **No authority**: the fact block carries no decision rights; the compiler consumes it as advisory input only (§3), and the advisory-only consumption law is architecture-pinned.
- **Absence equivalence**: the block is OPTIONAL — its absence records byte-identically to today's behavior at every existing call site (the PCR-002/ACR-009/ACR-010 discipline, discrimination-tested).
- **Determinism + content addressing**: canonical tagged-tuple JSON with an injected digest; no env/clock/randomness in the fact derivation (the PCL-001 pattern).
- **Fail-closed boundary checking**: both-sides pre-validation, mismatches typed naming both sides; a malformed score never enters a durable decision record.

## 3. The scorer seam (pluggable, default-off, fail-closed)

A single seam — the candidate-selection path reads scores through ONE adapter boundary, mirroring the tail-pacing seam discipline (ACR-010 §3–§4):

- **absent configuration ⇒ the inert resolver**: every existing call site, test and evidence record is byte-identical until an evaluation arms a scorer (absence verdicts byte-identical-today, proven by the sha256-pinned baseline discipline);
- **present-but-malformed ⇒ typed `ScorerConfigurationError`** at construction — never an ambient fallback to partial scoring;
- **the adapter contract**: typed input (the admissible candidate set with its read-only context facts, exactly as the configuration declares), typed output (`DecisionScoreFacts`), bounded invocation (declared timeout; scorer latency and cost measured as first-class facts feeding §4);
- **ordering-only influence**: scores enter AFTER the hard policy admissibility filter and may only refine ordering among already-admissible candidates — the LRN-002 discipline verbatim (a score can never widen, bypass or override a prohibition; the deterministic-first preference stays untouchable);
- **declarative configuration**: the scorer configuration is versioned data — scorer kind, endpoint/injection binding, score kinds authorized, bounds — never ambient environment flags (the ACR-010 §6 discipline).

## 4. Evaluation contract (shadow/offline first; the program's evidence standard)

Following the roadmap's decision sequence — "evaluate optional learned/System One scoring in shadow/offline mode" before any production claim:

- **calibration**: predicted vs observed, per score kind and per candidate class, scored against real outcome evidence — reported with honest binning, never a single blended number;
- **top-k decision quality**: whether the scored ordering improves the compiler's actual selection outcomes (task success, resolution, cost), not merely its stated confidence;
- **worst-case regressions**: the tail discipline — no latency-class or cost-class regression beyond the declared delta (the ACR-010 percentile honesty applied to scorer-influenced selections);
- **policy-constraint preservation**: proven, per configuration, that scored selections never violate policy/budget/verification constraints (fail-closed at the seam; the proof is a pinned architecture test, not a claim);
- **scorer cost truth**: the scorer's own invocation cost and latency are measured and NETTED against lift — lift is only lift net of scorer cost (the roadmap's requirement verbatim);
- **the promotion gate**: a scorer configuration is promoted only on (measured net lift on the primary decision-quality metric) AND (no calibration regression beyond the declared delta) AND (no worst-case regression beyond the declared delta) AND (policy-constraint preservation proven) — claims alone promote NOTHING; canary/shadow evidence first, then staged production evaluation under the same gate (the LRN-002 canary→promoted modes);
- **honest disclosure**: offline/synthetic evaluation is labeled as such; no production preference claims from offline runs.

## 5. Non-goals / guardrails

- NO second router, planner, verification service, evidence authority or budget authority: a System One model is never the router or authority (§2.11; the roadmap's guardrail verbatim).
- NO score-based bypass of policy, budget or verification constraints — fail-closed at the seam; an admissibility verdict is never revisited by a score.
- NO ambient scorer flags: the configuration is declared and versioned, never environment-scattered.
- NO production enablement without the §4 promotion gate; no relabeling of offline lift as production lift.
- NO merger of prediction facts with measurement facts: `DecisionScoreFacts` stay a separate plane from outcome evidence; conflation is an automatic void condition.
- NO displacement of the deterministic-first preference or the cheap-first cascade's guarantees (ADR-0007 discipline carried forward).

## Consequence

The decision model gains the typed advisory-score representation and the pluggable seam the roadmap's P4 requires; the successor evaluation (work order PCD-003) measures net lift under the promotion gate with calibration and worst-case honesty. The program is registered as zeck-competitiveness-p4 with work orders PCD-001 (the typed decision-score plane), PCD-002 (the scorer seam + declarative configuration), PCD-003 (the shadow/offline evaluation with the promotion gate), dependency chain PCD-001 → PCD-002 → PCD-003.
