/**
 * `tools` ports layer — outbound/inbound interfaces owned by this module.
 *
 * Ports are provider-neutral: no infrastructure clients, no provider SDKs.
 * Adapters (in `adapters/`) implement them (`IMPLEMENTATION.md` §2–§3).
 */

export * from "./deterministic-replacement-executor";
export * from "./execution-ledger";
export * from "./synthesis-adapter-factory";
export * from "./synthesis-sandbox";
export * from "./synthesis-store";
export * from "./tool-adapter";
export * from "./tool-admission";
export * from "./tool-capability-gate";
export * from "./tool-invocation-store";
export * from "./tool-registry";
