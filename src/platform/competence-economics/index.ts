/**
 * The competence-economics plane barrel (platform
 * competence-economics plane; WORK-056 / E1.1 charter member
 * "Competence-aware Optimization and Progressive Deterministicization").
 *
 * The plane's nine modules:
 *  - `catalog` — the closed vocabularies, bounds and typed error;
 *  - `record` — typed, content-addressed competence records
 *    (trajectory digest, applicability bounds, expected-outcome
 *    evidence, cost — selectable as decision evidence through the
 *    existing seams, never self-asserting);
 *  - `retrieval` — progressive, deterministic, bounded retrieval
 *    ranked by applicability match, evidence quality and economics;
 *  - `mining` — successful-trajectory mining (observation, never
 *    authority — candidates only);
 *  - `equivalence` — deterministic replacement candidates with the
 *    full differential/property/replay equivalence evidence suite;
 *  - `promotion` — the gated shadow → canary → deterministic
 *    promotion path (one stage at a time, policy/budget bounded);
 *  - `rollback` — bounded, typed, recorded rollback to the prior
 *    representation (idempotent apply);
 *  - `decisions` — the WORK-049 decision-record ride (promotion and
 *    rollback decisions as append-only evidence through the
 *    EXISTING store).
 *
 * COMPETENCE IS EVIDENCE, NEVER AUTHORITY: nothing in this barrel
 * exposes admission/authorization vocabulary — authorization,
 * policy, budgets and verification never consult competence records
 * (boundary-proven in the architecture battery).
 */

export * from "./catalog";
export * from "./decisions";
export * from "./equivalence";
export * from "./mining";
export * from "./promotion";
export * from "./record";
export * from "./retrieval";
export * from "./rollback";
