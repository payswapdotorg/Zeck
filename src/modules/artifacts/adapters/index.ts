/**
 * `artifacts` adapters layer — infrastructure and provider implementations for this module.

The only module layer allowed to import `src/platform/**` and provider SDKs
within the owning-adapter rules (`IMPLEMENTATION.md` §1, §3).
 */
export * from "./filesystem-artifact-store";
export * from "./in-memory-artifact-store";
export * from "./node-digest";
