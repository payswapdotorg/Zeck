/**
 * `capabilities` adapters layer — infrastructure and provider implementations for this module.

The only module layer allowed to import `src/platform/**` and provider SDKs
within the owning-adapter rules (`IMPLEMENTATION.md` §1, §3).
 */
export { createInMemoryCatalogStore } from "./in-memory-catalog-store";
export { SEED_CAPABILITY_FACTS } from "./seed-catalog";
