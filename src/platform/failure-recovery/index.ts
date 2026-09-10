/**
 * Platform failure-recovery plane barrel (WORK-055 / E1.1 charter
 * member "Failure-aware recovery, fresh escalation and continuation" —
 * ADR-0019, ADR-0020).
 *
 * THE FAILURE-RECOVERY surface:
 *
 *  - `catalog.ts`      — the closed vocabularies (the five failure
 *                        classes, the observation-signal → class
 *                        admissibility table, the recovery strategies,
 *                        the reason codes), typed errors and bounds;
 *  - `attribution.ts`  — the unified failure attribution (typed,
 *                        evidence-bound, content-addressed; the
 *                        ADR-0020 intelligence-vs-environment
 *                        distinction, fail-closed);
 *  - `strategy.ts`     — the recovery strategy selection (the pure
 *                        deterministic decision over attribution,
 *                        economics facts and configuration; retry
 *                        discipline; re-route through the merged
 *                        economics planes' facts, read-only;
 *                        evidence-driven escalation; the fail-closed
 *                        zero-recovery outcome);
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
export * from "./strategy";
