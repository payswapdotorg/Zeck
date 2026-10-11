# ACR-008 — Policy-Bounded Recovery Plans and Measured-Evidence Failover

Status: APPROVED / FORWARD ARCHITECTURE EVOLUTION
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1 + ACR-006 + ACR-007
Approval date: 2026-10-11
Authorization basis: Operator instruction of 2026-10-11 — "As TL assume the responsibility of authorizing P1" — delegating the Architect's `approve-architecture-change` and `approve-work-order` rights (delegation-able per `spec/governance/architect.json`) to the Tech Lead for the competitiveness roadmap's P1 program ONLY. The non-delegable rights (change-governing-architecture, weaken-frozen-invariant, bypass-verification, bypass-required-review, bypass-merge-gate) remain with the Architect principal `@pectoraux`. The delegation is recorded additively in `spec/governance/authority-delegations.json`; the principal record is not rewritten. P2–P5 of `docs/architecture-proposals/ZECK-COMPETITIVENESS-ROADMAP.md` remain proposals requiring separate authorization.

## Decision

Evolve the platform failure-recovery plane (WORK-055 / E1.1, ADR-0019/0020 — `src/platform/failure-recovery/`) from single-decision recovery strategy selection to **policy-bounded recovery PLANS**, and admit **measured-evidence failover inputs** into the existing selection.

A recovery plan is a bounded, typed, deterministic SEQUENCE of governed recovery moves. Every move in the sequence is selected by the EXISTING `selectRecoveryStrategy` machinery under the EXISTING economics-bounded admissibility (quality floors inviolable, hard budget/latency ceilings binding, policy route restrictions applying). The plan composes decisions; it never bypasses, replaces or parallelizes authority.

The governing execution chain remains unchanged:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

ACR-008 adds no second router, no second capability registry, no second budget, no second execution state machine, no second verification service and no second evidence authority. All 20 frozen invariants of `spec/architecture-lock.md` are preserved — explicitly including invariant 13 (learning can change recommendations but cannot weaken policy or authority boundaries), which is the boundary this ACR's measured-evidence inputs must obey.

## 1. The measured gap this ACR addresses

The PPR-027 capstone study (102 synthetic-supply cells; `docs/APPLICATION-COMPATIBILITY-OBSERVED-EVIDENCE.md`) reported, under its deterministic profile and synthetic prices:

- Zeck-mediated resolution: 94.8%; un-retried direct: 67.3%; strong-optimized in-house baseline (three-attempt retry ladder, fallback, content-addressed cache, normalization shim): 98.0%.
- Failure-adjusted synthetic cost per resolved outcome: 23.77 micro-USD mediated vs 22.79 strong-optimized.
- Multi-provider mediated cells resolved 92.4%, below single-provider mediated cells at 97.2%.
- The tested Zeck policy exercised one failover retry; the strong-optimized arm exercised a three-attempt ladder.

These are study observations, not live supplier invoices. Even so they identify the deficiency: the governed failure-recovery plane — built, typed, discrimination-tested — is not composed into a bounded multi-move recovery sequence in the evaluated mediated policy, and the selection consumes declared facts only, with no measured-reliability input.

## 2. The recovery-plan artifact

`RecoveryPlan` is a typed, bounded value — data, never an engine (the continuation-package discipline):

- **Bounded sequence**: a closed list of plan steps, each carrying its move kind, its strategy-selection inputs and its selected verdict; the step-count bound rides `RecoveryConfiguration` (explicit policy input, never ambient, never self-raising), consistent with `MAX_RETRY_ATTEMPTS`/`MAX_CONTINUATION_STEPS` discipline.
- **Per-step selection is the EXISTING seam**: each step is selected by `selectRecoveryStrategy` over the then-current attribution, recovery context and economics facts. The plan composer sequences; it does not select.
- **Honest terminal failure**: a plan ends in `fail-closed` (typed reason) when no admissible move remains; plans never loop, never exceed their bound, and never retry the non-retryable (the attribution discipline: intelligence failures are never same-representation-retryable; budget exhaustion is never retryable).
- **Deterministic including tie-breaks** (invariant 5): the same inputs produce the byte-identical plan; plans are content-addressable for evidence.
- **Idempotent on re-run**: replaying the same failure context yields the same plan prefix (drift-visible, never silently divergent).
- **Evidence**: every material plan decision is recorded through the existing WORK-049 decision-record seam (`decisions.ts` discipline — append-only values, no new durable surface).

## 3. Move-catalog extension

The recovery-strategy catalog (`retry / re-route / escalate-fresh / fail`) is extended fail-closed:

1. **Provider-failover re-route dimension** — the re-route dimensions grow from `model | substrate` to `model | substrate | provider`: a capability-equal alternate SUPPLY route for the same selected representation, consumed through the supply plane's own typed selection verdict (the re-route discipline: this plane never re-implements the supply plane's economics; a no-selection outcome makes the dimension inadmissible with a typed reason, never a silent default). This is the multi-provider cell gap's governed answer.
2. **Context-repair move** — admissible only for attributed context-corruption failure classes; a bounded reconstruction directive over the governed context representation (the caller supplies the typed repair capability verdict; this plane never edits context itself).
3. **Verifier-escalation move** — admissible only for attributed semantic-quality-suspect outcomes; escalates the verification depth through the EXISTING verification authority's escalation seam (assurance profiles may increase proof depth — invariant 19 — and never reduce it).

Every new move carries an explicit-basis `CostClaim` through the shared admissibility machinery, exactly like the existing candidates. A move without economic justification is inadmissible.

## 4. Measured-evidence facts

Strategy selection gains an OPTIONAL typed input: **observed-reliability facts** — measured per-provider/per-route success, latency distribution and cooldown observations with explicit basis (source observation identity, window, sample count).

The boundary (invariant 13):

- measured facts are INPUTS to selection, never ambient, never self-raising;
- measured facts may reorder candidate preferences but can NEVER lower a quality floor, raise a budget ceiling, bypass a policy restriction or admit an otherwise-inadmissible move;
- the facts' provenance is explicit and auditable (which observations, which window);
- absence of measured facts is the default state and selects identically to today's declared-facts-only selection (byte-identical — discrimination-tested).

Learning pipelines may produce these facts; the facts' admission, the plan bounds and every authority decision remain governed policy.

## 5. Hedged execution (separately gated)

Parallel/hedged execution of a recovery step is admissible ONLY when ALL hold:

- the task is declared side-effect-safe AND idempotent (execution identity durable — invariant 10);
- the hedging budget is explicitly authorized by the budget authority (append-only settlement covers every branch — invariant 8);
- the winner is verification-checked (verification distinct from provider success — invariant 6);
- actuation/tool tasks are NEVER hedged (tools are observations — invariant 7 — and external effects create-or-converge — invariant 11).

Hedging is NOT authorized for implementation by this ACR's initial work orders. It is deferred to a separately-gated work order whose eligibility requires the replay-evaluation evidence verdict (PCR-003) showing sequential plans cannot reach the resolution threshold on side-effect-safe idempotent cells. The architecture admits it; the program gates it on evidence.

## 6. Wiring discipline (default-off, evidence-gated promotion)

The plan composer is wired into the governed execution/supply path behind `RecoveryConfiguration` with the plan mode DEFAULT OFF — the exact current retry posture is the byte-preserved default. Promotion of plan mode to any evaluated arm is an evaluation configuration, not a code path change. Production promotion requires the PCR-003 threshold verdicts PLUS the operator-era live credentialed validation (per the program's standing rule: live credentialed batteries are never backfilled from synthetic runs).

## 7. Evaluation contract

The P1 program's evidence standard (work orders PCR-003):

- three-arm replay comparison at the SAME fresh revision (exact-revision rule): un-retried direct, strong-optimized, mediated-with-plan;
- targeted multi-provider cells (the 92.4% gap territory);
- outcome thresholds: equal-or-better resolution than the strong-optimized arm in targeted multi-provider cells; improved-or-documented failure-adjusted cost; ZERO policy/budget violations (hard gate); explicit latency-tail (p95) tradeoff accounting — no silent tail regressions; reproducible per-attempt evidence;
- honest labels preserved: synthetic-supply/synthetic-cost boundaries carried on every number; a threshold miss with attribution is a valid delivery (the truth discipline); no market or production claims.

## 8. Non-goals / guardrails

- No second router, capability registry, budget, execution state machine, verification service or evidence authority.
- No change to the frozen public contract or the v1.0 authority chain beyond this plane's internal composition.
- No generic-failure retry loops; no retry of the non-retryable; no budget-exhaustion retry.
- No silent promotion of plan mode; no ambient measured facts; no self-modifying policy.
- No relabeling of synthetic results as live evidence.

## Consequence

- `spec/architecture.md` gains §24 (ACR-008) via the Tech Lead records channel.
- The `zeck-competitiveness-p1` program is authorized: work orders PCR-001 (recovery-plan type system + move-catalog extension), PCR-002 (measured-evidence facts + plan composition + default-off wiring), PCR-003 (three-arm replay evaluation with explicit outcome thresholds), with PCR-004 (hedged execution mode) eligible ONLY on PCR-003's evidence verdict.
- The failure-recovery plane's existing tests remain green; every extension adds discrimination coverage (determinism, tie-breaks, measured-facts absence equivalence, fail-closed unknowns).
- P2–P5 of the competitiveness roadmap remain PROPOSALS requiring separate authorization.
