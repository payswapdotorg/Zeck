/**
 * Domain layer barrel of the compatibility integration (ACR-006).
 * Pure types + validation + the strict admission machine — no I/O, no
 * environment, no runtime modules (the dependency engine's
 * domain-runtime-import rule).
 */

export * from "./evidence";
export * from "./execution-graph";
export * from "./execution-surfaces";
export * from "./no-bypass";
export * from "./revisions";
export * from "./status";
