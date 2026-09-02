/**
 * `deployments` ports layer — outbound/inbound interfaces owned by
 * this module (WORK-023).
 *
 * Ports are provider-neutral: no infrastructure clients, no provider
 * SDKs. Adapters (in `adapters/`) implement them
 * (`IMPLEMENTATION.md` §2–§3).
 */

export * from "./agent-inventory";
export * from "./deployment-store";
export * from "./environment-resolver";
export * from "./modality-adapter";
export * from "./realtime-admission";
export * from "./realtime-execution-ledger";
export * from "./realtime-rail";
export * from "./realtime-store";
export * from "./realtime-subtask-router";
export * from "./realtime-turn-responder";
