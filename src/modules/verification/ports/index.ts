/**
 * `verification` ports layer — outbound/inbound interfaces owned by this module.
 *
 * Ports are provider-neutral: no infrastructure clients, no provider SDKs.
 * Adapters (in `adapters/`) implement them (`IMPLEMENTATION.md` §2–§3).
 */

export * from "./model-judge";
export * from "./replanning-boundary";
export * from "./target-resolvers";
export * from "./verification-admission";
export * from "./verification-ledger";
export * from "./verification-store";
