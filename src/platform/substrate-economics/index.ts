/**
 * Platform substrate-economics plane barrel (WORK-054 / E1.1 charter
 * wave member 4 — ADR-0019, ADR-0020).
 *
 * The ECONOMIC SUBSTRATE SELECTION AND RUNTIME ADAPTER surface:
 *
 *  - `catalog.ts`      — the closed vocabularies, typed errors and
 *                        bounds of the plane;
 *  - `facts.ts`        — the neutral, closed, explicit-basis substrate
 *                        descriptors (quality/readiness/latency/
 *                        reliability/cost with warm/cold/snapshot
 *                        modes);
 *  - `lifecycle.ts`    — readiness/startup lifecycle measurement
 *                        (observations, freshness classification, the
 *                        bounded startup computations);
 *  - `selection.ts`    — the least-expense-sufficient substrate
 *                        selection (pure, deterministic, recorded);
 *  - `accounting.ts`   — the WORK-049 decision-record ride (substrate
 *                        selections as optimization decision evidence
 *                        through the existing foundation contract);
 *  - `adapters/`       — the runtime provider adapters (E2B, Daytona,
 *                        Modal, self-hosted) as neutral mechanisms
 *                        behind the existing compute/sandbox seams.
 *
 * Platform code never imports domain modules (`platform-isolation`);
 * the foundation (WORK-049/050) is imported, never edited; provider
 * specifics live behind adapter seams and never cross them.
 */
export * from "./catalog";
export * from "./facts";
export * from "./lifecycle";
export * from "./selection";
