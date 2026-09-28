/**
 * Ports layer barrel of the compatibility integration: the outbound
 * seams (the executions trace source, the proof-environment egress
 * harness contract, the file-based evidence store, the pinned-runtime
 * driver contract and the Demo Mirror run executor).
 */

export * from "./demo-run";
export * from "./egress-harness";
export * from "./evidence-store";
export * from "./runtime";
export * from "./zeck-trace";
