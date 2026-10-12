/**
 * Platform failure-recovery plane barrel (WORK-055 / E1.1 charter
 * member "Failure-aware recovery, fresh escalation and continuation" —
 * ADR-0019, ADR-0020).
 *
 * THE FAILURE-RECOVERY surface:
 *
 *  - `catalog.ts`      — the closed vocabularies (the five failure
 *                        classes, the observation-signal → class
 *                        admissibility table, the recovery strategies
 *                        and moves, the re-route dimensions, the plan
 *                        modes, the reason codes), typed errors and
 *                        bounds;
 *  - `attribution.ts`  — the unified failure attribution (typed,
 *                        evidence-bound, content-addressed; the
 *                        ADR-0020 intelligence-vs-environment
 *                        distinction, fail-closed);
 *  - `strategy.ts`     — the recovery strategy selection (the pure
 *                        deterministic decision over attribution,
 *                        economics facts and configuration; retry
 *                        discipline; re-route through the merged
 *                        economics planes' facts, read-only;
 *                        evidence-driven escalation; the ACR-008 §3
 *                        move-catalog extension — provider-failover
 *                        re-route, context-repair and
 *                        verifier-escalation; the ACR-008 §4 optional
 *                        measured-evidence preference input; the
 *                        fail-closed zero-recovery outcome);
 *  - `measured.ts`     — the measured-evidence facts (ACR-008 §4:
 *                        observed per-route reliability with explicit
 *                        basis — source observation identity, window,
 *                        sample count; bounded typed validation;
 *                        content-derived auditable provenance);
 *  - `plan.ts`         — the policy-bounded recovery plans (ACR-008
 *                        §2: bounded, typed, content-addressed move
 *                        sequences composed per-step through the
 *                        EXISTING selection seam; honest typed
 *                        terminal failure; idempotent, prefix-stable
 *                        composition);
 *  - `supply-retry.ts` — the mediated supply retry/failover wiring
 *                        (ACR-008 §6; PCR-002: the traced one-
 *                        failover-retry posture as the typed decision
 *                        core — DEFAULT OFF, byte-preserved — and the
 *                        plan-composition branch behind the explicit
 *                        plan mode, recording every plan step through
 *                        the EXISTING WORK-049 seam);
 *  - `escalation.ts`   — the bounded, typed fresh-escalation packages
 *                        (attributed failure + accumulated evidence +
 *                        continuation payload, content-addressed);
 *  - `fingerprint.ts`  — environment fingerprinting (content-addressed
 *                        typed identity; total validation; typed
 *                        fail-closed drift detection);
 *  - `continuation.ts` — the continuation packages (typed,
 *                        content-addressed resume DATA the existing
 *                        execution layer consumes; idempotent apply;
 *                        fail-closed environment drift);
 *  - `decisions.ts`    — the WORK-049 decision-record ride (recovery
 *                        selections as optimization decision evidence
 *                        through the existing foundation contract).
 *
 * Platform code never imports domain modules; the WORK-049/050
 * foundation and the merged WORK-053/054 economics planes are
 * imported read-only (build ON, never fork); no store, no state
 * machine, no authorization surface lives here (the sole durable
 * surface remains the WORK-049 decision-record store).
 */

export * from "./attribution";
export * from "./catalog";
export * from "./continuation";
export * from "./decisions";
export * from "./escalation";
export * from "./fingerprint";
export * from "./measured";
export * from "./plan";
export * from "./strategy";
export * from "./supply-retry";
