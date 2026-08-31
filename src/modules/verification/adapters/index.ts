/**
 * `verification` adapters layer — infrastructure and provider implementations for this module.
 *
 * The only module layer allowed to import `src/platform/**` and provider SDKs
 * within the owning-adapter rules (`IMPLEMENTATION.md` §1, §3).
 */

export * from "./deterministic-evaluators";
export * from "./execution-ledger";
export * from "./in-memory-verification-store";
export * from "./model-judge-evaluator";
export * from "./policy-verification-admission";
export * from "./sql-verification-store";
export * from "./target-resolvers";
