# ACR-010 — Latency-Tail and Recovery Economics: Per-Failure-Class Outcome Latency, Tail Mechanics, Honest Promotion Gates

Status: APPROVED / FORWARD ARCHITECTURE EVOLUTION
Architecture baseline: v1.0 + D1.0 + E1.0 + E1.1 + ACR-006 + ACR-007 + ACR-008 + ACR-009
Approval date: 2026-10-13
Authorization basis: Operator standing directive of 2026-10-12 — "continuous resident watch from here on: monitor → harvest → review → approve/require-changes → dispatch next, until the roadmap is complete. No early returns. Use the github repo as guide for roadmap" — delegating the Architect's `approve-architecture-change` and `approve-work-order` rights (delegation-able per `spec/governance/architect.json`) to the Tech Lead for the competitiveness roadmap's remaining phases. The non-delegable rights (change-governing-architecture, weaken-frozen-invariant, bypass-verification, bypass-required-review, bypass-merge-gate) remain with the Architect principal `@pectoraux`. The delegation is recorded additively in `spec/governance/authority-delegations.json` (DEL-2026-10-13-P3); the principal record is not rewritten. P4–P5 of `docs/architecture-proposals/ZECK-COMPETITIVENESS-ROADMAP.md` remain proposals requiring their own per-phase authorization records under the same standing directive.

## Decision

Extend the existing execution/evidence model with **typed outcome-latency facts** — per-failure-class, per-route latency and cost measurements attached to outcome records — and retune the **tail mechanics** (retry delays, provider cooldowns, event-vs-polling progress delivery) so that a successful fallback does not dominate tail latency, with **explicit timeout and terminal-failure behavior preserved**. Promotion of any tuned configuration is gated on the honest evaluation contract: per-failure-class p50/p95/p99, total cost including duplicate attempts, resolution rate and verification cost — never median latency alone.

The governing execution chain remains unchanged:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

ACR-010 adds no new router, no second planner, no new verification service and no new evidence authority. The latency/cost facts are typed evidence about executions that already happen — data, never an engine (the continuation-package discipline). All 20 frozen invariants of `spec/architecture-lock.md` are preserved — explicitly including the verification and evidence-truth disciplines (a latency number is a measurement of a real execution, never a projection or a promise) and invariant 13 (no tuning may weaken policy, budget or authority boundaries).

## 1. The measured gap this ACR addresses

The application-compatibility capstone (PPR-027, 102-cell longitudinal study) reported median latencies of 18.5 ms mediated, 21.0 ms direct and 16.0 ms strong-optimized — but p95 median-of-cell values of 135.5, 97.5 and 143.0 ms respectively: **a mixed result — better median than direct, slower tail than direct**, with retries and compressed polling visible in the profile. The current model reports aggregate model latency; it does not carry:

- latency **by failure class** (which failure modes dominate the tail — provider 5xx, timeout, throttle, connection reset, verification retry);
- latency **by route** (which provider/fallback legs contribute what to a tail outcome);
- the **cost of duplicates** (total spend including duplicate attempts a fallback consumed);
- **verification cost** as a latency/cost component;
- a **promotion gate** that forbids tail-worsening changes from landing on median improvement alone.

The gap, precisely: **the execution/evidence model lacks a typed per-failure-class, per-route outcome-latency and cost representation, and the tail mechanics (retry pacing, cooldowns, polling pressure) are not tunable under an evaluation contract that can prove a tail improvement without hiding failures.**

## 2. The outcome-latency fact system (typed, closed)

`OutcomeLatencyFacts` — a typed, closed, optional fact block on the execution outcome record:

- **outcome class**: `succeeded-first-attempt` | `succeeded-after-retry` | `succeeded-on-fallback` | `failed-terminal` — the closed outcome classification this ACR measures tails over;
- **failure classes encountered**: the closed per-leg failure taxonomy (provider-5xx, provider-timeout, provider-throttle, connection-error, verification-retry, budget-exhausted, policy-denied) — each leg names its class; unknown classes fail closed at the boundary, never default;
- **per-leg latency**: the measured wall-clock of each route leg (first byte, completion), typed and unit-bound (milliseconds, non-negative, bounded);
- **attempt census**: the count of attempts by class (original, retry, fallback, verification) — the duplicate-attempt truth;
- **queue/progress mechanics**: the progress-delivery mode actually used (`event-stream` | `polled`), the polling interval actually applied, and the cooldown state at dispatch — the mechanics that produced the measurement;
- **cost**: the total cost including duplicate attempts (the existing `CostClaim` discipline — explicit basis, never a projection), with verification cost carried as its own line;
- **resolution and verification outcome**: whether the outcome resolved, and what verification proved (the existing verification record, referenced not duplicated).

The laws (each testable):

- **Closed vocabulary**: every field is a closed enum or a typed bounded value; unknown values fail closed at the boundary, never default.
- **Measurement truth**: every latency/cost number is a real measurement of a real execution at a recorded revision — never simulated, projected or backfilled; a value that cannot be measured renders as an honest NOT RUN with an owner, never a placeholder.
- **Absence equivalence**: the fact block is OPTIONAL — its absence records byte-identically to today's behavior at every existing call site (the PCR-002/ACR-009 discipline, discrimination-tested).
- **No failure hiding**: a terminal failure is recorded as a terminal failure — a tuned configuration may never improve percentiles by dropping, merging or reclassifying failed or unfinished executions; the outcome census reconciles exactly (attempts = originals + retries + fallbacks + verifications).
- **Explicit provenance**: every fact carries its basis (which execution, which route, which revision, which clock discipline) — the explicit-basis `CostClaim` discipline applied to latency facts.

## 3. Tail mechanics (tunable, transport-aware, fail-closed)

The existing execution pipeline's pacing parameters — retry delays and backoff shape, provider cooldown entry/exit, status-polling interval and compression — become **declaratively configured, evaluated quantities** (no new engine; the existing retry/cooldown machinery reads its parameters from the typed configuration):

- **retry pacing**: bounded, jittered backoff with a declared ceiling; the shape and bounds are configuration data, discriminated by evaluation — never ambient;
- **cooldown discipline**: provider cooldowns that account for the failure class (a throttle cools differently than a 5xx) with explicit re-entry;
- **progress delivery**: where the transport supports event/stream-driven progress, tight status polling is replaced by subscription (the transport's own capability facts decide — the ACR-009 pattern of typed capability truth driving selection); polled stays the honest fallback where events are unsupported;
- **timeout and terminal-failure preservation**: explicit timeouts and terminal-failure behavior are NOT tunable away — a configuration that would mask a terminal failure as success or extend a declared timeout beyond its contract is rejected typed at the configuration boundary (fail-closed, invariant-preserving).

## 4. Wiring discipline (default-off, absence-equivalent)

The fact block and the declarative configuration are introduced behind the existing execution/verification seams with the fact block ABSENT by default and the configuration exactly reproducing today's pacing: every existing call site, test and evidence record is byte-identical until an evaluation arms the tuned configuration (the PCR-002 pattern). Promotion of any tuned configuration into an evaluated arm is an evaluation configuration, not a code path change.

## 5. Evaluation contract (the program's evidence standard)

- **per-failure-class percentiles**: p50/p95/p99 for each failure class and route, from the typed facts — never aggregate-only;
- **cost truth**: total cost including duplicate attempts, and verification cost, per configuration;
- **resolution honesty**: resolution rate and verification outcomes per configuration — a tail improvement that costs resolution is a MISS, not a win;
- **the promotion gate**: a configuration is promoted only on (tail percentile improvement) AND (no resolution regression) AND (no cost explosion beyond a declared budget delta) AND (explicit timeout/terminal-failure behavior preserved) — median improvement alone promotes NOTHING (the roadmap's success gate, verbatim);
- **replay discipline**: the PPR-027 capstone's latency cells re-run under the typed-facts configuration with honest per-cell verdicts — no relabeling of the recorded capstone-era results; synthetic-supply labels preserved;
- a threshold miss with honest attribution is a valid delivery (the truth discipline).

## 6. Non-goals / guardrails

- NO hedged requests: ACR-008 §5 admits hedging only on evidence that sequential plans cannot reach the resolution threshold — PCR-004's void record shows that evidence does not exist; hedging remains out of scope for this program (revisit only with new evidence, per its own fired-condition protocol).
- NO new router, planner, verification service, evidence authority or durable surface beyond the typed facts and the declarative configuration.
- NO SLA or production-latency claims from synthetic evaluation runs: live credentialed latency validation under real load remains the operator-era obligation, never backfilled.
- NO percentile improvement by hiding failures: the outcome census must reconcile exactly; dropped or reclassified failures are an automatic void.
- NO ambient tuning: the pacing configuration is declared and versioned, never environment-scattered flags.

## Consequence

The execution/evidence model gains the typed representation the roadmap's P3 requires; the tail mechanics become evaluable under an honest promotion gate; the successor evaluation (work order PCL-003) replays the capstone's latency lines under the gated configuration with per-failure-class honesty. The program is registered as zeck-competitiveness-p3 with work orders PCL-001 (the typed outcome-latency evidence plane), PCL-002 (the tail mechanics + declarative configuration), PCL-003 (the evaluation), dependency chain PCL-001 → PCL-002 → PCL-003.
